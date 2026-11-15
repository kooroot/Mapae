/**
 * D1 access for the monitor. The Worker binding is typed by the narrow interface below
 * rather than `@cloudflare/workers-types`: these few calls are all the code uses, and a
 * structural type is what lets the tests run the real `schema.sql` on `bun:sqlite`.
 */
import {COLLECTOR_KINDS, type AlertRow, type CollectorKind} from "./alerts";

export interface D1Statement {
    bind(...values: (string | number | null)[]): D1Statement;
    first(): Promise<unknown>;
    all(): Promise<{results: unknown[]}>;
    run(): Promise<unknown>;
}

export interface D1Like {
    prepare(sql: string): D1Statement;
    batch(statements: D1Statement[]): Promise<unknown[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Rows are checked on the way out too; a row this code cannot read is skipped, not trusted. */
function alertRow(value: unknown): AlertRow | null {
    if (!isRecord(value) || typeof value.name !== "string" || (value.ok !== 0 && value.ok !== 1) || !isTime(value.since)) return null;
    if (value.last_notified !== null && !isTime(value.last_notified)) return null;
    return {name: value.name, ok: value.ok === 1, since: value.since, lastNotified: value.last_notified};
}

export async function loadAlerts(db: D1Like): Promise<Map<string, AlertRow>> {
    const {results} = await db.prepare("SELECT name, ok, since, last_notified FROM alert_state").all();
    return new Map(results.map(alertRow).filter(row => row !== null).map(row => [row.name, row]));
}

export async function saveAlerts(db: D1Like, rows: AlertRow[]): Promise<void> {
    if (!rows.length) return;
    await db.batch(rows.map(row => db.prepare(
        "INSERT INTO alert_state (name, ok, since, last_notified) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET ok = excluded.ok, since = excluded.since, last_notified = excluded.last_notified",
    ).bind(row.name, row.ok ? 1 : 0, row.since, row.lastNotified)));
}

export async function loadHeartbeats(db: D1Like): Promise<Map<CollectorKind, number>> {
    const {results} = await db.prepare("SELECT kind, at FROM heartbeats").all();
    const heartbeats = new Map<CollectorKind, number>();
    for (const row of results) {
        if (!isRecord(row) || !isTime(row.at)) continue;
        const kind = COLLECTOR_KINDS.find(k => k === row.kind);
        if (kind) heartbeats.set(kind, row.at);
    }
    return heartbeats;
}

export async function recordHeartbeat(db: D1Like, kind: CollectorKind, at: number): Promise<void> {
    await db.prepare("INSERT INTO heartbeats (kind, at) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET at = excluded.at").bind(kind, at).run();
}

export async function saveSnapshot(db: D1Like, day: string, json: string, at: number): Promise<void> {
    await db.prepare("INSERT INTO snapshots (day, kind, json, created_at) VALUES (?, 'daily', ?, ?) ON CONFLICT (day) DO UPDATE SET kind = excluded.kind, json = excluded.json, created_at = excluded.created_at")
        .bind(day, json, at).run();
}

export interface StoredSnapshot {
    day: string;
    json: string;
    createdAt: number;
}

function storedSnapshot(row: unknown): StoredSnapshot | null {
    if (!isRecord(row) || typeof row.day !== "string" || typeof row.json !== "string" || !isTime(row.created_at)) return null;
    return {day: row.day, json: row.json, createdAt: row.created_at};
}

export async function latestSnapshot(db: D1Like): Promise<StoredSnapshot | null> {
    return storedSnapshot(await db.prepare("SELECT day, json, created_at FROM snapshots ORDER BY day DESC LIMIT 1").first());
}

export async function snapshotOn(db: D1Like, day: string): Promise<StoredSnapshot | null> {
    return storedSnapshot(await db.prepare("SELECT day, json, created_at FROM snapshots WHERE day = ?").bind(day).first());
}

export async function weeklyReportSent(db: D1Like, week: string): Promise<boolean> {
    return (await db.prepare("SELECT week FROM weekly_reports WHERE week = ?").bind(week).first()) !== null;
}

export async function recordWeeklyReport(db: D1Like, week: string, at: number): Promise<void> {
    await db.prepare("INSERT INTO weekly_reports (week, sent_at) VALUES (?, ?) ON CONFLICT (week) DO NOTHING").bind(week, at).run();
}
