/** A well-formed DailySnapshot for tests; `tweak` edits a deep copy. */
import type {ChainMetrics, Columns, DailySnapshot, LedgerMetrics} from "@mapae/shared/ops-ingest";

const cols = (internal = 0, cohort = 0, organic = 0): Columns => ({internal, cohort, organic});

const metrics = (): ChainMetrics => ({
    settlements: cols(2, 1, 3),
    payingWallets: cols(1, 1, 2),
    newPayingWallets: cols(0, 1, 1),
    repeatPayingWallets: cols(1, 0, 1),
    onboardedAccounts: cols(0, 1, 0),
    revocations: cols(),
    externalPayees: cols(0, 1, 2),
    payeeTop1: {part: cols(2, 1, 2), whole: cols(2, 1, 3)},
    payerPayeePairs: cols(1, 1, 3),
    selfPayments: cols(),
    payerGasViolations: cols(),
});

const ledger = (): LedgerMetrics => ({
    settled: 6, error: 0, rejected: 1,
    broadcastSuccessRate: 1,
    failureReasons: {"rejected:delegation_rejected": 1},
    latencyMs: {n: 6, p50: 2100, p95: 4800},
});

export function snapshotFixture(day: string, tweak: (s: DailySnapshot) => void = () => {}): DailySnapshot {
    const snapshot: DailySnapshot = {
        version: 1,
        day,
        generatedAt: `${day}T15:30:00.000Z`,
        chain: {fromBlock: 900, toBlock: 1000, blockHash: `0x${"ab".repeat(32)}`, toBlockTime: `${day}T15:00:00.000Z`},
        classification: {internal: 40, cohort: 12, cohortSource: "file"},
        day_metrics: metrics(),
        week_metrics: metrics(),
        all_time: metrics(),
        retention: {w1: {part: cols(0, 2, 1), whole: cols(1, 4, 3)}, w4: {part: cols(0, 1, 0), whole: cols(0, 2, 0)}},
        ledger: ledger(),
        week_ledger: ledger(),
    };
    tweak(snapshot);
    return snapshot;
}
