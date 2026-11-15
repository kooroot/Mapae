/**
 * Constant-time secret comparison that runs unchanged in workerd and Bun.
 *
 * Both sides are SHA-256 hashed first so the loop always walks 32 bytes: comparing the
 * raw strings would have to branch on length, and that branch leaks the secret's length.
 * `crypto.subtle.timingSafeEqual` is a workerd extension Bun lacks, and `node:crypto`
 * would pull `nodejs_compat` into the Worker for one call.
 */
const encoder = new TextEncoder();

export async function secretEquals(presented: string, expected: string): Promise<boolean> {
    const [a, b] = await Promise.all([presented, expected].map(async v => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(v)))));
    let difference = 0;
    for (let i = 0; i < 32; i++) difference |= a![i]! ^ b![i]!;
    return difference === 0;
}

export async function bearerMatches(header: string | null, token: string): Promise<boolean> {
    const presented = /^Bearer ([\x21-\x7e]+)$/.exec(header ?? "")?.[1];
    return presented !== undefined && secretEquals(presented, token);
}
