import type {DelegationStatus} from "@mapae/delegation/delegation-status";
import {fromTokenAmount} from "@mapae/shared";

export const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;

/** `Date` accepts ±8.64e15 ms; beyond that `toISOString` throws `RangeError`. */
const MAX_STAMP_SECONDS = 8_640_000_000_000n;

/**
 * Always UTC, and always said so.
 *
 * The previous form stripped both the `T` and the trailing `Z`, leaving a string
 * shaped exactly like a local wall clock — nine hours behind a Korean viewer's,
 * next to a status chip that judgeValidity computes from the chain's own block
 * timestamp. The two elements contradicted each other and the console read as
 * stale. The suffix is the whole fix: it matches the explorer and the e2e
 * output, and it does not depend on which machine renders it.
 *
 * Caveat terms are `uint128`, so a threshold can exceed the `Date` range; that
 * is a value to report as unrenderable, never a `RangeError` that unmounts the
 * page.
 */
export function stamp(seconds: bigint): string {
    if (seconds <= 0n || seconds > MAX_STAMP_SECONDS) return "—";
    return `${new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** Percentage of the period cap already spent, clamped for display. */
export function struckPercent(periodAmount: bigint, remaining: bigint): number {
    if (periodAmount <= 0n) return 0;
    const spent = periodAmount > remaining ? periodAmount - remaining : 0n;
    const permille = Number((spent * 1000n) / periodAmount) / 10;
    return Math.min(Math.max(permille, 0), 100);
}

/** One engraved tick per whole token, the way the tally marked its horses. */
export function tickCount(periodAmount: bigint, decimals = 6): number {
    const unit = 10n ** BigInt(decimals);
    return Math.min(Number(periodAmount / unit), 24);
}

/**
 * `ERC20PeriodTransferEnforcer._getAvailableAmount` returns `(0, false, 0)`
 * outright while `block.timestamp < startDate`, and its own doc comment says the
 * first real period is index 1. So `currentPeriod === 0` means "has not begun",
 * and the zero beside it is not a balance — reading it as one renders an
 * untouched cap as fully drained, which is the opposite of the truth.
 */
export function periodStarted(status: DelegationStatus): boolean {
    return (status.currentPeriod ?? 0n) > 0n;
}

/** Why this delegation cannot pay, or undefined when it can. */
export function haltReason(status: DelegationStatus): string | undefined {
    if (status.revoked) return "회수됨";
    if (status.expired) return "만료됨";
    if (status.notYetActive) return "미개시";
    return undefined;
}

/**
 * The cap rendered as struck marks: spent portion in bronze, the rest left as
 * recessed channel. The limit is shown as something engraved, never as an input.
 */
export function Engraving({status}: {status: DelegationStatus}) {
    const {limit, remaining} = status;
    if (!limit || remaining === undefined) {
        return <p className="note">이 위임에는 주기 한도 caveat이 없습니다.</p>;
    }

    const started = periodStarted(status);
    const halt = haltReason(status);

    // Before the first period opens the enforcer reports 0 available; the cap is
    // what will be available, so that is what the headline shows.
    const headline = started ? remaining : limit.periodAmount;
    const spent = started && limit.periodAmount > remaining ? limit.periodAmount - remaining : 0n;
    const struck = started ? struckPercent(limit.periodAmount, remaining) : 0;
    const ticks = tickCount(limit.periodAmount);

    return (
        <>
            <div className="engraving" data-halted={halt !== undefined}>
                <div className="remaining">{fromTokenAmount(headline)}</div>
                <div className="of-cap">
                    {halt ? (
                        // The number above is the period enforcer's own answer, and
                        // that enforcer never learns about revocation or expiry — so
                        // it keeps reporting the full cap forever. Struck through
                        // rather than replaced, with the reason stated here.
                        `${halt} · 이 위임으로는 지불할 수 없습니다`
                    ) : (
                        <>
                            남음 · 한도 {fromTokenAmount(limit.periodAmount)} mUSDC /{" "}
                            {String(limit.periodDuration)}초
                        </>
                    )}
                </div>
            </div>
            <div className="marks">
                <div className="struck" style={{width: `${struck}%`}} />
                {Array.from({length: Math.max(ticks - 1, 0)}, (_, index) => (
                    <div
                        key={index}
                        className="tick"
                        style={{left: `${((index + 1) / ticks) * 100}%`}}
                    />
                ))}
            </div>
            <div className="legend">
                <span>
                    {started ? `이번 주기 사용 ${fromTokenAmount(spent)}` : "주기 미개시"}
                </span>
                <span>
                    {started
                        ? `주기 #${String(status.currentPeriod ?? 0n)}`
                        : `개시 ${stamp(limit.startDate)}`}
                </span>
            </div>
        </>
    );
}
