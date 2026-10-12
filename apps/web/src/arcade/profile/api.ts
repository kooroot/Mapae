import {getAddress, type Address} from "viem";
import {body, error, limited, json, siweChallenge, siweLogin, siweLogout, siweSessionOwner, siweWalletOwner, tokenHash, type SiweSite, type SiweVerifier} from "../../lib/siwe-session";
import type {ProfileRepository} from "./repository";

const ORIGINS = new Set(["https://mapae.io", "https://app.mapae.io"]);
const SITE: SiweSite = {
    sessionCookie: "__Host-mapae-arcade-session", challengeCookie: "__Host-mapae-arcade-challenge", sessionSeconds: 7 * 24 * 60 * 60, uriPath: "/ko/arcade", limitPrefix: "",
    statement: "Sign in to Mapae Arcade to manage your NFT guardians and outings. This does not authorize payments or spending.",
};
export type ProfileVerifier = SiweVerifier;

/** Authenticated analytics attribution only; caller still enforces same-origin ingestion. */
export function profileSessionOwner(request: Request, repo: ProfileRepository, now = Date.now()): Promise<string | null> {
    return siweSessionOwner(request, repo, SITE, now);
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
        if (path.endsWith("/challenge") && request.method === "POST") return await siweChallenge(request, repo, SITE, now);
        if (path.endsWith("/login") && request.method === "POST") return await siweLogin(request, repo, SITE, now, {verify: options.verify, onAuthenticated: options.onAuthenticated});
        const owner = await siweWalletOwner(request, repo, SITE, now);
        if (!owner) return error("login_required", 401);
        if (path.endsWith("/logout") && request.method === "POST") return await siweLogout(request, repo, SITE);
        const ip = request.headers.get("CF-Connecting-IP"), requestWindow = Math.floor(now / 60_000);
        if (ip && !await repo.rateLimit(`authenticated-ip:${await tokenHash(ip)}:${requestWindow}`, (requestWindow + 1) * 60_000, 600)) return limited((requestWindow + 1) * 60_000, now);
        if (guardianPath) {
            const claim = path.endsWith("/claims");
            if (request.method !== (claim ? "POST" : "GET")) return error("method_not_allowed", 405);
            const until = (requestWindow + 1) * 60_000;
            if (!await repo.rateLimit(`guardians:${owner}:${request.method}:${requestWindow}`, until, claim ? 6 : 30)) return limited(until, now);
            if (!options.guardians) return error("guardians_unavailable", 503);
            // The path alone names the guardian; a claim request carries no client input to parse.
            return await options.guardians(request, getAddress(owner).toLowerCase() as Address, null);
        }
        if (outingPath) {
            if (request.method !== "POST" && !(path === "/api/arcade/profile/outings" && request.method === "GET")) return error("method_not_allowed", 405);
            const window = Math.floor(now / 60_000), until = (window + 1) * 60_000;
            if (!await repo.rateLimit(`outings:${owner}:${request.method}:${window}`, until, request.method === "GET" ? 30 : 12)) return limited(until, now);
            if (await repo.rateLimit(`cleanup:${window}`, until, 1)) await repo.cleanup(now);
            if (!options.outings) return error("outings_unavailable", 503);
            return await options.outings(request, getAddress(owner).toLowerCase() as Address, request.method === "GET" ? null : await body(request, 65_536));
        }
        if (path !== "/api/arcade/profile/session" || request.method !== "GET") return error("method_not_allowed", 405);
        const until = (requestWindow + 1) * 60_000;
        if (!await repo.rateLimit(`session:${owner}:${requestWindow}`, until, 60)) return limited(until, now);
        if (await repo.rateLimit(`cleanup:${requestWindow}`, until, 1)) await repo.cleanup(now);
        return json({owner});
    } catch (e) {
        return error(e instanceof Error && e.message === "body_too_large" ? "body_too_large" : e instanceof SyntaxError ? "invalid_json" : "profile_unavailable", e instanceof Error && e.message === "body_too_large" ? 413 : e instanceof SyntaxError ? 400 : 503);
    }
}
