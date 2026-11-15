/**
 * Everything read from the services' own sqlite files. Both are opened read-only: the
 * collector observes a ledger, it never repairs one — a pending row it "cleaned up"
 * would erase the evidence an operator needs to reconcile it.
 */
import {Database} from "bun:sqlite";
import {budgetDay} from "@mapae/delegation/account-bootstrap";
import type {IngestItem, LedgerMetrics} from "@mapae/shared/ops-ingest";
import {reconcile} from "../../scripts/ops/reconcile";
import {percentile, type Window} from "./metrics";

const DAY_MS = 86_400_000;

export interface LedgerPaths {
    seller: string;
    facilitator: string;
}

function withReadOnly<T>(path: string, read: (db: Database) => T): T {
    const db = new Database(path, {readonly: true});
    try {
        return read(db);
    } finally {
        db.close();
    }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Every item `ledgerInvariants` reports. The collector sends each of them every hour, even
 * when the stores cannot be read: the Worker treats a failing item that disappears from a
 * payload as retired and clears it, so dropping these on a read failure would announce a
 * recovery for exactly the invariants nobody can see any more.
 */
export const LEDGER_ITEMS = ["pending-intents", "settled-without-order", "order-settlement-mismatch", "settlement-errors-24h", "relayer-budget"] as const;

/**
 * The ledger half of the hourly invariants. Order/journal agreement is `reconcile.ts`'s
 * judgement, reused rather than restated: two copies of "what counts as a settled
 * payment without an order" would drift, and the operator's manual reconcile and the
 * pager must never disagree about the same row.
 */
export async function ledgerInvariants(paths: LedgerPaths, now: number, relayerDailyWei: bigint): Promise<IngestItem[]> {
    const result = await reconcile(paths.seller, paths.facilitator, now);
    const count = (code: string) => result.issues.filter(i => i.code === code).length;
    const pending = count("pending_over_5m");
    const orphaned = count("settled_without_order");
    const mismatched = count("order_settlement_mismatch");

    const {errors, spent} = withReadOnly(paths.facilitator, db => ({
        errors: db.query<{n: number}, [number]>("SELECT COUNT(*) AS n FROM settlement_events WHERE outcome = 'error' AND at >= ?").get(now - DAY_MS)!.n,
        spent: db.query<{spent_wei: string}, [string]>("SELECT spent_wei FROM budget_days WHERE scope = 'total' AND day = ?").get(budgetDay(now))?.spent_wei ?? "0",
    }));
    if (!/^\d+$/.test(spent)) throw new Error("budget_days holds a non-decimal spent_wei");
    const remaining = relayerDailyWei > BigInt(spent) ? relayerDailyWei - BigInt(spent) : 0n;
    // Integer percent: bigint wei does not fit a float exactly, and a pager needs no decimals.
    const remainingPct = Number((remaining * 100n) / relayerDailyWei);

    return [
        {name: "pending-intents", ok: pending === 0, detail: pending ? `${plural(pending, "intent")} pending over 5m` : undefined},
        {name: "settled-without-order", ok: orphaned === 0, detail: orphaned ? `${plural(orphaned, "settled intent")} without a seller order` : undefined},
        {name: "order-settlement-mismatch", ok: mismatched === 0, detail: mismatched ? `${plural(mismatched, "order")} disagree with the journal` : undefined},
        {name: "settlement-errors-24h", ok: errors === 0, detail: errors ? `${plural(errors, "broadcast")} ended in error in 24h` : undefined},
        // Same 10% floor the public /metrics probe applies; this one still answers when the tunnel is down.
        {name: "relayer-budget", ok: remaining * 10n > relayerDailyWei, detail: `${remainingPct}% of today's relayer gas budget left`},
    ].map(({detail, ...rest}) => (detail === undefined ? rest : {...rest, detail}));
}

/** Addresses the seller marks as its own shops (`sellers.internal = 1`). */
export function internalPayees(sellerPath: string): string[] {
    return withReadOnly(sellerPath, db => db.query<{pay_to: string}, []>("SELECT pay_to FROM sellers WHERE internal = 1").all().map(r => r.pay_to));
}

/**
 * The facilitator journal's view of one window. Rejected rows are pruned after a week, so
 * they are reported but never used as a denominator: the success rate is settled against
 * error, i.e. "of the transactions we broadcast, how many landed".
 */
export function ledgerDaily(facilitatorPath: string, window: Window): LedgerMetrics {
    return withReadOnly(facilitatorPath, db => {
        const outcomes = db.query<{outcome: string; error_code: string | null; n: number}, [number, number]>(
            "SELECT outcome, error_code, COUNT(*) AS n FROM settlement_events WHERE at >= ? AND at < ? GROUP BY outcome, error_code").all(window.startMs, window.endMs);
        const totals = {settled: 0, error: 0, rejected: 0};
        const failureReasons: Record<string, number> = {};
        for (const row of outcomes) {
            if (row.outcome !== "settled" && row.outcome !== "error" && row.outcome !== "rejected") continue;
            totals[row.outcome] += row.n;
            if (row.outcome !== "settled") {
                const key = `${row.outcome}:${row.error_code ?? "unknown"}`;
                failureReasons[key] = (failureReasons[key] ?? 0) + row.n;
            }
        }
        const latencies = db.query<{ms: number}, [number, number]>(
            `SELECT e.at - i.created_at AS ms FROM settlement_intents i JOIN settlement_events e ON e.id = i.terminal_event_id
             WHERE e.outcome = 'settled' AND e.at >= ? AND e.at < ?`).all(window.startMs, window.endMs).map(r => r.ms);
        const broadcast = totals.settled + totals.error;
        return {
            ...totals,
            broadcastSuccessRate: broadcast === 0 ? null : totals.settled / broadcast,
            failureReasons,
            latencyMs: {n: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95)},
        };
    });
}
