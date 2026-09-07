/**
 * `/metrics` — the operator's view of the settlement ledger and the relayer's gas budget,
 * the guard in front of it, and the retention that bounds what the ledger keeps.
 *
 * Pure, so it is provable without booting the facilitator (which needs a signer, a
 * deployment artifact and a reachable RPC). `index.ts` owns the HTTP wiring, the status
 * codes and the prune timer; this module owns the decisions.
 */
import {createHash, timingSafeEqual} from "node:crypto";
import {budgetDay, type SpendBudget} from "@mapae/delegation";
import type {Ledger, LedgerRetention, LedgerSummary} from "@mapae/store";

const DAY_MS = 86_400_000;
const MIN_TOKEN_LENGTH = 16;

/**
 * How long `/settle`'s refusals stay on file. A signed payment the facilitator refuses is
 * a `rejected` ledger row, and the per-address rate limit bounds how fast those arrive,
 * not how many: a patient caller grew the sqlite file forever. Rejected rows are kept for
 * a week and never beyond the newest 50,000. The count is sized from the limit's worst
 * case — one address can put 600 req/h × 24 h = 14,400 rejected rows a day on file, at
 * ~200 B each about 3 MB — so 50,000 is three and a half such address-days, roughly
 * 10 MB, and under a sustained flood it is the count, not the week, that binds. Settled
 * and error rows are never pruned: money moved, or may have, and the ledger is the only
 * record of it.
 */
export const REJECTED_SETTLEMENT_RETENTION_MS = 7 * DAY_MS;
export const REJECTED_SETTLEMENTS_KEPT = 50_000;

/**
 * The retention `Ledger.prune` is handed at `now`. The cutoff is clamped at the epoch
 * for the same reason `metricsReport` clamps its window: the store refuses a negative
 * timestamp, and a clock inside the first week after 1970 is a test's, not a refusal's.
 */
export function rejectedRetention(now: number): LedgerRetention {
    return {
        rejectedBefore: Math.max(0, now - REJECTED_SETTLEMENT_RETENTION_MS),
        keepRejected: REJECTED_SETTLEMENTS_KEPT,
    };
}

/**
 * `METRICS_TOKEN` as configured. `undefined` means the endpoint is disabled; anything
 * set must be long enough that guessing it is not a plan. Whitespace is trimmed so a
 * trailing newline in an `.env` does not silently become part of the secret.
 */
export function readMetricsToken(value: string | undefined): string | undefined {
    const token = value?.trim();
    if (token === undefined || token === "") return undefined;
    if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error(`METRICS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    return token;
}

function sha256(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

/**
 * Constant-time bearer check. Both sides are hashed before comparing so the comparison
 * never branches on length — `timingSafeEqual` throws on unequal buffers, and an early
 * `length !==` return would leak the token's length one byte at a time.
 */
export function bearerTokenMatches(header: string | undefined, token: string): boolean {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
    if (presented === undefined) return false;
    return timingSafeEqual(sha256(presented), sha256(token));
}

export interface SummaryJson {
    total: number;
    succeeded: number;
    failed: number;
    volumeByPayTo: Record<string, string>;
    uniquePayers: number;
}

/** The ledger summary with every bigint rendered as a decimal string — JSON has none. */
export function summaryJson(summary: LedgerSummary): SummaryJson {
    return {
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        volumeByPayTo: Object.fromEntries(
            Object.entries(summary.volumeByPayTo).map(([payTo, volume]) => [payTo, volume.toString()]),
        ),
        uniquePayers: summary.uniquePayers,
    };
}

/**
 * The relayer's daily gas budget as three independent readings, in wei as decimal
 * strings. `remainingWei` also subtracts reservations still in flight, which
 * `spentWei` does not yet include, so `limit - spent` and `remaining` differ while a
 * settlement is mid-broadcast; and `spentWei` can exceed `limitWei` when the last
 * receipt cost more than its reservation (the OP-Stack L1 fee is not in the estimate),
 * in which case `remainingWei` is `"0"`.
 */
export interface BudgetJson {
    /** The UTC calendar day the figures belong to, `YYYY-MM-DD`. */
    day: string;
    limitWei: string;
    spentWei: string;
    remainingWei: string;
}

export interface MetricsReport {
    last24h: SummaryJson;
    /**
     * All time for `succeeded`, `volumeByPayTo` and `uniquePayers`: settled rows are never
     * pruned, and neither are error rows. `failed` and `total` count rejected rows only as
     * far back as {@link rejectedRetention} keeps them — a week, at most 50,000 — so a
     * refusal older than that has left both figures.
     */
    allTime: SummaryJson;
    budget: BudgetJson;
}

/** The two readings `/metrics` takes from the relayer's `SpendBudget`. */
export type BudgetGauge = Pick<SpendBudget, "spentToday" | "remaining">;

/**
 * `limitWei` is the ceiling `budget` was constructed with; the budget does not expose
 * it, and the report has to state it so the two other figures can be read.
 */
export function metricsReport(
    ledger: Pick<Ledger, "summary">,
    now: number,
    budget: BudgetGauge,
    limitWei: bigint,
): MetricsReport {
    return {
        last24h: summaryJson(ledger.summary({sinceMs: Math.max(0, now - DAY_MS)})),
        allTime: summaryJson(ledger.summary({sinceMs: 0})),
        budget: {
            day: budgetDay(now),
            limitWei: limitWei.toString(),
            spentWei: budget.spentToday(now).toString(),
            remainingWei: budget.remaining(now).toString(),
        },
    };
}
