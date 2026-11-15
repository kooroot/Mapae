import {expect, test} from "bun:test";
import {alertMessage, heartbeatObservations, REMINDER_MS, transition, type AlertRow} from "./alerts";

const MIN = 60_000;

test("ok→fail notifies once, reminds hourly while failing, and recovers once", () => {
    let row: AlertRow | null = {name: "seller", ok: true, since: 0, lastNotified: null};
    const events: (string | null)[] = [];
    for (let t = 5 * MIN; t <= 135 * MIN; t += 5 * MIN) {
        const next = transition(row, {name: "seller", ok: t > 125 * MIN}, t);
        events.push(next.event); row = next.row;
    }
    expect(events.filter(e => e === "failed")).toHaveLength(1);
    expect(events.filter(e => e === "still_failing")).toHaveLength(2);
    expect(events.filter(e => e === "recovered")).toHaveLength(1);
    expect(events.at(-1)).toBe(null);
    expect(row).toMatchObject({ok: true, since: 130 * MIN});
});

test("a first sighting pages only if it is failing; cron jitter does not skip a reminder", () => {
    expect(transition(null, {name: "x", ok: true}, 1).event).toBe(null);
    expect(transition(null, {name: "x", ok: false}, 1).event).toBe("failed");
    const failing = {name: "x", ok: false, since: 0, lastNotified: 0};
    expect(transition(failing, {name: "x", ok: false}, REMINDER_MS - 30_000).event).toBe("still_failing");
    expect(transition(failing, {name: "x", ok: false}, REMINDER_MS - 2 * MIN).event).toBe(null);
});

test("transitions collapse into one message", () => {
    const previous = new Map<string, AlertRow>([["web", {name: "web", ok: false, since: 0, lastNotified: 0}]]);
    const now = 90 * MIN;
    const message = alertMessage([
        transition(previous.get("web")!, {name: "web", ok: true}, now),
        transition(null, {name: "seller", ok: false, detail: "HTTP 503"}, now),
        transition(null, {name: "ticket", ok: true}, now),
    ], previous, now);
    expect(message).toBe("[mapae ops]\nRECOVERED web after 90m\nFAIL seller — HTTP 503");
    expect(alertMessage([transition(null, {name: "a", ok: true}, 0)], new Map(), 0)).toBeNull();
});

test("heartbeats go stale at 2h (hourly) and 26h (daily); never-seen kinds are silent", () => {
    const H = 60 * MIN, now = 100 * H;
    expect(heartbeatObservations(new Map(), now)).toEqual([]);
    const fresh = heartbeatObservations(new Map([["hourly", now - 2 * H], ["daily", now - 26 * H]]), now);
    expect(fresh.every(o => o.ok)).toBe(true);
    const stale = heartbeatObservations(new Map([["hourly", now - 2 * H - 1], ["daily", now - 26 * H - 1]]), now);
    expect(stale.map(o => [o.name, o.ok])).toEqual([["collector-heartbeat-hourly", false], ["collector-heartbeat-daily", false]]);
});
