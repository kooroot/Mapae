/**
 * The dial's surviving arithmetic.
 *
 * This module once computed the whole period dial — phase, ticks, countdown —
 * for the retired D6 console. Studio kept exactly two pieces: the struck
 * percentage its scope bar renders, and the address shortener its evidence
 * rows use. The rest went with the console; the enforcer's own period
 * numbering notes live on in `packages/delegation`'s status reader.
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

/**
 * One major tick per whole token, the way the tally marked its horses.
 *
 * Capped at 24 because past that the ticks stop being countable and become a
 * texture — and a cap you cannot count is not an engraving.
 */

/** Address and hash shortening, kept uniform so evidence reads alike everywhere. */
export function short(value: string): string {
    return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}
