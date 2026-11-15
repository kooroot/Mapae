/**
 * apps/ops-monitor — the one place that decides and sends Mapae alerts.
 *
 *   scheduled (every 5 min)  public probes + collector heartbeats → alert state → Telegram
 *   POST /ingest             the Mac mini collector's hourly invariants and daily snapshot;
 *                            a daily one also sends the daily report, and the weekly once its Sunday is on file
 *   POST /telegram           bot webhook: /status, /report, /help from the allowed chat
 *
 * It runs outside the Mac mini on purpose: a dead host cannot report its own death, so
 * the Worker infers it from probes failing and heartbeats going quiet. And it is the only
 * holder of the bot token, so de-duplication and heartbeat judgement happen in one place.
 */
import {alertMessage, heartbeatObservations, transition, type AlertRow, type Observation} from "./alerts";
import {ConfigError, parseConfig, type Config, type Env} from "./config";
import {MAX_INGEST_BYTES, parseDailySnapshot, parseIngest, type DailySnapshot} from "@mapae/shared/ops-ingest";
import {runProbes, type Fetcher, type ProbeCheck} from "./probes";
import {secretEquals, bearerMatches} from "./secret";
import {addDays, dailyReport, escapeHtml, weekEnding, weeklyReport} from "./report";
import {latestSnapshot, loadAlerts, loadHeartbeats, recordHeartbeat, recordWeeklyReport, saveAlerts, saveSnapshot, snapshotOn, weeklyReportSent, type D1Like, type StoredSnapshot} from "./store";
import {parseCommand, sendTelegram, type BotCommand} from "./telegram";

export interface Deps {
    fetch: Fetcher;
    now: () => number;
}

interface WaitUntil {
    waitUntil(promise: Promise<unknown>): void;
}

const MAX_WEBHOOK_BYTES = 64 * 1024;
/** Collector items share the alert table with probes, so they get their own namespace. */
export const HOURLY_PREFIX = "hourly:";

const notifier = (config: Config, deps: Deps) => async (text: string, html = false): Promise<boolean> => {
    const sent = await sendTelegram(deps.fetch, config.botToken, config.chatId, text, html);
    if (!sent) console.error("telegram_send_failed");
    return sent;
};

/**
 * Runs observations through the state machine and sends at most one message. When the
 * send fails, rows that carried a notification are not persisted, so the next tick sees
 * the same transition and tries again instead of believing the operator was told.
 */
export async function applyObservations(db: D1Like, observations: Observation[], now: number, notify: (text: string) => Promise<boolean>): Promise<void> {
    const previous = await loadAlerts(db);
    const transitions = observations.map(o => transition(previous.get(o.name) ?? null, o, now));
    const message = alertMessage(transitions, previous, now);
    const delivered = message === null || await notify(message);
    await saveAlerts(db, transitions.filter(t => t.row !== previous.get(t.row.name) && (delivered || t.event === null)).map(t => t.row));
}

const probeObservation = (check: ProbeCheck): Observation =>
    ({name: check.name, ok: check.ok, detail: check.ok ? undefined : check.status ? `HTTP ${check.status}` : "unreachable or timed out"});

export async function runScheduled(env: Env, deps: Deps): Promise<void> {
    const config = parseConfig(env);
    const checks = await runProbes(deps.fetch, config.metricsKeys);
    const now = deps.now();
    const heartbeats = await loadHeartbeats(env.DB);
    await applyObservations(env.DB, [...checks.map(probeObservation), ...heartbeatObservations(heartbeats, now)], now, notifier(config, deps));
}

async function readBody(request: Request, limit: number): Promise<unknown> {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (!Number.isFinite(declared) || declared > limit) return undefined;
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > limit) return undefined;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return undefined;
    }
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, {status});

async function ingest(request: Request, env: Env, config: Config, deps: Deps, ctx: WaitUntil): Promise<Response> {
    if (!await bearerMatches(request.headers.get("Authorization"), config.ingestToken)) return json(401, {error: "unauthorized"});
    const payload = parseIngest(await readBody(request, MAX_INGEST_BYTES));
    if (!payload) return json(400, {error: "invalid_payload"});
    const now = deps.now();
    if (payload.kind === "daily") {
        await saveSnapshot(env.DB, payload.day, JSON.stringify(payload.snapshot), now);
        // Reports run after the response. Two Telegram calls at 10 s each outlast the
        // collector's 15 s abort, which would turn a stored snapshot into a failed run —
        // and, if the cancelled request took the heartbeat write with it, a false
        // collector-heartbeat alert a day later. The snapshot is what the ingest promises.
        ctx.waitUntil(sendReports(env.DB, payload.snapshot, now, notifier(config, deps)).catch(() => console.error("daily_report_failed")));
    } else {
        const reported = new Set(payload.items.map(i => `${HOURLY_PREFIX}${i.name}`));
        // An item the collector stopped sending would otherwise remind every hour forever.
        const dropped = [...(await loadAlerts(env.DB)).values()]
            .filter(row => row.name.startsWith(HOURLY_PREFIX) && !reported.has(row.name) && !row.ok)
            .map((row): Observation => ({name: row.name, ok: true, detail: "no longer reported"}));
        const observations = payload.items.map(i => ({...i, name: `${HOURLY_PREFIX}${i.name}`}));
        await applyObservations(env.DB, [...observations, ...dropped], now, notifier(config, deps));
    }
    await recordHeartbeat(env.DB, payload.kind, now);
    return json(200, {ok: true});
}

function age(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export async function statusText(env: Env, config: Config, deps: Deps): Promise<string> {
    const checks = await runProbes(deps.fetch, config.metricsKeys);
    const now = deps.now();
    const [alerts, heartbeats] = await Promise.all([loadAlerts(env.DB), loadHeartbeats(env.DB)]);
    const failing = [...alerts.values()].filter((row: AlertRow) => !row.ok && !checks.some(c => c.name === row.name));
    const lines = [
        `${checks.every(c => c.ok) && !failing.length ? "ALL OK" : "DEGRADED"} — ${new Date(now).toISOString()}`,
        ...checks.map(c => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : ` (${probeObservation(c).detail})`} ${c.ms}ms`),
        ...failing.map(row => `FAIL ${row.name} since ${age(now - row.since)}`),
        `collector: hourly ${heartbeats.has("hourly") ? age(now - heartbeats.get("hourly")!) : "never"}, daily ${heartbeats.has("daily") ? age(now - heartbeats.get("daily")!) : "never"}`,
    ];
    return lines.join("\n");
}

/** A stored row re-parsed on the way out: one written under an older shape is skipped, not trusted. */
function readSnapshot(stored: StoredSnapshot | null): DailySnapshot | null {
    if (!stored) return null;
    try {
        return parseDailySnapshot(JSON.parse(stored.json));
    } catch {
        return null;
    }
}

/**
 * The daily report on every daily ingest (a re-run is a correction worth seeing), and the
 * weekly one for the latest week whose Sunday snapshot is on file, until Telegram accepts
 * it once. Keying the week to its Sunday rather than to the day of the ingest means a
 * refused send, or a Monday run that only succeeded after midnight, goes out with the next
 * daily ingest instead of being lost. Neither failing to send fails the ingest: the
 * snapshot is already stored and `/report` can show it.
 */
export async function sendReports(db: D1Like, snapshot: DailySnapshot, now: number, notify: (text: string, html: boolean) => Promise<boolean>): Promise<void> {
    await notify(dailyReport(snapshot, readSnapshot(await snapshotOn(db, addDays(snapshot.day, -1)))), true);
    const sunday = weekEnding(snapshot.day);
    if (await weeklyReportSent(db, sunday)) return;
    const week = readSnapshot(await snapshotOn(db, sunday));
    if (!week) return;
    if (await notify(weeklyReport(week, readSnapshot(await snapshotOn(db, addDays(sunday, -7)))), true)) await recordWeeklyReport(db, sunday, now);
}

export async function reportText(env: Env): Promise<string> {
    const stored = await latestSnapshot(env.DB);
    if (!stored) return "No daily snapshot has been ingested yet.";
    const snapshot = readSnapshot(stored);
    if (!snapshot) return escapeHtml(`The latest snapshot (${stored.day}) is in a shape this Worker cannot read.`);
    return dailyReport(snapshot, readSnapshot(await snapshotOn(env.DB, addDays(snapshot.day, -1))));
}

const HELP = "/status — run the probes now and list failing checks\n/report — headline metrics from the latest daily snapshot\n/help — this message";

async function answer(command: BotCommand, env: Env, config: Config, deps: Deps): Promise<void> {
    const send = notifier(config, deps);
    if (command === "report") await send(await reportText(env), true);
    else await send(command === "status" ? await statusText(env, config, deps) : HELP);
}

async function telegramWebhook(request: Request, env: Env, config: Config, deps: Deps, ctx: WaitUntil): Promise<Response> {
    if (!await secretEquals(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", config.webhookSecret)) return json(401, {error: "unauthorized"});
    const command = parseCommand(await readBody(request, MAX_WEBHOOK_BYTES), config.chatId);
    // Telegram retries any non-2xx, so even an ignored update is acknowledged. The answer
    // runs after the response because /status takes as long as the slowest probe.
    if (command) ctx.waitUntil(answer(command, env, config, deps).catch(() => console.error("telegram_command_failed")));
    return json(200, {ok: true});
}

export async function handleRequest(request: Request, env: Env, deps: Deps, ctx: WaitUntil): Promise<Response> {
    const {pathname} = new URL(request.url);
    if (pathname !== "/ingest" && pathname !== "/telegram") return json(404, {error: "not_found"});
    if (request.method !== "POST") return json(405, {error: "method_not_allowed"});
    let config: Config;
    try {
        config = parseConfig(env);
    } catch (error) {
        console.error(error instanceof ConfigError ? `config_invalid: ${error.variable}` : "config_failed");
        return json(503, {error: "misconfigured"});
    }
    return pathname === "/ingest" ? ingest(request, env, config, deps, ctx) : telegramWebhook(request, env, config, deps, ctx);
}

// Bound: workerd rejects a detached `fetch` with "Illegal invocation".
const live: Deps = {fetch: globalThis.fetch.bind(globalThis), now: () => Date.now()};

export default {
    fetch: (request: Request, env: Env, ctx: WaitUntil) => handleRequest(request, env, live, ctx),
    scheduled: (_controller: unknown, env: Env, ctx: WaitUntil) => {
        // Fixed strings only: a D1 or fetch error can carry a URL, and the bot token lives in one.
        ctx.waitUntil(runScheduled(env, live).catch(error => console.error(error instanceof ConfigError ? `config_invalid: ${error.variable}` : "scheduled_run_failed")));
    },
};
