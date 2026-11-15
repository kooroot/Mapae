/**
 * Pure metric computation over indexed chain events. No I/O: the indexer hands in rows,
 * the classifier says whose address is whose, and this module only counts.
 *
 * Days are KST calendar days because the operator, the cohort and the pitch all live in
 * Korea; a UTC day would split one Korean evening across two "days" and turn a user who
 * paid twice in one sitting into a repeat payer.
 */
import type {ChainMetrics, ColumnFraction, Columns, Retention} from "@mapae/shared/ops-ingest";

export type AddressClass = keyof Columns;

const KST_OFFSET_MS = 9 * 3_600_000;
export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of the KST calendar day containing `ms`. */
export function kstDay(ms: number): string {
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms at which a KST calendar day begins. */
export function kstDayStart(day: string): number {
    return Date.parse(`${day}T00:00:00+09:00`);
}

/** Whole KST days since the epoch; differences between two of these are calendar days. */
const dayNumber = (ms: number) => Math.floor((ms + KST_OFFSET_MS) / DAY_MS);

/** Lowercased address sets. Internal wins over cohort when an address is in both. */
export interface Classifier {
    internal: ReadonlySet<string>;
    cohort: ReadonlySet<string>;
}

export function classify(classifier: Classifier, address: string): AddressClass {
    const key = address.toLowerCase();
    if (classifier.internal.has(key)) return "internal";
    if (classifier.cohort.has(key)) return "cohort";
    return "organic";
}

/** Addresses are lowercase throughout; times are epoch milliseconds. */
export interface SettlementRow {
    payer: string;
    /** Null when the transaction moved no token out of the payer (nothing to attribute). */
    payTo: string | null;
    txFrom: string;
    at: number;
}
export interface RevocationRow {
    delegator: string;
    at: number;
}
export interface DeploymentRow {
    account: string;
    txFrom: string;
    at: number;
}

export interface ChainEvents {
    /** Root redemptions by the settlement signer. Every settlement figure counts these only. */
    settlements: readonly SettlementRow[];
    /** Root redemptions by anyone else on the same DelegationManager. */
    foreignRedemptions: readonly SettlementRow[];
    revocations: readonly RevocationRow[];
    deployments: readonly DeploymentRow[];
}

export interface Roles {
    /** The facilitator's settlement signer — the redeemer, and the wallet that pays a settlement's gas. */
    signer: string;
    /** The bootstrap sponsor, absent when the operator did not configure it. */
    sponsor?: string;
}

/** Half-open `[startMs, endMs)`. */
export interface Window {
    startMs: number;
    endMs: number;
}

const zero = (): Columns => ({internal: 0, cohort: 0, organic: 0});
const COLUMNS: AddressClass[] = ["internal", "cohort", "organic"];
const inWindow = (at: number, w: Window) => at >= w.startMs && at < w.endMs;
const isSelfPayment = (s: SettlementRow) => s.payTo !== null && s.payTo === s.payer;

function countDistinct(rows: Iterable<[AddressClass, string]>): Columns {
    const seen = {internal: new Set<string>(), cohort: new Set<string>(), organic: new Set<string>()};
    for (const [column, key] of rows) seen[column].add(key);
    return {internal: seen.internal.size, cohort: seen.cohort.size, organic: seen.organic.size};
}

export function computeChainMetrics(events: ChainEvents, window: Window, classifier: Classifier, roles: Roles): ChainMetrics {
    const column = (address: string) => classify(classifier, address);
    const signer = roles.signer.toLowerCase();
    const sponsor = roles.sponsor?.toLowerCase();

    // History up to the window's end decides "first ever" and "repeat"; nothing after it may.
    const history = events.settlements.filter(s => s.at < window.endMs && !isSelfPayment(s));
    const inside = history.filter(s => s.at >= window.startMs);
    const self = events.settlements.filter(s => inWindow(s.at, window) && isSelfPayment(s));

    const firstAt = new Map<string, number>();
    const days = new Map<string, Set<string>>();
    for (const s of history) {
        firstAt.set(s.payer, Math.min(firstAt.get(s.payer) ?? Infinity, s.at));
        let set = days.get(s.payer);
        if (!set) days.set(s.payer, set = new Set());
        set.add(kstDay(s.at));
    }
    const activePayers = new Set(inside.map(s => s.payer));

    const settlements = zero();
    for (const s of inside) settlements[column(s.payer)]++;

    // A payment of a Mapae payer whose gas the settlement signer did not pay. The signer
    // can only have paid if it sent the transaction, so `txFrom` is the test; the redeemer
    // decides what is a settlement, not who paid. A redemption the signer did not send was
    // paid for by the payer's side (its owner, its agent key, or its own EntryPoint
    // deposit) or by a facilitator we do not run, and the chain cannot tell those apart.
    // Either way it is a payment the gasless claim does not cover, and that is what is
    // counted.
    //
    // "Mapae payer" is the bound that keeps a stranger's use of the same DelegationManager
    // out: an account we settled for at least once, or one our bootstrap sponsor deployed.
    // Revocations are left out on purpose. They go through the EntryPoint and are charged
    // to the account's deposit, which the revocation sponsor fills, so the event alone
    // cannot say whose money it was.
    const mapaePayers = new Set(events.settlements.filter(s => s.at < window.endMs).map(s => s.payer));
    if (sponsor !== undefined) for (const d of events.deployments) if (d.txFrom === sponsor && d.at < window.endMs) mapaePayers.add(d.account);
    const violations = zero();
    for (const r of [...events.settlements, ...events.foreignRedemptions]) {
        if (inWindow(r.at, window) && !isSelfPayment(r) && r.txFrom !== signer && mapaePayers.has(r.payer)) violations[column(r.payer)]++;
    }
    const selfPayments = zero();
    for (const s of self) selfPayments[column(s.payer)]++;

    const withPayee = inside.filter((s): s is SettlementRow & {payTo: string} => s.payTo !== null);
    const payeeCounts = {internal: new Map<string, number>(), cohort: new Map<string, number>(), organic: new Map<string, number>()};
    for (const s of withPayee) {
        const counts = payeeCounts[column(s.payer)];
        counts.set(s.payTo, (counts.get(s.payTo) ?? 0) + 1);
    }
    const payeeTop1: ColumnFraction = {part: zero(), whole: zero()};
    for (const c of COLUMNS) {
        const values = [...payeeCounts[c].values()];
        payeeTop1.part[c] = values.length ? Math.max(...values) : 0;
        payeeTop1.whole[c] = values.reduce((a, b) => a + b, 0);
    }

    const onboarded = sponsor === undefined ? [] : events.deployments.filter(d => d.txFrom === sponsor && inWindow(d.at, window));

    return {
        settlements,
        payingWallets: countDistinct([...activePayers].map(p => [column(p), p])),
        newPayingWallets: countDistinct([...activePayers].filter(p => firstAt.get(p)! >= window.startMs).map(p => [column(p), p])),
        repeatPayingWallets: countDistinct([...activePayers].filter(p => days.get(p)!.size >= 2).map(p => [column(p), p])),
        onboardedAccounts: countDistinct(onboarded.map(d => [column(d.account), d.account])),
        revocations: events.revocations.filter(r => inWindow(r.at, window)).reduce((acc, r) => (acc[column(r.delegator)]++, acc), zero()),
        externalPayees: countDistinct(withPayee.filter(s => !classifier.internal.has(s.payTo)).map(s => [column(s.payer), s.payTo])),
        payeeTop1,
        payerPayeePairs: countDistinct(withPayee.map(s => [column(s.payer), `${s.payer}>${s.payTo}`])),
        selfPayments,
        payerGasViolations: violations,
    };
}

/**
 * W1 and W4 retention at `endMs`, by payer column. Days are counted from the KST day of a
 * payer's first non-self settlement, so a payer who first paid at 23:50 is not handed an
 * extra day by the clock.
 */
export function computeRetention(events: ChainEvents, endMs: number, classifier: Classifier): Retention {
    const lastDay = dayNumber(endMs - 1);
    const days = new Map<string, Set<number>>();
    for (const s of events.settlements) {
        if (s.at >= endMs || isSelfPayment(s)) continue;
        let set = days.get(s.payer);
        if (!set) days.set(s.payer, set = new Set());
        set.add(dayNumber(s.at));
    }
    const week = (n: number): ColumnFraction => {
        const fraction: ColumnFraction = {part: zero(), whole: zero()};
        for (const [payer, active] of days) {
            const start = Math.min(...active) + 7 * n;
            if (start + 6 > lastDay) continue;
            const column = classify(classifier, payer);
            fraction.whole[column]++;
            if ([...active].some(d => d >= start && d < start + 7)) fraction.part[column]++;
        }
        return fraction;
    };
    return {w1: week(1), w4: week(4)};
}

/** Nearest-rank percentile; null for an empty sample rather than a made-up zero. */
export function percentile(values: readonly number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
