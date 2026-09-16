import type {Database} from "bun:sqlite";
import type {HexString} from "./index.js";
export interface PaymentSchedule {
    id: string;
    resourcePath: string;
    payTo: HexString;
    maxAmountBase: bigint;
    maxTotalBase: bigint;
    maxRuns: number;
    startsAt: number;
    endsAt: number;
    intervalMs: number;
    maxAttempts: number;
    retryDelayMs: number;
}
export interface ScheduledJob extends PaymentSchedule {
    status: "active" | "paused" | "cancelled" | "completed";
    nextAt: number;
    runCount: number;
    attempts: number;
    committedBase: bigint;
}
export interface ScheduledRun {
    id: number; jobId: string; at: number; attempt: number;
    outcome: "unknown" | "paid" | "unpaid";
    amountBase: bigint; code: string; transaction: HexString | null;
}
export type ScheduledResult =
    | {outcome: "paid"; amountBase: bigint; transaction?: HexString}
    | {outcome: "unpaid"; code: string; retry: boolean}
    | {outcome: "unknown"; code: string};
export interface ScheduleStore {
    add(input: PaymentSchedule): ScheduledJob;
    get(id: string): ScheduledJob | null;
    list(): ScheduledJob[];
    cancel(id: string): void;
    runs(id: string): ScheduledRun[];
    claim(id: string, now: number): {job: ScheduledJob; run: ScheduledRun} | null;
    finish(runId: number, result: ScheduledResult, now: number): void;
}
interface JobRow {
    id: string; resource_path: string; pay_to: HexString; max_amount: string; max_total: string;
    max_runs: number; starts_at: number; ends_at: number; interval_ms: number; max_attempts: number;
    retry_delay_ms: number; status: ScheduledJob["status"]; next_at: number; run_count: number;
    attempts: number; committed: string;
}
interface RunRow {id: number; job_id: string; at: number; attempt: number; outcome: ScheduledRun["outcome"]; amount: string; code: string; tx_hash: HexString | null; finished: number}
function job(r: JobRow): ScheduledJob {
    return {id: r.id, resourcePath: r.resource_path, payTo: r.pay_to, maxAmountBase: BigInt(r.max_amount),
        maxTotalBase: BigInt(r.max_total), maxRuns: r.max_runs, startsAt: r.starts_at, endsAt: r.ends_at,
        intervalMs: r.interval_ms, maxAttempts: r.max_attempts, retryDelayMs: r.retry_delay_ms,
        status: r.status, nextAt: r.next_at, runCount: r.run_count, attempts: r.attempts, committedBase: BigInt(r.committed)};
}
function run(r: RunRow): ScheduledRun {return {id: r.id, jobId: r.job_id, at: r.at, attempt: r.attempt, outcome: r.outcome, amountBase: BigInt(r.amount), code: r.code, transaction: r.tx_hash};}
function safeTime(n: number) {if (!Number.isSafeInteger(n) || n < 0 || n > 8640000000000000) throw new Error("invalid schedule time");}
export function createScheduleStore(db: Database): ScheduleStore {
    const get = (id: string) => {const r = db.query<JobRow, [string]>("SELECT * FROM payment_jobs WHERE id = ?").get(id); return r ? job(r) : null;};
    const claim = db.transaction((id: string, now: number) => {
        safeTime(now);
        const j = get(id);
        if (!j || j.status !== "active" || now < j.nextAt || now < j.startsAt) return null;
        if (now >= j.endsAt || (j.attempts === 0 && j.runCount >= j.maxRuns) || j.committedBase + j.maxAmountBase > j.maxTotalBase) {
            db.query("UPDATE payment_jobs SET status = 'completed' WHERE id = ?").run(id); return null;
        }
        // Claim is already unknown and paused: a crash at ANY later point cannot
        // cause another worker/restart to mint a second payment for this slot.
        db.query("UPDATE payment_jobs SET status = 'paused', committed = ?, run_count = ?, attempts = attempts + 1 WHERE id = ?")
            .run(String(j.committedBase + j.maxAmountBase), j.runCount + (j.attempts === 0 ? 1 : 0), id);
        const row = db.query<RunRow, [string, number, number, string]>("INSERT INTO payment_runs (job_id, at, attempt, outcome, amount, code, finished) VALUES (?, ?, ?, 'unknown', ?, 'IN_PROGRESS_OR_INTERRUPTED', 0) RETURNING *")
            .get(id, now, j.attempts + 1, String(j.maxAmountBase))!;
        return {job: get(id)!, run: run(row)};
    });
    const finish = db.transaction((runId: number, result: ScheduledResult, now: number) => {
        safeTime(now);
        const r = db.query<RunRow, [number]>("SELECT * FROM payment_runs WHERE id = ?").get(runId);
        if (!r) throw new Error("run not found");
        if (r.finished) return;
        const j = get(r.job_id)!;
        let committed = j.committedBase, status: ScheduledJob["status"] = "paused", next = j.nextAt, attempts = j.attempts;
        let amount = BigInt(r.amount), code = result.outcome === "paid" ? "PAID" : result.code;
        if (!/^[A-Z_]{1,64}$/.test(code)) throw new Error("invalid outcome code");
        if (result.outcome === "paid") {
            if (result.amountBase <= 0n || result.amountBase > j.maxAmountBase) throw new Error("paid amount outside reservation");
            if (result.transaction && !/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) throw new Error("invalid transaction");
            amount = result.amountBase;
            committed += amount - BigInt(r.amount);
            attempts = 0;
            // Skip missed intervals. Never catch up with a burst of payments.
            next = j.startsAt + (Math.floor((now - j.startsAt) / j.intervalMs) + 1) * j.intervalMs;
            status = "active";
        } else if (result.outcome === "unpaid") {
            committed -= BigInt(r.amount); amount = 0n;
            if (result.retry && attempts < j.maxAttempts) {status = "active"; next = now + j.retryDelayMs;}
        }
        if (status === "active" && (next >= j.endsAt || (attempts === 0 && j.runCount >= j.maxRuns) || committed + j.maxAmountBase > j.maxTotalBase)) status = "completed";
        if (j.status === "cancelled") status = "cancelled";
        db.query("UPDATE payment_jobs SET status = ?, committed = ?, next_at = ?, attempts = ? WHERE id = ?")
            .run(status, String(committed), next, attempts, j.id);
        db.query("UPDATE payment_runs SET outcome = ?, amount = ?, code = ?, tx_hash = ?, finished = 1 WHERE id = ?")
            .run(result.outcome, String(amount), code, result.outcome === "paid" ? result.transaction ?? null : null, runId);
    });
    return {
        add(input) {
            const j = input;
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(j.id) || !/^0x[0-9a-fA-F]{40}$/.test(j.payTo) || /^0x0{40}$/.test(j.payTo)) throw new Error("invalid schedule identity");
            if (typeof j.resourcePath !== "string" || !/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(j.resourcePath) || j.resourcePath.length > 512) throw new Error("resource must be a plain seller path without credentials or query");
            for (const n of [j.startsAt, j.endsAt, j.intervalMs, j.retryDelayMs]) safeTime(n);
            if (j.endsAt <= j.startsAt || j.intervalMs < 1000 || j.retryDelayMs < 1000 || !Number.isSafeInteger(j.maxRuns) || j.maxRuns < 1 || j.maxRuns > 100000 || !Number.isInteger(j.maxAttempts) || j.maxAttempts < 1 || j.maxAttempts > 10) throw new Error("invalid schedule bounds");
            if (typeof j.maxAmountBase !== "bigint" || typeof j.maxTotalBase !== "bigint" || j.maxAmountBase <= 0n || j.maxTotalBase < j.maxAmountBase) throw new Error("invalid payment caps");
            db.query("INSERT INTO payment_jobs (id, resource_path, pay_to, max_amount, max_total, max_runs, starts_at, ends_at, interval_ms, max_attempts, retry_delay_ms, status, next_at, run_count, attempts, committed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, 0, '0')")
                .run(j.id, j.resourcePath, j.payTo.toLowerCase(), String(j.maxAmountBase), String(j.maxTotalBase), j.maxRuns, j.startsAt, j.endsAt, j.intervalMs, j.maxAttempts, j.retryDelayMs, j.startsAt);
            return get(j.id)!;
        }, get,
        list: () => db.query<JobRow, []>("SELECT * FROM payment_jobs ORDER BY next_at, id").all().map(job),
        cancel(id) {if (!get(id)) throw new Error("job not found"); db.query("UPDATE payment_jobs SET status = 'cancelled' WHERE id = ?").run(id);},
        runs: (id) => db.query<RunRow, [string]>("SELECT * FROM payment_runs WHERE job_id = ? ORDER BY id").all(id).map(run),
        claim: (id, now) => claim.immediate(id, now), finish: (id, result, now) => finish.immediate(id, result, now),
    };
}
