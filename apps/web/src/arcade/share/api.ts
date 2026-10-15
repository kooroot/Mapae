import type {GameId} from "@mapae/arcade";
import {daysBetween, isRankingDay, kstDay, validRankingTokenId, type RankedCard, type SeasonCard} from "@mapae/arcade/ranking";
import {SEASON, type Season} from "@mapae/arcade/season";
import {landingUrl} from "../../lib/config";
import type {Locale} from "../../lib/i18n";
import {DOCUMENT_SECURITY_HEADERS} from "../../lib/security";
import {CARD_HEIGHT, CARD_REVISION, CARD_WIDTH} from "@mapae/arcade/share-card/contract";
import {hasReceiptToken, ipBudget, UpstreamError, upstreamBytes, upstreamJson, type UpstreamDependencies} from "../ranking/upstream";
import {parseRankedCard, parseSeasonCard} from "./data";
import {shareFallbackPage, sharePage, type ShareTarget} from "./page";

export type ShareDependencies = UpstreamDependencies & {
    /** The edge cache; absent where the runtime has none. */
    cache?: Promise<Cache>;
    /** The season the card must answer to; tests inject one. */
    season?: Season;
    /** The absolute origin pages name themselves and their card by; the landing site unless a test says otherwise. */
    base?: string;
};

const CARD_PATH = /^\/api\/arcade\/share\/g\/([1-9][0-9]{0,4})\/(stamp|race|shop)\/(\d{4}-\d{2}-\d{2})\/card\.png$/;
const SEASON_CARD_PATH = /^\/api\/arcade\/share\/s\/([1-9][0-9]{0,4})\/card\.png$/;
const PAGE_PATH = /^(\/ko)?\/share\/g\/([1-9][0-9]{0,4})\/(stamp|race|shop)\/(\d{4}-\d{2}-\d{2})$/;
const SEASON_PAGE_PATH = /^(\/ko)?\/share\/s\/([1-9][0-9]{0,4})$/;
/** How far back a day card reaches: the reader keeps a year of boards. */
const DAYS_BACK = 365;
/** A card PNG from the seller is a few hundred KB; anything near this is not one. */
const CARD_LIMIT = {type: "image/png", maxBytes: 2 * 1024 * 1024};
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** The seller's ETag is stored and echoed, so it must be this card's tag — its token, game and day, or its season — and nothing else. */
const CARD_TAG = /^"card-[0-9a-z-]{1,80}"$/;
const cardTagPrefix = (target: ShareTarget) => `"card-${target.tokenId}-${target.kind === "run" ? `${target.game}-${target.day}` : "season"}-`;
/** A settled day or a closed season never changes; the edge keeps it an hour and browsers five minutes. A live board turns every minute. */
const SETTLED = {edge: "public, max-age=3600", client: "public, max-age=300"}, LIVE = "public, max-age=60";
const IMAGE_HEADERS = {"Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Access-Control-Allow-Origin": "*"};
const PAGE_HEADERS = {
    ...DOCUMENT_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const error = (status: number, extra: Record<string, string> = {}) => new Response(null, {status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra}});

/**
 * The seller's PNG, admitted only as the card that was asked for: a PNG of the card's size, the tag of this target and one of
 * the two cache lives the seller may ask for. Headers are read here and never passed through.
 */
function cardImage(bytes: Uint8Array, headers: Headers, target: ShareTarget): {tag: string; settled: boolean} | null {
    if (bytes.length < 24 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(16) !== CARD_WIDTH || view.getUint32(20) !== CARD_HEIGHT) return null;
    const tag = headers.get("ETag"), life = headers.get("Cache-Control");
    if (!tag || !CARD_TAG.test(tag) || !tag.startsWith(cardTagPrefix(target)) || (life !== SETTLED.edge && life !== LIVE)) return null;
    return {tag, settled: life === SETTLED.edge};
}

/** What a path asks for: a target, and the page's locale when it is a page rather than its card. */
function parse(pathname: string): {target: ShareTarget; page: Locale | null} | null {
    const card = CARD_PATH.exec(pathname), season = SEASON_CARD_PATH.exec(pathname), page = PAGE_PATH.exec(pathname), seasonPage = SEASON_PAGE_PATH.exec(pathname);
    if (card) return {target: {kind: "run", tokenId: card[1]!, game: card[2] as GameId, day: card[3]!}, page: null};
    if (season) return {target: {kind: "season", tokenId: season[1]!}, page: null};
    if (page) return {target: {kind: "run", tokenId: page[2]!, game: page[3] as GameId, day: page[4]!}, page: page[1] ? "ko" : "en"};
    if (seasonPage) return {target: {kind: "season", tokenId: seasonPage[2]!}, page: seasonPage[1] ? "ko" : "en"};
    return null;
}

/**
 * Share cards and their landing pages: the seller-drawn PNG for the og:image and a script-free page around it. The page is
 * built from a validated copy of the seller's facts and the PNG is admitted only as a card of the right shape; hits come from
 * the edge cache, and a miss spends the same per-IP budget as the ranking proxy and one bearer call. Drawing stays on the
 * seller so this Worker fits the Free plan's CPU budget.
 */
export async function shareApi(request: Request, deps: ShareDependencies): Promise<Response> {
    const url = new URL(request.url), parsed = parse(url.pathname), locale: Locale = url.pathname.startsWith("/ko/") ? "ko" : "en";
    const page = (status: 404 | 503, cacheControl: string, extra: Record<string, string> = {}) =>
        new Response(request.method === "HEAD" ? null : shareFallbackPage(status, locale), {status, headers: {...PAGE_HEADERS, "Cache-Control": cacheControl, ...extra}});
    const missing = (cacheControl = "no-store") => parsed?.page ? page(404, cacheControl) : error(404, {"Cache-Control": cacheControl});
    const unavailable = () => parsed?.page ? page(503, "no-store", {"Retry-After": "5"}) : error(503, {"Retry-After": "5"});
    if (!parsed || url.search) return url.pathname.startsWith("/api/") ? error(404) : page(404, "no-store");
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, {Allow: "GET, HEAD"});
    const {target} = parsed, now = deps.now ?? Date.now(), today = kstDay(now), season = deps.season ?? SEASON;
    // A token past the supply, or a day outside the year of boards, is not there — the seller is never asked.
    if (!validRankingTokenId(target.tokenId)) return missing();
    if (target.kind === "run" && (!isRankingDay(target.day) || target.day > today || daysBetween(target.day, today) > DAYS_BACK)) return missing();
    if (!hasReceiptToken(deps)) return unavailable();
    const key = new Request(`${url.origin}${url.pathname}?card=${CARD_REVISION}`), cache = deps.cache ? await deps.cache.catch(() => undefined) : undefined;
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return served(hit, request.method);
    const retryAfter = await ipBudget(request, deps);
    if (retryAfter !== null) return error(429, {"Retry-After": String(retryAfter)});
    const path = target.kind === "run" ? `/card/${target.game}/${target.day}/${target.tokenId}` : `/card/season/${target.tokenId}`;
    let stored: Response, client: string;
    try {
        if (parsed.page) {
            const upstream = await upstreamJson(path, deps);
            if (!upstream.found) return missing("public, max-age=30");
            const card: RankedCard | SeasonCard | null = target.kind === "run" ? parseRankedCard(upstream.value, target.game, target.day, target.tokenId, today) : parseSeasonCard(upstream.value, target.tokenId, season);
            if (!card) return unavailable();
            stored = new Response(sharePage(target, card, parsed.page, (deps.base ?? landingUrl).replace(/\/$/, "")), {headers: {...PAGE_HEADERS, "Cache-Control": LIVE}});
            client = LIVE;
        } else {
            const upstream = await upstreamBytes(`${path}/png`, deps, CARD_LIMIT);
            if (!upstream.found) return missing("public, max-age=30");
            const card = cardImage(upstream.bytes, upstream.headers, target);
            if (!card) return unavailable();
            stored = new Response(upstream.bytes, {headers: {...IMAGE_HEADERS, ETag: card.tag, "Cache-Control": card.settled ? SETTLED.edge : LIVE}});
            client = card.settled ? SETTLED.client : LIVE;
        }
    } catch (failure) {
        // The reader refuses a season card outright while no season board exists: there is no card, not a fault.
        if (target.kind === "season" && failure instanceof UpstreamError && failure.status === 400) return missing("public, max-age=30");
        return unavailable();
    }
    await cache?.put(key, stored.clone()).catch(() => {/* A cold cache only costs the next visitor one seller call. */});
    const headers = new Headers(stored.headers); headers.set("Cache-Control", client);
    return new Response(request.method === "HEAD" ? null : stored.body, {headers});
}
/** A cached copy, with the browser's own cache life and no body for HEAD. */
function served(hit: Response, method: string): Response {
    const headers = new Headers(hit.headers);
    if (headers.get("Cache-Control") === SETTLED.edge) headers.set("Cache-Control", SETTLED.client);
    return new Response(method === "HEAD" ? null : hit.body, {status: hit.status, headers});
}
