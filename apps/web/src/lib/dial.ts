/**
 * The period, as arithmetic.
 *
 * Kept away from the component for the same reason `revoke-state.ts` and
 * `resolveRootDelegation` are kept away from theirs in the console: a render
 * test cannot advance a clock, and every interesting case here is a moment in
 * time — the instant before a period opens, the last second of one, the
 * rollover, and the two boundaries where `Date` itself gives up.
 *
 * The dial this feeds is driven by the *chain's* clock, not the browser's. A CSS
 * `animation-duration` would be the obvious way to sweep a 60-second hand, and
 * it is wrong: it free-runs against the visitor's machine and drifts away from
 * the block timestamp the enforcer actually compares against. Drift is precisely
 * the thing the product claims does not happen, so the animation may not
 * introduce it.
 */

/** `ERC20PeriodTransferEnforcer` terms are `uint128`; `Date` accepts ±8.64e15 ms. */
const MAX_STAMP_SECONDS = 8_640_000_000_000n;

export type PeriodInput = {
    /** Seconds since epoch, taken from the chain's latest block. */
    nowSeconds: bigint;
    /** `startDate` from the caveat's terms. */
    startDate: bigint;
    /** `periodDuration` from the caveat's terms. */
    durationSeconds: bigint;
};

export type PeriodPhase =
    /** `block.timestamp < startDate`. The enforcer answers `(0, false, 0)` here. */
    | {kind: "before"; startsInSeconds: bigint}
    /** Terms that cannot describe a period at all. Reported, never divided by. */
    | {kind: "undefined"; reason: string}
    | {
          kind: "open";
          /** 1-based, matching the enforcer's own numbering. */
          index: bigint;
          elapsedSeconds: bigint;
          remainingSeconds: bigint;
          /** 0 at the top of the period, approaching 1 at its close. */
          turn: number;
      };

/**
 * Where in its period the cap currently sits.
 *
 * The enforcer's own documentation numbers the first real period 1, and it
 * returns zero available while `block.timestamp < startDate` — so period 0 means
 * "has not begun", and the zero beside it is not a balance. The console carries
 * the same note at `Engraving.tsx`, because reading that zero as a balance
 * renders an untouched cap as fully drained: the exact opposite of the truth.
 */
export function periodPhase(input: PeriodInput): PeriodPhase {
    const {nowSeconds, startDate, durationSeconds} = input;
    if (durationSeconds <= 0n) {
        return {kind: "undefined", reason: "주기 길이가 0입니다"};
    }
    if (startDate <= 0n || startDate > MAX_STAMP_SECONDS) {
        return {kind: "undefined", reason: "개시 시각을 읽을 수 없습니다"};
    }
    if (nowSeconds < startDate) {
        return {kind: "before", startsInSeconds: startDate - nowSeconds};
    }
    const elapsedTotal = nowSeconds - startDate;
    const index = elapsedTotal / durationSeconds + 1n;
    const elapsedSeconds = elapsedTotal % durationSeconds;
    const remainingSeconds = durationSeconds - elapsedSeconds;
    return {
        kind: "open",
        index,
        elapsedSeconds,
        remainingSeconds,
        // Number() only after the modulo, so the operand is bounded by the
        // duration and cannot lose precision the way a raw epoch would.
        turn: Number(elapsedSeconds) / Number(durationSeconds),
    };
}

/**
 * Portion of the cap already spent, 0–100, clamped.
 *
 * `remaining` can exceed `periodAmount` for a delegation whose terms changed
 * shape, and an unclamped value would drive the struck mark past the rim.
 */
export function struckPercent(periodAmount: bigint, remaining: bigint): number {
    if (periodAmount <= 0n) return 0;
    const spent = periodAmount > remaining ? periodAmount - remaining : 0n;
    const permille = Number((spent * 1000n) / periodAmount) / 10;
    return Math.min(Math.max(permille, 0), 100);
}

/**
 * One major tick per whole token, the way the tally marked its horses.
 *
 * Capped at 24 because past that the ticks stop being countable and become a
 * texture — and a cap you cannot count is not an engraving.
 */
export function tickCount(periodAmount: bigint, decimals = 6): number {
    const unit = 10n ** BigInt(decimals);
    const whole = Number(periodAmount / unit);
    return Math.min(Math.max(whole, 1), 24);
}

/** How many of those ticks are struck through. Always a whole tick. */
export function struckTicks(periodAmount: bigint, remaining: bigint, decimals = 6): number {
    const ticks = tickCount(periodAmount, decimals);
    return Math.min(Math.round((struckPercent(periodAmount, remaining) / 100) * ticks), ticks);
}

/**
 * `47초` / `2분 03초`. Never a bare number, and never a negative one.
 *
 * Padded past a minute so the string keeps its width — a countdown that reflows
 * every tick reads as a broken widget rather than a running clock.
 */
export function formatCountdown(seconds: bigint): string {
    if (seconds < 0n) return "0초";
    if (seconds < 60n) return `${seconds}초`;
    const minutes = seconds / 60n;
    const rest = seconds % 60n;
    if (minutes < 60n) return `${minutes}분 ${String(rest).padStart(2, "0")}초`;
    const hours = minutes / 60n;
    return `${hours}시간 ${String(minutes % 60n).padStart(2, "0")}분`;
}

/** Address and hash shortening, matching the console's so evidence reads alike. */
export function short(value: string): string {
    return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}
