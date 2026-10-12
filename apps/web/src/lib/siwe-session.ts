import {getAddress, isAddress, verifyMessage, type Address, type Hex} from "viem";
import {createSiweMessage, generateSiweNonce} from "viem/siwe";
import type {ProfileRepository} from "../arcade/profile/repository";

/**
 * Sign-In with Ethereum for a Worker origin: a one-use, five-minute challenge in a
 * `__Host-` cookie, then a session cookie whose hash names the owner in D1.
 *
 * Shared by the arcade (mapae.io, app.mapae.io) and the faucet (faucet.mapae.io). Every
 * challenge and session row carries the origin it was issued on and is only ever read
 * back for that origin, so a session from one site is worthless on another even though
 * they share tables. Each site names its own cookies, statement, landing path and
 * rate-limit prefix; nothing else differs.
 */
export interface SiweSite {
    sessionCookie: string;
    challengeCookie: string;
    sessionSeconds: number;
    statement: string;
    /** The path the message's `uri` names, e.g. `/ko/arcade` or `/`. */
    uriPath: string;
    /** Prefix for this site's rate-limit buckets, so one site's traffic never spends another's. */
    limitPrefix: string;
}

export const SIWE_CHAIN_ID = 91342;
const CHALLENGE_MS = 300_000;

const HEADERS = {"Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer"};
export const json = (value: unknown, status = 200, cookie?: string) => Response.json(value, {status, headers: {...HEADERS, ...(cookie ? {"Set-Cookie": cookie} : {})}});
export const error = (code: string, status: number) => json({error: {code}}, status);
export function limited(until: number, now: number, response = error("rate_limited", 429)) {
    response.headers.set("Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000))));
    return response;
}
export const tokenHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
export const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
export function readCookie(request: Request, name: string): string | null {
    const value = request.headers.get("Cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
/** A JSON body read to at most `max` bytes; past that the stream is cancelled, not buffered. */
export async function body(request: Request, max: number): Promise<unknown> {
    const reader = request.body?.getReader(); if (!reader) throw new Error("invalid_body");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > max) {await reader.cancel(); throw new Error("body_too_large");} chunks.push(next.value);}
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
}
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export type SiweVerifier = (input: {address: Address; message: string; signature: Hex}) => Promise<boolean>;

/** Issue a challenge for `{address}`. Owner and IP are each limited per ten minutes. */
export async function siweChallenge(request: Request, repo: ProfileRepository, site: SiweSite, now: number): Promise<Response> {
    const url = new URL(request.url), input = await body(request, 1024);
    if (!object(input) || typeof input.address !== "string" || !isAddress(input.address)) return error("invalid_address", 400);
    const owner = getAddress(input.address).toLowerCase();
    // Only Cloudflare's own IP header is trusted; client-forwarded headers are ignored.
    const ip = request.headers.get("CF-Connecting-IP");
    const window = Math.floor(now / 600_000), until = (window + 1) * 600_000;
    if (!await repo.rateLimit(`${site.limitPrefix}owner:${owner}:${window}`, until, 20) || (ip && !await repo.rateLimit(`${site.limitPrefix}ip:${await tokenHash(ip)}:${window}`, until, 60))) return limited(until, now);
    await repo.cleanup(now);
    const message = createSiweMessage({address: getAddress(owner), chainId: SIWE_CHAIN_ID, domain: url.host, uri: `${url.origin}${site.uriPath}`, version: "1", nonce: generateSiweNonce(), issuedAt: new Date(now), expirationTime: new Date(now + CHALLENGE_MS), statement: site.statement});
    const nonce = token();
    await repo.challenge(await tokenHash(nonce), {owner, origin: url.origin, message, expires_at: now + CHALLENGE_MS});
    return json({message}, 200, cookie(site.challengeCookie, nonce, CHALLENGE_MS / 1000));
}

/**
 * Exchange the challenge cookie and a signature of the stored message for a session.
 * The stored challenge supplies the identity and message; nothing the client sends picks the owner.
 */
export async function siweLogin(request: Request, repo: ProfileRepository, site: SiweSite, now: number, options: {verify?: SiweVerifier; onAuthenticated?: (request: Request, owner: string, now: number) => Promise<void>} = {}): Promise<Response> {
    const url = new URL(request.url), input = await body(request, 4096), nonce = readCookie(request, site.challengeCookie);
    if (!nonce || !object(input) || typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) return error("invalid_login", 400);
    const challenge = await repo.consumeChallenge(await tokenHash(nonce), url.origin, now);
    if (!challenge || !isAddress(challenge.owner)) return error("challenge_expired", 401);
    // Connected owners are EOA wallets; contract account payment custody is separate.
    let valid = false;
    try {valid = await (options.verify ?? verifyMessage)({address: challenge.owner, message: challenge.message, signature: input.signature as Hex});} catch { /* Do not log bearer signatures. */ }
    if (!valid) return error("invalid_signature", 401);
    const previous = readCookie(request, site.sessionCookie); if (previous) await repo.logout(await tokenHash(previous));
    const session = token();
    await repo.session(await tokenHash(session), {owner: challenge.owner, origin: url.origin, expires_at: now + site.sessionSeconds * 1000});
    const response = json({owner: challenge.owner}, 200, cookie(site.sessionCookie, session, site.sessionSeconds));
    response.headers.append("Set-Cookie", cookie(site.challengeCookie, "", 0));
    try {await options.onAuthenticated?.(request, challenge.owner, now);} catch { /* Measurement never blocks a verified login. */ }
    return response;
}

/** The lowercase owner of this request's session on its own origin, or null. */
export async function siweSessionOwner(request: Request, repo: ProfileRepository, site: SiweSite, now: number): Promise<string | null> {
    const session = readCookie(request, site.sessionCookie);
    const identity = session ? await repo.identity(await tokenHash(session), new URL(request.url).origin, now) : null;
    return identity && isAddress(identity.owner) ? identity.owner.toLowerCase() : null;
}

/**
 * The session owner, only when the page also names that wallet in `X-Mapae-Wallet`. A tab
 * whose wallet switched accounts must not keep acting as the account it signed in with.
 */
export async function siweWalletOwner(request: Request, repo: ProfileRepository, site: SiweSite, now: number): Promise<string | null> {
    const owner = await siweSessionOwner(request, repo, site, now), requested = request.headers.get("X-Mapae-Wallet");
    return owner && requested && isAddress(requested) && requested.toLowerCase() === owner ? owner : null;
}

export async function siweLogout(request: Request, repo: ProfileRepository, site: SiweSite): Promise<Response> {
    const session = readCookie(request, site.sessionCookie);
    if (session) await repo.logout(await tokenHash(session));
    return json({ok: true}, 200, cookie(site.sessionCookie, "", 0));
}
