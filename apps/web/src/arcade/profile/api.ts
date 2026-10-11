import {getAddress, isAddress, verifyMessage, type Address, type Hex} from "viem";
import {createSiweMessage, generateSiweNonce} from "viem/siwe";
import type {ProfileRepository} from "./repository";

const SESSION = "__Host-mapae-arcade-session", CHALLENGE = "__Host-mapae-arcade-challenge";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const ORIGINS = new Set(["https://mapae.io", "https://app.mapae.io"]);
const HEADERS = {"Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer"};
const json = (value: unknown, status = 200, cookie?: string) => Response.json(value, {status, headers: {...HEADERS, ...(cookie ? {"Set-Cookie": cookie} : {})}});
const error = (code: string, status: number) => json({error: {code}}, status);
function limited(until: number, now: number) {
    const response = error("rate_limited", 429);
    response.headers.set("Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000))));
    return response;
}
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

/** Authenticated analytics attribution only; caller still enforces same-origin ingestion. */
export async function profileSessionOwner(request: Request, repo: ProfileRepository, now = Date.now()): Promise<string | null> {
    const session = readCookie(request, SESSION);
    const identity = session ? await repo.identity(await tokenHash(session), new URL(request.url).origin, now) : null;
    return identity && isAddress(identity.owner) ? identity.owner.toLowerCase() : null;
}

/** The stored challenge supplies the identity and message; no client-selected profile owner. */
export async function profileApi(request: Request, repo: ProfileRepository, options: {verify?: ProfileVerifier; now?: number; development?: boolean; outings?: (request: Request, owner: Address, input: unknown) => Promise<Response>; guardians?: (request: Request, owner: Address, input: unknown) => Promise<Response>; onAuthenticated?: (request: Request, owner: string, now: number) => Promise<void>} = {}): Promise<Response> {
    const url = new URL(request.url), now = options.now ?? Date.now();
    const local = options.development && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const historyCursor = /^\/api\/arcade\/profile\/guardians\/[1-9][0-9]{0,77}$/.test(url.pathname) && request.method === "GET" && /^\?before=[1-9][0-9]{0,15}$/.test(url.search) && Number.isSafeInteger(Number(url.searchParams.get("before")));
    if ((!ORIGINS.has(url.origin) && !local) || (url.search && !historyCursor)) return error("origin_denied", 403);
    if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin)) return error("origin_denied", 403);
    const write = request.method !== "GET";
    if (write && (request.headers.get("Origin") !== url.origin || request.headers.get("Content-Type")?.split(";")[0] !== "application/json")) return error("origin_denied", 403);
    const path = url.pathname;
    const outingPath = /^\/api\/arcade\/profile\/outings(?:\/[A-Za-z0-9_-]{8,80}\/(?:stop|resume))?$/.test(path);
    const guardianPath = /^\/api\/arcade\/profile\/guardians(?:\/[1-9][0-9]{0,77}(?:\/claims)?)?$/.test(path);
    if (!outingPath && !guardianPath && !["/api/arcade/profile/session", "/api/arcade/profile/challenge", "/api/arcade/profile/login", "/api/arcade/profile/logout"].includes(path)) return error("not_found", 404);
    try {
        if (path.endsWith("/challenge") && request.method === "POST") {
            const input = await body(request, 1024);
            if (!object(input) || typeof input.address !== "string" || !isAddress(input.address)) return error("invalid_address", 400);
            const owner = getAddress(input.address).toLowerCase();
            // Only Cloudflare's own IP header is trusted; client-forwarded headers are ignored.
            const ip = request.headers.get("CF-Connecting-IP");
            const window = Math.floor(now / 600_000), until = (window + 1) * 600_000;
            if (!await repo.rateLimit(`owner:${owner}:${window}`, until, 20) || (ip && !await repo.rateLimit(`ip:${await tokenHash(ip)}:${window}`, until, 60))) return limited(until, now);
            await repo.cleanup(now);
            const message = createSiweMessage({address: getAddress(owner), chainId: 91342, domain: url.host, uri: `${url.origin}/ko/arcade`, version: "1", nonce: generateSiweNonce(), issuedAt: new Date(now), expirationTime: new Date(now + 300_000), statement: "Sign in to Mapae Arcade to manage your NFT guardians and outings. This does not authorize payments or spending."});
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
            try {await options.onAuthenticated?.(request, challenge.owner, now);} catch { /* Measurement never blocks a verified login. */ }
            return response;
        }
        const session = readCookie(request, SESSION);
        const identity = session ? await repo.identity(await tokenHash(session), url.origin, now) : null;
        const requestedOwner = request.headers.get("X-Mapae-Wallet");
        if (!identity || !requestedOwner || !isAddress(requestedOwner) || requestedOwner.toLowerCase() !== identity.owner) return error("login_required", 401);
        if (path.endsWith("/logout") && request.method === "POST") {await repo.logout(await tokenHash(session!)); return json({ok: true}, 200, cookie(SESSION, "", 0));}
        const ip = request.headers.get("CF-Connecting-IP"), requestWindow = Math.floor(now / 60_000);
        if (ip && !await repo.rateLimit(`authenticated-ip:${await tokenHash(ip)}:${requestWindow}`, (requestWindow + 1) * 60_000, 600)) return limited((requestWindow + 1) * 60_000, now);
        if (guardianPath) {
            const claim = path.endsWith("/claims");
            if (request.method !== (claim ? "POST" : "GET")) return error("method_not_allowed", 405);
            const until = (requestWindow + 1) * 60_000;
            if (!await repo.rateLimit(`guardians:${identity.owner}:${request.method}:${requestWindow}`, until, claim ? 6 : 30)) return limited(until, now);
            if (!options.guardians) return error("guardians_unavailable", 503);
            // The path alone names the guardian; a claim request carries no client input to parse.
            return await options.guardians(request, getAddress(identity.owner).toLowerCase() as Address, null);
        }
        if (outingPath) {
            if (request.method !== "POST" && !(path === "/api/arcade/profile/outings" && request.method === "GET")) return error("method_not_allowed", 405);
            const window = Math.floor(now / 60_000), until = (window + 1) * 60_000;
            if (!await repo.rateLimit(`outings:${identity.owner}:${request.method}:${window}`, until, request.method === "GET" ? 30 : 12)) return limited(until, now);
            if (await repo.rateLimit(`cleanup:${window}`, until, 1)) await repo.cleanup(now);
            if (!options.outings) return error("outings_unavailable", 503);
            return await options.outings(request, getAddress(identity.owner).toLowerCase() as Address, request.method === "GET" ? null : await body(request, 65_536));
        }
        if (path !== "/api/arcade/profile/session" || request.method !== "GET") return error("method_not_allowed", 405);
        const until = (requestWindow + 1) * 60_000;
        if (!await repo.rateLimit(`session:${identity.owner}:${requestWindow}`, until, 60)) return limited(until, now);
        if (await repo.rateLimit(`cleanup:${requestWindow}`, until, 1)) await repo.cleanup(now);
        return json({owner: identity.owner});
    } catch (e) {
        return error(e instanceof Error && e.message === "body_too_large" ? "body_too_large" : e instanceof SyntaxError ? "invalid_json" : "profile_unavailable", e instanceof Error && e.message === "body_too_large" ? 413 : e instanceof SyntaxError ? 400 : 503);
    }
}
