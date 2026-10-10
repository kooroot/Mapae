/**
 * The dial's surviving arithmetic.
 *
 * This module once computed the whole period dial — phase, ticks, countdown —
 * for the retired D6 console. Studio kept the struck percentage its scope bar
 * renders and the shorteners its evidence rows and wallet chips use. The rest
 * went with the console; the enforcer's own period numbering notes live on in
 * `packages/delegation`'s status reader.
 */

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

/** Hash and evidence shortening, kept uniform so evidence reads alike everywhere. */
export function short(value: string): string {
    return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/** A wallet identity as every surface shows it: `0x1234…5678`. */
export function shortAddress(value: string): string {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
