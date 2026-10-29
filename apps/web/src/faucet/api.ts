import {
    parseFaucetAccount,
    parseFaucetClaimView,
    parseFaucetRefusal,
    parseFaucetStatus,
    type FaucetKind,
    type FaucetStatus,
} from "@mapae/delegation/faucet-policy";
import {ipBucket, subnetBucket} from "@mapae/shared/net";
import type {ProfileRepository} from "../arcade/profile/repository";
import {fromEdgeCache} from "../lib/edge-cache";
import {
    body, error, json, limited, object, siweChallenge, siweLogin, siweLogout, siweWalletOwner, type SiweSite, type SiweVerifier,
} from "../lib/siwe-session";

/**
 * faucet.mapae.io's API: SIWE on its own origin, Turnstile, the network keys, and a
 * validated proxy to the faucet service that holds the key.
 *
 * The Worker is the only thing that can prove who is asking. It owns the wallet check
 * (a session bound to this origin), the bot check (Turnstile bound to this hostname, the
 * claim's kind and the signed-in owner) and the network identity (the client's address
 * bucket and subnet, HMAC'd with a secret salt so the service never stores a raw IP).
 * The service then trusts the bearer and decides amounts, windows and limits.
 */

export const FAUCET_ORIGIN = "https://faucet.mapae.io";
const UPSTREAM = "https://facilitator.mapae.io/faucet";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_RESPONSE_BYTES = 16 * 1024;
/** Status names no balance or wallet; a short shared cache absorbs a crowd on the page. */
const STATUS_MAX_AGE = 30;
const TEN_MINUTES = 600_000;

export const FAUCET_SITE: SiweSite = {
    sessionCookie: "__Host-mapae-faucet-session",
    challengeCookie: "__Host-mapae-faucet-challenge",
    sessionSeconds: 24 * 60 * 60,
    uriPath: "/",
    limitPrefix: "faucet-",
    statement: "Sign in to Mapae Faucet to receive testnet tokens. This does not authorize payments or spending.",
};

export type FaucetApiDependencies = {
    repo: ProfileRepository;
    serviceToken?: string;
    ipSalt?: string;
    turnstileSecret?: string;
    siteKey?: string;
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
    cache?: Promise<Cache>;
    development?: boolean;
    verify?: SiweVerifier;
    now?: number;
};

/** The status as the page reads it: the service's view plus the Turnstile site key. */
export type FaucetPageStatus = FaucetStatus & {siteKey: string};

const ROUTES = new Set(["/api/faucet/status", "/api/faucet/challenge", "/api/faucet/login", "/api/faucet/session", "/api/faucet/logout", "/api/faucet/claim"]);
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

const refusal = (code: string, status: number, nextAt?: number) =>
    json({error: nextAt === undefined ? {code} : {code, nextAt}}, status);

export async function faucetApi(request: Request, deps: FaucetApiDependencies): Promise<Response> {
    const url = new URL(request.url), now = deps.now ?? Date.now(), path = url.pathname;
    const local = deps.development === true && LOOPBACK.includes(url.hostname);
    if ((url.origin !== FAUCET_ORIGIN && !local) || url.search) return error("origin_denied", 403);
    if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin)) return error("origin_denied", 403);
    if (!ROUTES.has(path)) return error("not_found", 404);
    const write = path !== "/api/faucet/status" && path !== "/api/faucet/session";
    if (request.method !== (write ? "POST" : "GET")) return error("method_not_allowed", 405);
    if (write && (request.headers.get("Origin") !== url.origin || request.headers.get("Content-Type")?.split(";")[0] !== "application/json")) return error("origin_denied", 403);
    const {serviceToken, ipSalt, turnstileSecret, siteKey} = deps;
    if (!serviceToken || serviceToken.length < 32 || !ipSalt || ipSalt.length < 32 || !turnstileSecret || !siteKey) return refusal("faucet_off", 503);
    // Native Workers fetch must not receive the service object as its `this`.
    const service = {token: serviceToken, fetcher: deps.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init))};
    try {
        if (path === "/api/faucet/status") return await status(url, siteKey, service, deps.cache);
        if (path === "/api/faucet/challenge") return await siweChallenge(request, deps.repo, FAUCET_SITE, now);
        if (path === "/api/faucet/login") return await siweLogin(request, deps.repo, FAUCET_SITE, now, {verify: deps.verify});
        const owner = await siweWalletOwner(request, deps.repo, FAUCET_SITE, now);
        if (!owner) return refusal("login_required", 401);
        if (path === "/api/faucet/logout") return await siweLogout(request, deps.repo, FAUCET_SITE);
        if (path === "/api/faucet/session") {
            const minute = Math.floor(now / 60_000), until = (minute + 1) * 60_000;
            if (!await deps.repo.rateLimit(`faucet-session:${owner}:${minute}`, until, 60)) return limited(until, now);
            const account = parseFaucetAccount(await upstream(service, `/claims/${owner}`, {method: "GET"}, 10_000).then(okJson));
            if (account.owner.toLowerCase() !== owner) throw new Error("upstream answered for another owner");
            return json(account);
        }
        return await claim(request, owner, now, {...service, ipSalt, turnstileSecret, repo: deps.repo, development: local});
    } catch (e) {
        if (e instanceof Error && e.message === "body_too_large") return error("body_too_large", 413);
        if (e instanceof SyntaxError) return error("invalid_json", 400);
        return refusal("unavailable", 503);
    }
}

type Service = {token: string; fetcher: (url: string, init?: RequestInit) => Promise<Response>};

async function status(url: URL, siteKey: string, service: Service, cachePromise?: Promise<Cache>): Promise<Response> {
    const key = new Request(`${url.origin}/api/faucet/status`), cache = cachePromise ? await cachePromise.catch(() => undefined) : undefined;
    const hit = await cache?.match(key);
    if (hit) return fromEdgeCache(hit, `public, max-age=${STATUS_MAX_AGE}`);
    const value: FaucetPageStatus = {...parseFaucetStatus(await upstream(service, "/status", {method: "GET"}, 10_000).then(okJson)), siteKey};
    const response = json(value);
    response.headers.set("Cache-Control", `public, max-age=${STATUS_MAX_AGE}`);
    await cache?.put(key, response.clone()).catch(() => {/* A cold cache costs the next visitor one service call. */});
    return response;
}

/**
 * A claim: a per-IP and per-owner D1 limit first (so a flood never reaches Turnstile or
 * the service), then Turnstile bound to this hostname, the claim's kind and the owner,
 * then the service. Only a validated claim view or a refusal from the closed set leaves.
 */
async function claim(request: Request, owner: string, now: number, deps: Service & {ipSalt: string; turnstileSecret: string; repo: ProfileRepository; development: boolean}): Promise<Response> {
    const input = await body(request, 4096);
    if (!object(input) || (input.kind !== "musdc" && input.kind !== "eth") || typeof input.turnstile !== "string" || input.turnstile.length < 1 || input.turnstile.length > 2048 ||
        !Array.isArray(input.missions) || input.missions.length > 16 || !input.missions.every((m) => typeof m === "string" && /^[a-z0-9_]{1,64}$/.test(m))) {
        return refusal("malformed_request", 400);
    }
    const kind: FaucetKind = input.kind;
    // Only Cloudflare's own header is trusted. Without it the request did not cross the edge,
    // which only a local development server legitimately does.
    const ip = request.headers.get("CF-Connecting-IP") ?? (deps.development ? "127.0.0.1" : null);
    if (!ip) return refusal("unavailable", 503);
    const [ipKey, subnetKey] = await Promise.all([hmac(deps.ipSalt, `ip:${ipBucket(ip)}`), hmac(deps.ipSalt, `subnet:${subnetBucket(ip)}`)]);
    const window = Math.floor(now / TEN_MINUTES), until = (window + 1) * TEN_MINUTES;
    if (!await deps.repo.rateLimit(`faucet-claim-ip:${ipKey}:${window}`, until, 10) || !await deps.repo.rateLimit(`faucet-claim-owner:${owner}:${window}`, until, 10)) {
        return limited(until, now, refusal("rate_limited", 429));
    }
    if (!await turnstile(deps, {token: input.turnstile, ip, kind, owner, hostname: new URL(request.url).hostname})) return refusal("turnstile_failed", 403);

    const response = await upstream(deps, "/claims", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({kind, owner, ipKey, subnetKey, missions: input.missions}),
    }, 45_000);
    const value = await boundedJson(response);
    if (response.ok) return json(parseFaucetClaimView(value, kind));
    const refused = parseFaucetRefusal(value);
    if (!refused || ![400, 403, 429, 503].includes(response.status)) return refusal("unavailable", 503);
    return refusal(refused.reason, response.status, refused.nextAt);
}

/**
 * Cloudflare's siteverify, with every binding checked: the token was solved on this
 * hostname, for this kind of claim, by a page that named this owner. A token solved for
 * one claim cannot be replayed for another kind or another wallet, and siteverify itself
 * refuses a token it has already redeemed.
 */
async function turnstile(deps: Service & {turnstileSecret: string; development: boolean}, claim: {token: string; ip: string; kind: FaucetKind; owner: string; hostname: string}): Promise<boolean> {
    let value: unknown;
    try {
        const response = await deps.fetcher(SITEVERIFY, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({secret: deps.turnstileSecret, response: claim.token, remoteip: claim.ip, idempotency_key: crypto.randomUUID()}),
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {await response.body?.cancel(); return false;}
        value = await boundedJson(response);
    } catch {return false;}
    if (!object(value) || value.success !== true) return false;
    // Turnstile's test keys answer for a fixed placeholder hostname; only a local server may accept one.
    if (!deps.development && value.hostname !== claim.hostname) return false;
    return value.action === `claim-${claim.kind}` && value.cdata === claim.owner;
}

async function upstream(service: Service, path: string, init: RequestInit, timeout: number): Promise<Response> {
    return service.fetcher(`${UPSTREAM}${path}`, {
        ...init,
        headers: {...init.headers as Record<string, string>, Authorization: `Bearer ${service.token}`, Accept: "application/json"},
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
    });
}

async function okJson(response: Response): Promise<unknown> {
    if (!response.ok) {await response.body?.cancel(); throw new Error("upstream");}
    return boundedJson(response);
}

async function boundedJson(response: Response): Promise<unknown> {
    const advertised = response.headers.get("Content-Length");
    if (advertised && Number(advertised) > MAX_RESPONSE_BYTES) {await response.body?.cancel(); throw new Error("too_large");}
    const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
    const decoder = new TextDecoder(); let size = 0, text = "";
    for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {await reader.cancel(); throw new Error("too_large");}
        text += decoder.decode(next.value, {stream: true});
    }
    // A parse failure here is the service's, not the browser's: never answer it as invalid_json.
    try {return JSON.parse(text + decoder.decode());} catch {throw new Error("upstream_json");}
}

/** HMAC-SHA256 as lowercase hex: the service counts networks without ever holding an address. */
export async function hmac(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}
