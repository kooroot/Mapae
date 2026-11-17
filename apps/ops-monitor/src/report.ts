/**
 * Telegram reports built from daily snapshots. Pure: the Worker hands in parsed snapshots
 * and the clock, and gets back Telegram HTML.
 *
 * HTML rather than plain text for the bold headings only; every interpolated value goes
 * through `escapeHtml`, because a failure-reason key or a day string with a `<` in it
 * would otherwise make Telegram refuse the whole message with a parse error.
 *
 * Messages are bounded by construction (fixed rows, failure reasons capped) instead of
 * truncated: cutting HTML at 4096 characters can split a tag, and Telegram rejects that.
 */
import {LIMIT_REJECTIONS, type ChainMetrics, type ColumnFraction, type Columns, type DailySnapshot, type LedgerMetrics, type LimitRejection} from "@mapae/shared/ops-ingest";

const DAY_MS = 86_400_000;
const MAX_REASONS_SHOWN = 5;

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The calendar day `n` days after `day` (negative for before). */
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The most recent Sunday on or before `day`: the end of the latest Monday-to-Sunday week
 * that `day`'s snapshot can have closed. The weekly report is keyed to it rather than to
 * the clock of the ingest that sends it, so a refused or late send goes out with whichever
 * daily ingest comes next instead of waiting for a Monday that has already passed.
 */
export const weekEnding = (day: string): string => addDays(day, -new Date(`${day}T00:00:00Z`).getUTCDay());

const COLUMNS = [["internal", "int"], ["cohort", "coh"], ["organic", "org"]] as const;

function delta(now: number, before: number | undefined, unit = ""): string {
    if (before === undefined) return "";
    const d = Math.round((now - before) * 10) / 10;
    return ` (${d > 0 ? "+" : d < 0 ? "-" : "±"}${Math.abs(d)}${unit})`;
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;

function columnsLine(now: Columns, before: Columns | undefined): string {
    return COLUMNS.map(([key, label]) => `${label} ${now[key]}${delta(now[key], before?.[key])}`).join(" · ");
}

/** Numerator/denominator first: a 100% from 1/1 should not read like one from 40/40. */
function ratio(part: number, whole: number, before: {part: number; whole: number} | undefined): string {
    if (whole === 0) return "0/0";
    const prev = before && before.whole > 0 ? pct(before.part, before.whole) : undefined;
    return `${part}/${whole} ${pct(part, whole)}%${delta(pct(part, whole), prev, "pp")}`;
}

function fractionLine(now: ColumnFraction, before: ColumnFraction | undefined): string {
    return COLUMNS.map(([key, label]) =>
        `${label} ${ratio(now.part[key], now.whole[key], before && {part: before.part[key], whole: before.whole[key]})}`).join(" · ");
}

function successLine(now: LedgerMetrics, before: LedgerMetrics | undefined): string {
    const whole = now.settled + now.error;
    return whole === 0 ? "no broadcasts" : `${ratio(now.settled, whole, before && {part: before.settled, whole: before.settled + before.error})} settled/(settled+error)`;
}

const total = (c: Columns) => c.internal + c.cohort + c.organic;

const limitCount = (ledger: LedgerMetrics, code: LimitRejection) => ledger.failureReasons[`rejected:${code}`] ?? 0;
const limitTotal = (ledger: LedgerMetrics) => (Object.keys(LIMIT_REJECTIONS) as LimitRejection[]).reduce((sum, code) => sum + limitCount(ledger, code), 0);

/**
 * Attempts the delegation's own limits refused, as the facilitator saw them at `/verify`
 * and `/settle`. A count of attempts, not of payers: a retried request is counted again.
 */
function limitLine(now: LedgerMetrics, before: LedgerMetrics | undefined): string {
    const sum = limitTotal(now);
    const parts = (Object.entries(LIMIT_REJECTIONS) as [LimitRejection, string][])
        .filter(([code]) => limitCount(now, code) > 0).map(([code, label]) => `${label} ${limitCount(now, code)}`);
    return `${sum}${delta(sum, before && limitTotal(before))} attempts${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}

const entry = (title: string, body: string) => `<b>${escapeHtml(title)}</b>\n  ${escapeHtml(body)}`;

function header(title: string, current: DailySnapshot, comparedTo: string, previous: DailySnapshot | null): string {
    const cohort = current.classification.cohortSource === "file"
        ? `cohort ${current.classification.cohort} addresses`
        : "cohort file MISSING — the coh column is empty, not zero";
    return [
        `<b>${escapeHtml(title)}</b>`,
        escapeHtml(previous ? `vs ${comparedTo}` : `no snapshot for ${comparedTo}; no deltas`),
        escapeHtml(`block ${current.chain.toBlock} · ${cohort}`),
    ].join("\n");
}

/** The eight headline figures for one KST day, with deltas against the day before. */
export function dailyReport(current: DailySnapshot, previous: DailySnapshot | null): string {
    const now = current.day_metrics;
    const before = previous?.day_metrics;
    const violations = total(now.payerGasViolations);
    return [
        header(`Mapae daily · ${current.day} KST`, current, addDays(current.day, -1), previous),
        entry("1. Root settlements", columnsLine(now.settlements, before?.settlements)),
        entry("2. Broadcast success", successLine(current.ledger, previous?.ledger)),
        entry("3. External payees", columnsLine(now.externalPayees, before?.externalPayees)),
        entry("4. Payee concentration (top-1 share)", fractionLine(now.payeeTop1, before?.payeeTop1)),
        entry("5. Paying wallets", columnsLine(now.payingWallets, before?.payingWallets)),
        entry("6. Repeat paying wallets", columnsLine(now.repeatPayingWallets, before?.repeatPayingWallets)),
        entry(`7. Payments not relayed by Mapae (target 0)${violations ? " — VIOLATION" : ""}`, columnsLine(now.payerGasViolations, before?.payerGasViolations)),
        entry("8. Limit rejections", limitLine(current.ledger, previous?.ledger)),
    ].join("\n\n");
}

const WEEKLY_ROWS: [string, Exclude<keyof ChainMetrics, "payeeTop1">][] = [
    ["Root settlements", "settlements"],
    ["Paying wallets", "payingWallets"],
    ["New paying wallets", "newPayingWallets"],
    ["Repeat paying wallets", "repeatPayingWallets"],
    ["Onboarded accounts", "onboardedAccounts"],
    ["Revocations", "revocations"],
    ["External payees", "externalPayees"],
    ["Payer×payee pairs", "payerPayeePairs"],
    ["Self-payments (excluded above)", "selfPayments"],
    ["Payments not relayed by Mapae (target 0)", "payerGasViolations"],
];

function topReasons(reasons: Record<string, number>): string {
    const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!sorted.length) return "none";
    const shown = sorted.slice(0, MAX_REASONS_SHOWN).map(([key, n]) => `${key} ${n}`).join(", ");
    return sorted.length > MAX_REASONS_SHOWN ? `${shown}, +${sorted.length - MAX_REASONS_SHOWN} more` : shown;
}

const ms = (value: number | null) => (value === null ? "—" : `${value}ms`);

/** The seven KST days ending on `current.day`, against the seven before them. */
export function weeklyReport(current: DailySnapshot, previous: DailySnapshot | null): string {
    const now = current.week_metrics;
    const before = previous?.week_metrics;
    const ledger = current.week_ledger;
    return [
        header(`Mapae weekly · ${addDays(current.day, -6)} – ${current.day} KST`, current, `week ending ${addDays(current.day, -7)}`, previous),
        ...WEEKLY_ROWS.map(([title, key]) => entry(title, columnsLine(now[key], before?.[key]))),
        entry("Payee concentration (top-1 share)", fractionLine(now.payeeTop1, before?.payeeTop1)),
        entry("Broadcast success", successLine(ledger, previous?.week_ledger)),
        entry("Settlement latency", `p50 ${ms(ledger.latencyMs.p50)} · p95 ${ms(ledger.latencyMs.p95)} · n ${ledger.latencyMs.n}`),
        entry("Limit rejections", limitLine(ledger, previous?.week_ledger)),
        entry("Failure reasons", topReasons(ledger.failureReasons)),
        entry("Retention W1 (retained/eligible)", fractionLine(current.retention.w1, previous?.retention.w1)),
        entry("Retention W4 (retained/eligible)", fractionLine(current.retention.w4, previous?.retention.w4)),
    ].join("\n\n");
}
