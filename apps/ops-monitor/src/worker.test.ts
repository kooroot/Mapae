import {Database} from "bun:sqlite";
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import type {Env} from "./config";
import type {Fetcher} from "./probes";
import type {D1Like, D1Statement} from "./store";
import {snapshotFixture} from "./snapshot-fixture";
import {handleRequest, runScheduled, type Deps} from "./worker";

const TOKEN = "123456:" + "A".repeat(35);
const SECRETS = {TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_WEBHOOK_SECRET: "w".repeat(32), INGEST_TOKEN: "i".repeat(32), SELLER_METRICS_TOKEN: "s".repeat(16), FACILITATOR_METRICS_TOKEN: "f".repeat(16)};
const H = 60 * 60_000;

/** The real schema on bun:sqlite behind the five D1 calls the Worker makes. */
function fakeD1(): {db: Database; d1: D1Like} {
    const db = new Database(":memory:");
    db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => ({
        bind: (...next) => statement(sql, next),
        first: async () => db.query(sql).get(...values),
        all: async () => ({results: db.query(sql).all(...values)}),
        run: async () => db.query(sql).run(...values),
    });
    return {db, d1: {prepare: sql => statement(sql), batch: async items => db.transaction(() => items.map(i => i.run()))()}};
}

function fixture(options: {down?: string[]; telegramUp?: boolean} = {}) {
    const {db, d1} = fakeD1();
    const sent: string[] = [];
    const modes: (string | undefined)[] = [];
    const clock = {now: 1_000 * H};
    const fetcher: Fetcher = async (url, init) => {
        if (url.startsWith("https://api.telegram.org/")) {
            if (options.telegramUp === false) return new Response("", {status: 502});
            const body = JSON.parse(String(init?.body)) as {text: string; parse_mode?: string};
            sent.push(body.text);
            modes.push(body.parse_mode);
            return Response.json({ok: true});
        }
        if (options.down?.some(d => url.includes(d))) return new Response("", {status: 503});
        if (url.endsWith("/health")) return Response.json({ok: true});
        if (url.endsWith("/profile/session")) return Response.json({error: {code: "login_required"}}, {status: 401});
        if (url.endsWith("/stamp")) return Response.json({accepts: [{network: "eip155:91342", amount: "1000000", asset: "0xcfeb694719A09caeb80798e2011298F29CDa4e92"}]}, {status: 402});
        if (url.endsWith("/faucet/status")) return Response.json({
            musdc: {enabled: true, targetBase: "1000000000", windowMs: 86_400_000, missions: ["x_follow_mapae"]},
            eth: {enabled: true, amountWei: "500000000000000", windowMs: 604_800_000, missions: ["x_follow_mapae"]},
            siteKey: "0x4AAAAAAA-site",
        });
        if (url.endsWith("seller.mapae.io/metrics")) return Response.json({orders: {}});
        if (url.endsWith("facilitator.mapae.io/metrics")) return Response.json({budget: {remainingWei: "90", limitWei: "100"}, last24h: {failed: 0, total: 0}});
        return new Response("<html>");
    };
    const env: Env = {DB: d1, ...SECRETS};
    const deps: Deps = {fetch: fetcher, now: () => clock.now};
    const pending: Promise<unknown>[] = [];
    const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p)};
    const call = async (path: string, init: RequestInit) => {
        const response = await handleRequest(new Request(`https://ops.example${path}`, init), env, deps, ctx);
        await Promise.all(pending.splice(0));
        return response;
    };
    const ingest = (body: unknown, token = SECRETS.INGEST_TOKEN) => call("/ingest", {method: "POST", headers: {Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
    const telegram = (body: unknown, secret = SECRETS.TELEGRAM_WEBHOOK_SECRET) => call("/telegram", {method: "POST", headers: {"X-Telegram-Bot-Api-Secret-Token": secret}, body: JSON.stringify(body)});
    return {db, env, deps, clock, sent, modes, options, ingest, telegram, tick: () => runScheduled(env, deps)};
}

test("a probe outage pages once, reminds hourly and recovers once across cron ticks", async () => {
    const f = fixture();
    await f.tick();
    expect(f.sent).toEqual([]);
    f.options.down = ["seller.mapae.io/health"];
    for (let i = 0; i < 14; i++) {f.clock.now += 5 * 60_000; await f.tick();}
    expect(f.sent[0]).toBe("[mapae ops]\nFAIL seller — HTTP 503");
    expect(f.sent.filter(m => m.includes("STILL FAILING seller"))).toHaveLength(1);
    f.options.down = [];
    f.clock.now += 5 * 60_000; await f.tick();
    f.clock.now += 5 * 60_000; await f.tick();
    expect(f.sent.at(-1)).toContain("RECOVERED seller after 70m");
    expect(f.sent).toHaveLength(3);
});

test("an undelivered alert is retried on the next tick instead of being marked sent", async () => {
    const f = fixture({down: ["facilitator.mapae.io/health"], telegramUp: false});
    await f.tick();
    expect((f.db.query("SELECT COUNT(*) AS n FROM alert_state WHERE name = 'facilitator'").get() as {n: number}).n).toBe(0);
    f.options.telegramUp = true;
    await f.tick();
    expect(f.sent).toEqual(["[mapae ops]\nFAIL facilitator — HTTP 503"]);
});

test("ingest authenticates, validates, records heartbeats and judges hourly items", async () => {
    const f = fixture();
    expect((await f.ingest({kind: "hourly", items: []}, "x".repeat(32))).status).toBe(401);
    expect((await f.ingest({kind: "hourly", items: [{name: "bad name", ok: true}]})).status).toBe(400);
    expect(f.db.query("SELECT * FROM heartbeats").all()).toEqual([]);

    expect((await f.ingest({kind: "hourly", items: [{name: "pending-intents", ok: false, detail: "2 older than 5m"}]})).status).toBe(200);
    expect(f.sent).toEqual(["[mapae ops]\nFAIL hourly:pending-intents — 2 older than 5m"]);
    // The collector stops reporting the item: it resolves instead of reminding forever.
    f.clock.now += H; await f.ingest({kind: "hourly", items: []});
    expect(f.sent.at(-1)).toBe("[mapae ops]\nRECOVERED hourly:pending-intents after 60m — no longer reported");

    expect((await f.ingest({kind: "daily", day: "2026-10-12", snapshot: {toBlock: 7}})).status).toBe(400);
    expect((await f.ingest({kind: "daily", day: "2026-10-12", snapshot: snapshotFixture("2026-10-12")})).status).toBe(200);
    expect(f.db.query("SELECT kind, at FROM heartbeats ORDER BY kind").all()).toEqual([{kind: "daily", at: f.clock.now}, {kind: "hourly", at: f.clock.now}]);
});

test("a silent collector raises a heartbeat alert after 2h, and clears when it reports again", async () => {
    const f = fixture();
    await f.ingest({kind: "hourly", items: []});
    f.clock.now += 2 * H; await f.tick();
    expect(f.sent).toEqual([]);
    f.clock.now += 5 * 60_000; await f.tick();
    expect(f.sent).toEqual(["[mapae ops]\nFAIL collector-heartbeat-hourly — last hourly ingest 2h5m ago"]);
    await f.ingest({kind: "hourly", items: []});
    f.clock.now += 5 * 60_000; await f.tick();
    expect(f.sent.at(-1)).toContain("RECOVERED collector-heartbeat-hourly");
});

test("the webhook needs the secret, answers only the allowed chat, and acks everything else", async () => {
    const f = fixture({down: ["mapae.io/ko/arcade"]});
    const update = (id: number, text: string) => ({update_id: 1, message: {chat: {id}, text}});
    expect((await f.telegram(update(42, "/help"), "x".repeat(32))).status).toBe(401);
    expect((await f.telegram(update(7, "/status"))).status).toBe(200);
    expect(f.sent).toEqual([]);
    await f.telegram(update(42, "/status"));
    expect(f.sent[0]).toStartWith("DEGRADED");
    expect(f.sent[0]).toContain("FAIL web (HTTP 503)");
    expect(f.sent[0]).toContain("collector: hourly never, daily never");
    await f.telegram(update(42, "/report"));
    expect(f.sent[1]).toBe("No daily snapshot has been ingested yet.");
    await f.ingest({kind: "daily", day: "2026-10-12", snapshot: snapshotFixture("2026-10-12")});
    await f.telegram(update(42, "/report"));
    expect(f.sent[3]).toStartWith("<b>Mapae daily · 2026-10-12 KST</b>");
    expect(f.sent[3]).toBe(f.sent[2]!);
    expect(f.sent.join("\n")).not.toContain(SECRETS.INGEST_TOKEN);
});

test("routing, methods and a missing secret", async () => {
    const f = fixture();
    expect((await handleRequest(new Request("https://ops.example/"), f.env, f.deps, {waitUntil: () => {}})).status).toBe(404);
    expect((await handleRequest(new Request("https://ops.example/ingest"), f.env, f.deps, {waitUntil: () => {}})).status).toBe(405);
    const {INGEST_TOKEN: _, ...rest} = f.env;
    expect((await handleRequest(new Request("https://ops.example/ingest", {method: "POST"}), rest, f.deps, {waitUntil: () => {}})).status).toBe(503);
    await expect(runScheduled(rest, f.deps)).rejects.toThrow("config_invalid: INGEST_TOKEN");
});

const daily = (day: string, tweak?: Parameters<typeof snapshotFixture>[1]) => ({kind: "daily", day, snapshot: snapshotFixture(day, tweak)});

test("every daily ingest sends the daily report as HTML, with deltas once the day before is on file", async () => {
    const f = fixture();
    f.clock.now = Date.parse("2026-10-14T00:30:00+09:00");
    // Weekdays whose week's Sunday is not on file, so only daily reports go out.
    await f.ingest(daily("2026-10-12"));
    await f.ingest(daily("2026-10-13", s => {s.day_metrics.settlements.organic = 5;}));
    expect(f.sent).toHaveLength(2);
    expect(f.modes).toEqual(["HTML", "HTML"]);
    expect(f.sent[0]).toContain("no snapshot for 2026-10-11; no deltas");
    expect(f.sent[1]).toContain("vs 2026-10-12");
    expect(f.sent[1]).toContain("org 5 (+2)");
});

test("the weekly report goes out once per Sunday snapshot, and a refused Monday send is delivered on Tuesday", async () => {
    const f = fixture();
    const weeks = () => f.db.query("SELECT week FROM weekly_reports ORDER BY week").all();
    f.clock.now = Date.parse("2026-10-05T00:30:00+09:00");
    await f.ingest(daily("2026-10-04"));
    expect(f.sent[1]).toStartWith("<b>Mapae weekly · 2026-09-28 – 2026-10-04 KST</b>");
    f.sent.length = 0;

    f.clock.now = Date.parse("2026-10-12T00:30:00+09:00"); // Monday in Korea
    f.options.telegramUp = false;
    expect((await f.ingest(daily("2026-10-11"))).status).toBe(200);
    expect(weeks()).toEqual([{week: "2026-10-04"}]);

    f.options.telegramUp = true;
    f.clock.now = Date.parse("2026-10-13T00:30:00+09:00"); // Tuesday: the week is not lost
    await f.ingest(daily("2026-10-12"));
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toStartWith("<b>Mapae daily · 2026-10-12 KST</b>");
    expect(f.sent[1]).toStartWith("<b>Mapae weekly · 2026-10-05 – 2026-10-11 KST</b>");
    expect(f.sent[1]).toContain("vs week ending 2026-10-04");
    expect(weeks()).toEqual([{week: "2026-10-04"}, {week: "2026-10-11"}]);
    // A re-run corrects the daily report but does not repeat the week, and later days stay quiet.
    await f.ingest(daily("2026-10-12"));
    f.clock.now += 24 * H;
    await f.ingest(daily("2026-10-13"));
    expect(f.sent.filter(m => m.includes("Mapae weekly"))).toHaveLength(1);
    expect(f.sent).toHaveLength(4);
});

test("a Sunday snapshot that lands late still sends its week, from the stored Sunday", async () => {
    const f = fixture();
    f.clock.now = Date.parse("2026-10-20T00:30:00+09:00");
    await f.ingest(daily("2026-10-19")); // the Monday run for Sunday failed; that week is not on file yet
    expect(f.sent.filter(m => m.includes("Mapae weekly"))).toHaveLength(0);
    f.clock.now += H;
    await f.ingest(daily("2026-10-18")); // Sunday backfilled by hand on Tuesday
    expect(f.sent.at(-1)).toStartWith("<b>Mapae weekly · 2026-10-12 – 2026-10-18 KST</b>");
});

test("a daily ingest answers and records its heartbeat without waiting for Telegram", async () => {
    const {db, d1} = fakeD1();
    const hanging: Fetcher = url => url.startsWith("https://api.telegram.org/") ? new Promise<Response>(() => {}) : Promise.resolve(new Response(""));
    const detached: Promise<unknown>[] = [];
    const request = new Request("https://ops.example/ingest", {method: "POST", headers: {Authorization: `Bearer ${SECRETS.INGEST_TOKEN}`}, body: JSON.stringify(daily("2026-10-11"))});
    const response = await handleRequest(request, {DB: d1, ...SECRETS}, {fetch: hanging, now: () => 5 * H}, {waitUntil: p => void detached.push(p)});
    expect(response.status).toBe(200);
    expect(detached).toHaveLength(1);
    expect(db.query("SELECT kind, at FROM heartbeats").all()).toEqual([{kind: "daily", at: 5 * H}]);
    expect(db.query("SELECT day FROM snapshots").all()).toEqual([{day: "2026-10-11"}]);
});

test("/report skips a stored snapshot this Worker can no longer read", async () => {
    const f = fixture();
    f.db.query("INSERT INTO snapshots (day, kind, json, created_at) VALUES ('2026-10-12', 'daily', '{\"toBlock\":7}', 1)").run();
    await f.telegram({update_id: 1, message: {chat: {id: 42}, text: "/report"}});
    expect(f.sent).toEqual(["The latest snapshot (2026-10-12) is in a shape this Worker cannot read."]);
});
