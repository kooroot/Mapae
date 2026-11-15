/**
 * Alerting is a state machine over named checks, so a failure pages once rather than
 * every five minutes: ok→fail notifies immediately, a check that stays failing is
 * reminded at most hourly, and fail→ok notifies once. Everything here is pure; the
 * Worker supplies the stored row and the clock.
 */
export const REMINDER_MS = 60 * 60_000;
/**
 * Cron ticks are not exactly five minutes apart. Without slack an hourly reminder due at
 * 60:00 lands on the tick at 64:59 or, when that tick ran a second early, at 69:59.
 */
const REMINDER_SLACK_MS = 60_000;

export interface AlertRow {
    name: string;
    ok: boolean;
    /** When the current state began. */
    since: number;
    /** When the last notification for this check went out, or null if none ever did. */
    lastNotified: number | null;
}

export type AlertEvent = "failed" | "still_failing" | "recovered";

export interface Observation {
    name: string;
    ok: boolean;
    /** A short operator-facing description. Never a secret, a URL with a key, or a raw error. */
    detail?: string;
}

export interface Transition {
    row: AlertRow;
    /** Null when nothing changed that anyone needs to hear about. */
    event: AlertEvent | null;
    detail?: string;
}

/**
 * A check never seen before that is failing counts as a fresh failure: the first deploy,
 * or a newly added check, should page on a real fault rather than wait for a recovery.
 */
export function transition(previous: AlertRow | null, observed: Observation, now: number): Transition {
    const {name, ok, detail} = observed;
    if (!previous) return ok
        ? {row: {name, ok, since: now, lastNotified: null}, event: null}
        : {row: {name, ok, since: now, lastNotified: now}, event: "failed", detail};
    if (previous.ok && ok) return {row: previous, event: null};
    if (previous.ok) return {row: {name, ok, since: now, lastNotified: now}, event: "failed", detail};
    if (ok) return {row: {name, ok, since: now, lastNotified: now}, event: "recovered", detail};
    if (previous.lastNotified === null || now - previous.lastNotified >= REMINDER_MS - REMINDER_SLACK_MS)
        return {row: {...previous, lastNotified: now}, event: "still_failing", detail};
    return {row: previous, event: null};
}

const LABEL: Record<AlertEvent, string> = {failed: "FAIL", still_failing: "STILL FAILING", recovered: "RECOVERED"};

function duration(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

/** One message per tick, however many checks moved, so an outage is one notification. */
export function alertMessage(transitions: Transition[], previous: Map<string, AlertRow>, now: number): string | null {
    const lines = transitions.flatMap(({row, event, detail}) => {
        if (!event) return [];
        const before = previous.get(row.name);
        const age = event === "still_failing" ? ` for ${duration(now - row.since)}`
            : event === "recovered" && before ? ` after ${duration(now - before.since)}` : "";
        return [`${LABEL[event]} ${row.name}${age}${detail ? ` — ${detail}` : ""}`];
    });
    return lines.length ? `[mapae ops]\n${lines.join("\n")}` : null;
}

export const COLLECTOR_KINDS = ["hourly", "daily"] as const;
export type CollectorKind = (typeof COLLECTOR_KINDS)[number];

/** One missed run plus slack: an hourly job is late at 2h, a daily one at 26h. */
export const HEARTBEAT_MAX_AGE_MS: Record<CollectorKind, number> = {hourly: 2 * 60 * 60_000, daily: 26 * 60 * 60_000};

/**
 * The Mac mini cannot report its own death, so the Worker infers it from silence.
 *
 * A kind with no heartbeat at all yields no observation: before the collector's first
 * ingest there is nothing to be late against, and alerting from deploy time would page
 * about a collector that was never installed. The cost is that a collector which never
 * starts is not noticed here — the first successful ingest is what arms this alarm.
 */
export function heartbeatObservations(heartbeats: ReadonlyMap<CollectorKind, number>, now: number): Observation[] {
    return COLLECTOR_KINDS.flatMap(kind => {
        const at = heartbeats.get(kind);
        if (at === undefined) return [];
        const age = now - at;
        return [{name: `collector-heartbeat-${kind}`, ok: age <= HEARTBEAT_MAX_AGE_MS[kind], detail: age > HEARTBEAT_MAX_AGE_MS[kind] ? `last ${kind} ingest ${duration(age)} ago` : undefined}];
    });
}
