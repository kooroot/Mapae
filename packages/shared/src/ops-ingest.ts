/**
 * The `/ingest` contract between apps/metrics-collector (sender, on the Mac mini) and
 * apps/ops-monitor (receiver, the Cloudflare Worker). One module both import, so a field
 * the collector adds and the Worker refuses is a type error or a failing test, not a
 * silent 400 at 3 a.m.
 *
 * The collector judges its own invariants (it knows what a pending intent means) and
 * reports each as a named pass/fail; the Worker owns *when* that becomes a notification.
 *
 * Runtime-neutral on purpose: no viem, no Bun, no node — the Worker bundles this file.
 */

export const MAX_INGEST_BYTES = 256 * 1024;
/** Both ends refuse a weaker bearer: the sender before it leaves, the Worker at boot. */
export const INGEST_TOKEN_PATTERN = /^[\x21-\x7e]{32,256}$/;
const MAX_ITEMS = 64;
const MAX_DETAIL = 200;
const ITEM_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** Printable, single-line: a detail ends up inside a Telegram message line. */
const DETAIL = /^[^\x00-\x1f\x7f]*$/;

/**
 * The journal's words for a redemption the delegation's own limits refused, and the label
 * each gets in a report. The facilitator writes them to `settlement_events.error_code`
 * (never to the wire, which says `delegation_rejected` for all of them) and the Worker
 * reads them back out of `LedgerMetrics.failureReasons`, so both ends take the set from
 * here. `limit_allowance` is `ERC20TransferAmountEnforcer`'s one revert, which a spent
 * lifetime total and a leaf presented twice both raise; the chain does not say which.
 */
export const LIMIT_REJECTIONS = {
    limit_period_cap: "period cap",
    limit_allowance: "amount allowance",
    limit_expired: "expired",
    limit_revoked: "revoked",
} as const;
export type LimitRejection = keyof typeof LIMIT_REJECTIONS;

export interface IngestItem {
    name: string;
    ok: boolean;
    /** A short operator-facing description. Never a secret, a URL with a key, or a raw error. */
    detail?: string;
}

export type IngestPayload =
    | {kind: "hourly"; items: IngestItem[]}
    | {kind: "daily"; day: string; snapshot: DailySnapshot};

/** One figure split by who the address belongs to. See apps/metrics-collector/README.md. */
export type Columns = {internal: number; cohort: number; organic: number};

/**
 * A share carried as numerator and denominator rather than a float, so a report can show
 * "3/4" and tell 0/0 ("no data") apart from 0/5.
 */
export type ColumnFraction = {part: Columns; whole: Columns};

/**
 * On-chain metrics over one window. Self-payments (payer == payTo) are excluded from
 * every figure except `selfPayments`, because a wallet paying itself demonstrates nothing
 * a judge or an investor would count as use.
 */
export type ChainMetrics = {
    /** Root `RedeemedDelegation` links redeemed by the settlement signer. */
    settlements: Columns;
    payingWallets: Columns;
    /** Payers whose first-ever settlement falls inside the window. */
    newPayingWallets: Columns;
    /** Payers active in the window whose settlements, up to the window's end, span two or more KST days. */
    repeatPayingWallets: Columns;
    /** Accounts deployed by the bootstrap sponsor (`SimpleFactory.Deployed`). */
    onboardedAccounts: Columns;
    revocations: Columns;
    /** Distinct payTo addresses outside the internal set. */
    externalPayees: Columns;
    /** Settlements to the most-paid payTo (part) over all settlements with a known payTo (whole). */
    payeeTop1: ColumnFraction;
    payerPayeePairs: Columns;
    selfPayments: Columns;
    /**
     * Root redemptions of a Mapae payer (an account settled for at least once, or deployed
     * by the bootstrap sponsor) in a transaction the settlement signer did not send, so its
     * gas came from somewhere other than the relayer. Counts redemptions by any redeemer,
     * unlike `settlements`. Target 0.
     */
    payerGasViolations: Columns;
};

/**
 * Week-N retention of payers, by the KST day of their first settlement: retained in week N
 * means a settlement on days [first+7N, first+7N+7). Only payers whose week N had fully
 * elapsed by the snapshot's end are in the denominator, so a payer who started yesterday
 * never reads as churned.
 */
export type Retention = {w1: ColumnFraction; w4: ColumnFraction};

export type LedgerMetrics = {
    settled: number;
    error: number;
    rejected: number;
    /** settled / (settled + error); null with no broadcast. */
    broadcastSuccessRate: number | null;
    failureReasons: Record<string, number>;
    latencyMs: {n: number; p50: number | null; p95: number | null};
};

export type DailySnapshot = {
    version: 1;
    /** The KST calendar day measured; the same value as the payload's `day`. */
    day: string;
    generatedAt: string;
    chain: {fromBlock: number; toBlock: number; blockHash: string; toBlockTime: string};
    /** Set sizes, so a column read as zero can be told apart from a column never populated. */
    classification: {internal: number; cohort: number; cohortSource: "file" | "missing"};
    day_metrics: ChainMetrics;
    /** The seven KST days ending on `day`; only the wallet figures are meaningful weekly. */
    week_metrics: ChainMetrics;
    all_time: ChainMetrics;
    retention: Retention;
    /** From the facilitator's own journal, the measured KST day only. Not split by column. */
    ledger: LedgerMetrics;
    /** The same journal over `week_metrics`' seven days, for the weekly report. */
    week_ledger: LedgerMetrics;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(k => keys.includes(k));

function item(value: unknown): IngestItem | null {
    if (!isRecord(value) || !onlyKeys(value, ["name", "ok", "detail"])) return null;
    if (typeof value.name !== "string" || !ITEM_NAME.test(value.name) || typeof value.ok !== "boolean") return null;
    if (value.detail === undefined) return {name: value.name, ok: value.ok};
    if (typeof value.detail !== "string" || value.detail.length > MAX_DETAIL || !DETAIL.test(value.detail)) return null;
    return {name: value.name, ok: value.ok, detail: value.detail};
}

/** A real calendar day: `2026-02-30` passes the pattern and would silently sort as a day. */
export function validDay(day: unknown): day is string {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const parsed = new Date(`${day}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function parseIngest(value: unknown): IngestPayload | null {
    if (!isRecord(value)) return null;
    if (value.kind === "hourly") {
        if (!onlyKeys(value, ["kind", "items"]) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return null;
        const items = value.items.map(item);
        if (items.some(i => i === null)) return null;
        const valid = items.filter(i => i !== null);
        if (new Set(valid.map(i => i.name)).size !== valid.length) return null;
        return {kind: "hourly", items: valid};
    }
    if (value.kind === "daily") {
        if (!onlyKeys(value, ["kind", "day", "snapshot"]) || !validDay(value.day)) return null;
        const snapshot = parseDailySnapshot(value.snapshot);
        if (!snapshot || snapshot.day !== value.day) return null;
        return {kind: "daily", day: value.day, snapshot};
    }
    return null;
}

/*
 * The snapshot is checked in full at ingest, not merely as "an object": the Worker formats
 * Telegram reports from it later, and a field it cannot read then would surface as a
 * broken report days after the run that produced it, with the bad run long gone. Refused
 * here, it fails the collector's own pre-send check and silences the daily heartbeat today.
 * Each parser rebuilds the value from checked fields, so unknown keys never reach storage.
 */

type Parser<T> = (value: unknown) => T | null;

const count: Parser<number> = value => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const unit: Parser<number> = value => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const isoTime: Parser<string> = value => (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null);

/** Parses every listed key, refusing extra ones; `undefined` marks a refusal so a parsed `null` survives. */
function record<T extends Record<string, unknown>>(value: unknown, fields: {[K in keyof T]: (v: unknown) => T[K] | undefined}): T | null {
    if (!isRecord(value) || !onlyKeys(value, Object.keys(fields))) return null;
    const out: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(fields)) {
        if (!(key in value)) return null;
        const parsed = parse(value[key]);
        if (parsed === undefined) return null;
        out[key] = parsed;
    }
    // Every key of T was parsed by its own field parser above.
    return out as T;
}

/** Adapts a null-on-failure parser to `record`'s undefined-on-failure convention. */
const req = <T>(parse: Parser<T>) => (value: unknown): T | undefined => parse(value) ?? undefined;
const opt = <T>(parse: Parser<T>) => (value: unknown): T | null | undefined => (value === null ? null : parse(value) ?? undefined);

const columns: Parser<Columns> = value => record<Columns>(value, {internal: req(count), cohort: req(count), organic: req(count)});

const fraction: Parser<ColumnFraction> = value => {
    const parsed = record<ColumnFraction>(value, {part: req(columns), whole: req(columns)});
    if (!parsed) return null;
    const {part, whole} = parsed;
    return part.internal <= whole.internal && part.cohort <= whole.cohort && part.organic <= whole.organic ? parsed : null;
};

const chainMetrics: Parser<ChainMetrics> = value => record<ChainMetrics>(value, {
    settlements: req(columns),
    payingWallets: req(columns),
    newPayingWallets: req(columns),
    repeatPayingWallets: req(columns),
    onboardedAccounts: req(columns),
    revocations: req(columns),
    externalPayees: req(columns),
    payeeTop1: req(fraction),
    payerPayeePairs: req(columns),
    selfPayments: req(columns),
    payerGasViolations: req(columns),
});

/** Failure-reason keys are journal error codes and are printed into reports. */
const REASON_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_REASONS = 64;

const reasons: Parser<Record<string, number>> = value => {
    if (!isRecord(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > MAX_REASONS) return null;
    const out: Record<string, number> = {};
    for (const [key, n] of entries) {
        const parsed = count(n);
        if (!REASON_KEY.test(key) || parsed === null) return null;
        out[key] = parsed;
    }
    return out;
};

const ledger: Parser<LedgerMetrics> = value => record<LedgerMetrics>(value, {
    settled: req(count),
    error: req(count),
    rejected: req(count),
    broadcastSuccessRate: opt(unit),
    failureReasons: req(reasons),
    latencyMs: req(v => record<LedgerMetrics["latencyMs"]>(v, {n: req(count), p50: opt(count), p95: opt(count)})),
});

export const parseDailySnapshot: Parser<DailySnapshot> = value => record<DailySnapshot>(value, {
    version: v => (v === 1 ? 1 : undefined),
    day: v => (validDay(v) ? v : undefined),
    generatedAt: req(isoTime),
    chain: req(v => record<DailySnapshot["chain"]>(v, {
        fromBlock: req(count),
        toBlock: req(count),
        blockHash: b => (typeof b === "string" && /^0x[0-9a-fA-F]{64}$/.test(b) ? b : undefined),
        toBlockTime: req(isoTime),
    })),
    classification: req(v => record<DailySnapshot["classification"]>(v, {
        internal: req(count),
        cohort: req(count),
        cohortSource: c => (c === "file" || c === "missing" ? c : undefined),
    })),
    day_metrics: req(chainMetrics),
    week_metrics: req(chainMetrics),
    all_time: req(chainMetrics),
    retention: req(v => record<Retention>(v, {w1: req(fraction), w4: req(fraction)})),
    ledger: req(ledger),
    week_ledger: req(ledger),
});
