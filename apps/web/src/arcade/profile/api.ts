import {getAddress, isAddress, verifyMessage, type Address, type Hex} from "viem";
import {createSiweMessage, generateSiweNonce} from "viem/siwe";
import {MAX_PROFILE_BYTES, parseProfile} from "./model";
import type {ProfileRepository} from "./repository";

const SESSION = "__Host-mapae-arcade-session", CHALLENGE = "__Host-mapae-arcade-challenge";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const ORIGINS = new Set(["https://mapae.io", "https://app.mapae.io"]);
const HEADERS = {"Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer"};
const json = (value: unknown, status = 200, cookie?: string) => Response.json(value, {status, headers: {...HEADERS, ...(cookie ? {"Set-Cookie": cookie} : {})}});
const error = (code: string, status: number) => json({error: {code}}, status);
export const tokenHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
function readCookie(request: Request, name: string): string | null {
    const value = request.headers.get("Cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
async function body(request: Request, max: number): Promise<unknown> {
    const reader = request.body?.getReader(); if (!reader) throw new Error("invalid_body");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > max) {await reader.cancel(); throw new Error("body_too_large");} chunks.push(next.value);}
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export type ProfileVerifier = (input: {address: Address; message: string; signature: Hex}) => Promise<boolean>;

/** The stored challenge supplies the identity and message; no client-selected profile owner. */
export async function profileApi(request: Request, repo: ProfileRepository, options: {verify?: ProfileVerifier; now?: number; development?: boolean} = {}): Promise<Response> {
    const url = new URL(request.url), now = options.now ?? Date.now();
    const local = options.development && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!ORIGINS.has(url.origin) && !local) || url.search) return error("origin_denied", 403);
    if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin)) return error("origin_denied", 403);
    const write = request.method !== "GET";
    if (write && (request.headers.get("Origin") !== url.origin || request.headers.get("Content-Type")?.split(";")[0] !== "application/json")) return error("origin_denied", 403);
    const path = url.pathname;
    if (!["/api/arcade/profile", "/api/arcade/profile/challenge", "/api/arcade/profile/login", "/api/arcade/profile/logout"].includes(path)) return error("not_found", 404);
    try {
        if (path.endsWith("/challenge") && request.method === "POST") {
            const input = await body(request, 1024);
            if (!object(input) || typeof input.address !== "string" || !isAddress(input.address)) return error("invalid_address", 400);
            const owner = getAddress(input.address).toLowerCase();
            // Only Cloudflare's own IP header is trusted; client-forwarded headers are ignored.
            const ip = request.headers.get("CF-Connecting-IP");
            const window = Math.floor(now / 600_000), until = (window + 1) * 600_000;
            if (!await repo.rateLimit(`owner:${owner}:${window}`, until, 20) || (ip && !await repo.rateLimit(`ip:${await tokenHash(ip)}:${window}`, until, 60))) return error("rate_limited", 429);
            await repo.cleanup(now);
            const message = createSiweMessage({address: getAddress(owner), chainId: 91342, domain: url.host, uri: `${url.origin}/ko/arcade`, version: "1", nonce: generateSiweNonce(), issuedAt: new Date(now), expirationTime: new Date(now + 300_000), statement: "Sign in to Mapae Arcade to sync your characters and play history. This does not authorize payments or spending."});
            const nonce = token();
            await repo.challenge(await tokenHash(nonce), {owner, origin: url.origin, message, expires_at: now + 300_000});
            return json({message}, 200, cookie(CHALLENGE, nonce, 300));
        }
        if (path.endsWith("/login") && request.method === "POST") {
            const input = await body(request, 4096), nonce = readCookie(request, CHALLENGE);
            if (!nonce || !object(input) || typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) return error("invalid_login", 400);
            const challenge = await repo.consumeChallenge(await tokenHash(nonce), url.origin, now);
            if (!challenge || !isAddress(challenge.owner)) return error("challenge_expired", 401);
            // Current connected owners are EOA wallets; contract account payment custody is separate.
            let valid = false;
            try {valid = await (options.verify ?? verifyMessage)({address: challenge.owner, message: challenge.message, signature: input.signature as Hex});} catch { /* Do not log bearer signatures. */ }
            if (!valid) return error("invalid_signature", 401);
            const previous = readCookie(request, SESSION); if (previous) await repo.logout(await tokenHash(previous));
            const session = token();
            await repo.session(await tokenHash(session), {owner: challenge.owner, origin: url.origin, expires_at: now + SESSION_SECONDS * 1000});
            const response = json({owner: challenge.owner}, 200, cookie(SESSION, session, SESSION_SECONDS));
            response.headers.append("Set-Cookie", cookie(CHALLENGE, "", 0));
            return response;
        }
        const session = readCookie(request, SESSION);
        const identity = session ? await repo.identity(await tokenHash(session), url.origin, now) : null;
        const requestedOwner = request.headers.get("X-Mapae-Wallet");
        if (!identity || !requestedOwner || !isAddress(requestedOwner) || requestedOwner.toLowerCase() !== identity.owner) return error("login_required", 401);
        if (path.endsWith("/logout") && request.method === "POST") {await repo.logout(await tokenHash(session!)); return json({ok: true}, 200, cookie(SESSION, "", 0));}
        if (path !== "/api/arcade/profile") return error("method_not_allowed", 405);
        if (request.method === "GET") return json(await repo.read(identity.owner));
        if (request.method !== "PUT") return error("method_not_allowed", 405);
        const input = await body(request, MAX_PROFILE_BYTES + 1024);
        if (!object(input) || typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0) return error("invalid_profile", 400);
        const profile = parseProfile(input.profile); if (!profile) return error("invalid_profile", 400);
        if (!await repo.write(identity.owner, input.revision, profile, now)) return json({error: {code: "revision_conflict"}, snapshot: await repo.read(identity.owner)}, 409);
        return json({owner: identity.owner, revision: input.revision + 1, profile});
    } catch (e) {
        return error(e instanceof Error && e.message === "body_too_large" ? "body_too_large" : e instanceof SyntaxError ? "invalid_json" : "profile_unavailable", e instanceof Error && e.message === "body_too_large" ? 413 : e instanceof SyntaxError ? 400 : 503);
    }
}
