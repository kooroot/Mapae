import type {GameId} from "@mapae/arcade";
import {daysBetween, isRankingDay, kstDay, type RankedCard, type SeasonCard} from "@mapae/arcade/ranking";
import {SEASON, type Season} from "@mapae/arcade/season";
import {landingUrl} from "../../lib/config";
import type {Locale} from "../../lib/i18n";
import {DOCUMENT_SECURITY_HEADERS} from "../../lib/security";
import {hasReceiptToken, ipBudget, upstreamJson, type UpstreamDependencies} from "../ranking/upstream";
import {CARD_REVISION, cardLayers, renderRankedCard, renderSeasonCard, shareLayerPath, type LayerImages} from "./card";
import {parseRankedCard, parseSeasonCard} from "./data";
import {decodePng, encodePng, type Bitmap} from "./png";
import {shareFallbackPage, sharePage, type ShareTarget} from "./page";

export type ShareDependencies = UpstreamDependencies & {
    assets: {fetch(request: Request): Promise<Response>};
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
const MAX_LAYER_BYTES = 512 * 1024;
/** A settled day or a closed season never changes; the edge keeps it an hour and browsers five minutes. A live board turns every minute. */
const SETTLED = {edge: "public, max-age=3600", client: "public, max-age=300"}, LIVE = "public, max-age=60";
const IMAGE_HEADERS = {"Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Access-Control-Allow-Origin": "*"};
const PAGE_HEADERS = {
    ...DOCUMENT_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const error = (status: number, extra: Record<string, string> = {}) => new Response(null, {status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra}});

/** Decoded layer PNGs stay with the isolate: a card costs the layers it draws once, not per request. */
const layers = new Map<string, Promise<Bitmap>>();
function layerImage(path: string, origin: string, assets: ShareDependencies["assets"]): Promise<Bitmap> {
    const href = new URL(path, origin).href, held = layers.get(href);
    if (held) return held;
    const loading = (async () => {
        const response = await assets.fetch(new Request(href, {signal: AbortSignal.timeout(10_000)}));
        if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/png") {await response.body?.cancel(); throw new Error("Share layer unavailable");}
        if (Number(response.headers.get("Content-Length") ?? 0) > MAX_LAYER_BYTES) {await response.body?.cancel(); throw new Error("Share layer exceeds limit");}
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_LAYER_BYTES) throw new Error("Share layer exceeds limit");
        return decodePng(bytes);
    })();
    layers.set(href, loading);
    loading.catch(() => layers.delete(href));
    return loading;
}
async function layerImages(seed: RankedCard["seed"], origin: string, assets: ShareDependencies["assets"]): Promise<LayerImages> {
    const sources = [...new Set(cardLayers(seed).map(layer => layer.src))];
    return new Map(await Promise.all(sources.map(async src => [src, await layerImage(shareLayerPath(src), origin, assets)] as const)));
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
 * Share cards and their landing pages: a Worker-drawn PNG for the og:image and a script-free page around it. Nothing but a
 * validated copy of the seller's answer is drawn, hits come from the edge cache, and a miss spends the same per-IP budget as
 * the ranking proxy and one bearer call.
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
    if (target.kind === "run" && (!isRankingDay(target.day) || target.day > today || daysBetween(target.day, today) > DAYS_BACK)) return missing();
    if (!hasReceiptToken(deps)) return unavailable();
    const key = new Request(`${url.origin}${url.pathname}?card=${CARD_REVISION}`), cache = deps.cache ? await deps.cache.catch(() => undefined) : undefined;
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return served(hit, request.method);
    const retryAfter = await ipBudget(request, deps);
    if (retryAfter !== null) return error(429, {"Retry-After": String(retryAfter)});
    let card: RankedCard | SeasonCard | null;
    try {
        const upstream = await upstreamJson(target.kind === "run" ? `/card/${target.game}/${target.day}/${target.tokenId}` : `/card/season/${target.tokenId}`, deps);
        if (!upstream.found) return missing("public, max-age=30");
        card = target.kind === "run" ? parseRankedCard(upstream.value, target.game, target.day, target.tokenId, today) : parseSeasonCard(upstream.value, target.tokenId, season);
    } catch {return unavailable();}
    if (!card) return unavailable();
    const settled = "game" in card ? card.final : card.status.phase === "closed";
    let stored: Response, client: string;
    if (parsed.page) {
        stored = new Response(sharePage(target, card, parsed.page, (deps.base ?? landingUrl).replace(/\/$/, "")), {headers: {...PAGE_HEADERS, "Cache-Control": LIVE}});
        client = LIVE;
    } else {
        let png: Uint8Array<ArrayBuffer>;
        try {
            const images = await layerImages(card.seed, url.origin, deps.assets);
            png = await encodePng("game" in card ? renderRankedCard(card, images) : renderSeasonCard(card, images));
        } catch {return unavailable();}
        const standing = "game" in card ? `${card.score}-${card.rank}-${card.entrants}-${card.season?.points ?? "-"}-${card.season?.rank ?? "-"}` : `${card.season.points}-${card.season.rank}-${card.season.entrants}`;
        const tag = `"card-${target.tokenId}-${target.kind === "run" ? `${target.game}-${target.day}` : "season"}-${standing}-${CARD_REVISION}"`;
        stored = new Response(png, {headers: {...IMAGE_HEADERS, ETag: tag, "Cache-Control": settled ? SETTLED.edge : LIVE}});
        client = settled ? SETTLED.client : LIVE;
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
