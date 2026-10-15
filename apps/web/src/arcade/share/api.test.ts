import {beforeEach, describe, expect, test} from "bun:test";
import type {Hex} from "viem";
import type {RankedCard, SeasonCard, SeasonStanding} from "@mapae/arcade/ranking";
import {CARD_REVISION} from "@mapae/arcade/share-card/contract";
import {decodePng, encodePng} from "@mapae/arcade/share-card/png";
import {shareApi, type ShareDependencies} from "./api";
import {escapeHtml} from "./page";

const SEED = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const receiptToken = "r".repeat(40), now = Date.parse("2026-10-14T03:00:00Z"), season = {id: 1, start: "2026-10-05", end: "2026-11-01"};
const standing: SeasonStanding = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};
const ranked = (day = "2026-10-14"): RankedCard => ({game: "race", day, tokenId: "407", seed: SEED, score: 12_340, rank: 3, entrants: 41, leader: 15_000, final: day < "2026-10-14", season: standing});
const seasonCard = (phase: "open" | "closed" = "open"): SeasonCard =>
    ({tokenId: "407", seed: SEED, status: {id: 1, start: season.start, end: season.end, today: phase === "open" ? "2026-10-14" : "2026-11-03", phase}, season: standing});
/** What the seller answers on `/png`: a card-sized PNG with its tag and the cache life its facts call for; tests that break one of them say so. */
const cardPng = await encodePng({width: 1200, height: 630, data: new Uint8ClampedArray(1200 * 630 * 4)});
const tinyPng = await encodePng({width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4)});
const etag = (card: RankedCard | SeasonCard) => "game" in card
    ? `"card-${card.tokenId}-${card.game}-${card.day}-${card.score}-${card.rank}-${card.entrants}-${card.season?.points ?? "-"}-${card.season?.rank ?? "-"}-${CARD_REVISION}"`
    : `"card-${card.tokenId}-season-${card.season.points}-${card.season.rank}-${card.season.entrants}-${CARD_REVISION}"`;
const png = (card: RankedCard | SeasonCard, headers: Record<string, string> = {}, body: BodyInit = cardPng.slice()) => new Response(body, {headers: {
    "Content-Type": "image/png", ETag: etag(card), "Cache-Control": ("game" in card ? card.final : card.status.phase === "closed") ? "public, max-age=3600" : "public, max-age=60", ...headers,
}});
const cardOf = (path: string) => path.startsWith("/card/season/") ? seasonCard() : ranked(path.split("/")[3]);

function memoryCache() {
    const entries = new Map<string, Response>();
    const cache = {async match(key: Request) {return entries.get(key.url)?.clone();}, async put(key: Request, value: Response) {entries.set(key.url, value);}} as unknown as Cache;
    return {entries, cache};
}
function setup(answer: (path: string) => Response | Promise<Response> = path => path.endsWith("/png") ? png(cardOf(path)) : Response.json(cardOf(path)), overrides: Partial<ShareDependencies> = {}) {
    const calls: string[] = [], limits: string[] = [], {entries, cache} = memoryCache();
    const deps: ShareDependencies = {
        receiptToken, now, cache: Promise.resolve(cache), season, base: "https://mapae.io",
        fetcher: async url => {calls.push(url); return answer(url.replace("https://seller.mapae.io/arcade/ranking", ""));},
        rateLimit: async bucket => {limits.push(bucket); return true;},
        ...overrides,
    };
    return {deps, calls, limits, entries};
}
const get = (path: string, deps: ShareDependencies, init: RequestInit = {}, origin = "https://mapae.io") => shareApi(new Request(`${origin}${path}`, {headers: {"CF-Connecting-IP": "203.0.113.9"}, ...init}), deps);
const CARD = "/api/arcade/share/g/407/race/2026-10-14/card.png", PAGE = "/share/g/407/race/2026-10-14";

describe("share card image", () => {
    test("stores the seller's card as a cached PNG with its ETag, and serves HEAD and the cache without the seller", async () => {
        const {deps, calls, entries, limits} = setup();
        const response = await get(CARD, deps);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.get("ETag")).toBe(`"card-407-race-2026-10-14-12340-3-41-187-2-${CARD_REVISION}"`);
        const png = await decodePng(new Uint8Array(await response.arrayBuffer()));
        expect(png.width).toBe(1200); expect(png.height).toBe(630);
        expect(calls).toEqual(["https://seller.mapae.io/arcade/ranking/card/race/2026-10-14/407/png"]);
        expect(limits).toHaveLength(1); expect(limits[0]).toStartWith("ranking-ip:");
        expect([...entries.keys()]).toEqual([`https://mapae.io${CARD}?card=${CARD_REVISION}`]);
        const head = await get(CARD, deps, {method: "HEAD"});
        expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(head.headers.get("ETag")).toBe(response.headers.get("ETag"));
        expect(calls).toHaveLength(1);
    });
    test("a settled day lives an hour at the edge and five minutes in the browser; a live one a minute everywhere", async () => {
        const {deps, entries} = setup();
        const past = "/api/arcade/share/g/407/race/2026-10-13/card.png", response = await get(past, deps);
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
        expect(entries.get(`https://mapae.io${past}?card=${CARD_REVISION}`)?.headers.get("Cache-Control")).toBe("public, max-age=3600");
        expect((await get(past, deps)).headers.get("Cache-Control")).toBe("public, max-age=300");
        const closed = setup(() => png(seasonCard("closed")), {now: Date.parse("2026-11-03T03:00:00Z")});
        expect((await get("/api/arcade/share/s/407/card.png", closed.deps)).headers.get("Cache-Control")).toBe("public, max-age=300");
        const open = await get("/api/arcade/share/s/407/card.png", setup().deps);
        expect(open.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(open.headers.get("ETag")).toBe(`"card-407-season-187-2-212-${CARD_REVISION}"`);
    });
    test("a malformed, future, too-old or queried path is not there; another method is not allowed", async () => {
        const {deps, calls} = setup();
        for (const path of ["/api/arcade/share/g/0/race/2026-10-14/card.png", "/api/arcade/share/g/407/chess/2026-10-14/card.png", "/api/arcade/share/g/407/race/2026-02-30/card.png",
            "/api/arcade/share/g/407/race/2026-10-15/card.png", "/api/arcade/share/g/407/race/2025-10-13/card.png", `${CARD}?ref=share`, "/api/arcade/share/g/407/race/2026-10-14/card.svg",
            "/api/arcade/share/s/100000/card.png", "/api/arcade/share/s/10001/card.png", "/api/arcade/share/g/99999/race/2026-10-14/card.png"]) {
            const response = await get(path, deps);
            expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
        }
        expect((await get("/api/arcade/share/g/407/race/2025-10-14/card.png", deps)).status).toBe(200);
        const post = await get(CARD, deps, {method: "POST"});
        expect(post.status).toBe(405); expect(post.headers.get("Allow")).toBe("GET, HEAD");
        expect(calls).toHaveLength(1);
    });
    test("no token, a seller outage, an answer that is not a card of ours or a spent budget never serve a card", async () => {
        expect((await get(CARD, setup(undefined, {receiptToken: "short"}).deps)).status).toBe(503);
        const down = await get(CARD, setup(() => new Response("nope", {status: 500})).deps);
        expect(down.status).toBe(503); expect(down.headers.get("Retry-After")).toBe("5"); expect(down.headers.get("Cache-Control")).toBe("no-store");
        // Not a PNG, too large by its header or by its body, not card-sized, no card tag, another card's tag, or a cache life the seller may not ask for.
        for (const answer of [
            () => png(ranked(), {"Content-Type": "text/html"}), () => Response.json(ranked()), () => png(ranked(), {"Content-Length": String(3 * 1024 * 1024)}),
            () => png(ranked(), {}, new Uint8Array(2 * 1024 * 1024 + 1)), () => png(ranked(), {}, tinyPng.slice()), () => png(ranked(), {}, new TextEncoder().encode("<svg/>")),
            () => png(ranked(), {ETag: ""}), () => png(ranked(), {ETag: 'W/"card-407"'}), () => png(ranked(), {ETag: '"card-407"; evil'}), () => png(ranked(), {"Cache-Control": "public, max-age=86400"}),
            () => png(ranked(), {"Cache-Control": "no-store"}), () => png(ranked("2026-10-13")), () => png(seasonCard()), () => png({...ranked(), tokenId: "408"}),
        ]) {
            const response = await get(CARD, setup(answer).deps);
            expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("5");
        }
        const limited = await get(CARD, setup(undefined, {rateLimit: async () => false}).deps);
        expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
        const missing = await get(CARD, setup(() => new Response(null, {status: 404})).deps);
        expect(missing.status).toBe(404); expect(missing.headers.get("Cache-Control")).toBe("public, max-age=30");
    });
    test("the seller's headers are read, not passed through: the stored card carries the Worker's own headers and the tag", async () => {
        const {deps, entries} = setup(() => png(ranked(), {"X-Seller": "leak", Server: "bun", "Content-Security-Policy": "default-src *"}));
        const response = await get(CARD, deps), stored = entries.get(`https://mapae.io${CARD}?card=${CARD_REVISION}`)!;
        expect(response.status).toBe(200);
        for (const r of [response, stored]) {
            expect(r.headers.get("X-Seller")).toBeNull(); expect(r.headers.get("Server")).toBeNull();
            expect(r.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
            expect(r.headers.get("ETag")).toBe(`"card-407-race-2026-10-14-12340-3-41-187-2-${CARD_REVISION}"`);
        }
        expect(stored.headers.get("Cache-Control")).toBe("public, max-age=60");
    });
});

describe("share page", () => {
    let html: string, response: Response;
    test("every string the page carries goes through one escape, whatever a name or story might one day hold", () => {
        expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;");
        expect(html.match(/<(script|style|iframe|object|svg)/)).toBeNull(); expect(html).not.toMatch(/ on[a-z]+=/);
    });
    beforeEach(async () => {response = await get(`/ko${PAGE}`, setup().deps); html = await response.text();});
    test("carries the card as og:image with the guardian's copy in the page's own language, and nothing that runs", () => {
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'; img-src 'self'; style-src 'self'");
        expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
        expect(html).toStartWith('<!doctype html><html lang="ko">');
        expect(html).toContain("<title>장난스러운 감돌이 · 달려라 마패 12,340점 · Mapae Arcade</title>");
        expect(html).toContain(`<meta property="og:image" content="https://mapae.io${CARD}">`);
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
        expect(html).toContain('<meta name="robots" content="noindex, follow">');
        expect(html).toContain(`<link rel="canonical" href="https://mapae.io/ko${PAGE}">`);
        expect(html).toContain(`<link rel="alternate" hreflang="en" href="https://mapae.io${PAGE}">`);
        expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="https://mapae.io${PAGE}">`);
        expect(html).toContain("오늘 3위/41명 · 시즌 1 187점 2위 · 기세 좋게 앞장서는 산골 수호대장. GIWA Sepolia 테스트넷 오락실, @mapae_io");
        expect(html).toContain(`<img class="share-card" src="${CARD}"`);
        expect(html).toContain('href="/ko/arcade">아케이드 열기</a>');
        expect(html).toContain('href="https://x.com/intent/follow?screen_name=mapae_io" rel="noopener noreferrer">@mapae_io 팔로우</a>');
        expect(html).toContain('<link rel="stylesheet" href="/share.css">');
        expect(html).not.toContain("<script"); expect(html).not.toContain("style="); expect(html).not.toContain("<style");
    });
    test("the English page, the season page and HEAD", async () => {
        const en = await (await get(PAGE, setup().deps)).text();
        expect(en).toContain('<html lang="en">'); expect(en).toContain("<title>Playful Gamdori · Auto Race 12,340 pts · Mapae Arcade</title>");
        expect(en).toContain("#3 of 41 today · Season 1 187 pts, #2 · A spirited guardian of the mountain paths.");
        expect(en).toContain('href="/arcade">Open the arcade</a>'); expect(en).toContain(`href="/ko${PAGE}" hreflang="ko">한국어</a>`);
        const past = await (await get("/ko/share/g/407/race/2026-10-13", setup().deps)).text();
        expect(past).toContain("10월 13일 3위/41명");
        const s = await (await get("/ko/share/s/407", setup().deps)).text();
        expect(s).toContain("<title>장난스러운 감돌이 · 시즌 1 187점 · Mapae Arcade</title>"); expect(s).toContain("시즌 1 2위/212명 · 9일 참가 · 연속 9일");
        expect(s).toContain('<meta property="og:image" content="https://mapae.io/api/arcade/share/s/407/card.png">');
        const head = await get(`/ko${PAGE}`, setup().deps, {method: "HEAD"});
        expect(head.status).toBe(200); expect(head.body).toBeNull();
    });
    test("a card that is not there or cannot be fetched gets a page of its own, cached only when the seller said so", async () => {
        const missing = await get(`/ko${PAGE}`, setup(() => new Response(null, {status: 404})).deps), text = await missing.text();
        expect(missing.status).toBe(404); expect(missing.headers.get("Cache-Control")).toBe("public, max-age=30");
        expect(text).toContain("이 카드는 없어요"); expect(text).toContain('href="/ko/arcade">아케이드 열기</a>'); expect(text).not.toContain("<script");
        const down = await get(PAGE, setup(() => new Response(null, {status: 502})).deps);
        expect(down.status).toBe(503); expect(down.headers.get("Retry-After")).toBe("5"); expect(down.headers.get("Cache-Control")).toBe("no-store");
        expect(await down.text()).toContain("Try again in a moment");
        const odd = await get("/ko/share/g/407/race/2026-10-14/extra", setup().deps);
        expect(odd.status).toBe(404); expect(await odd.text()).toContain("이 카드는 없어요");
        expect((await get(`${PAGE}?utm_source=x`, setup().deps)).status).toBe(404);
        expect((await get("/share/s/407", setup(() => Response.json({...seasonCard(), status: {...seasonCard().status, phase: "announced", today: "2026-10-01"}})).deps)).status).toBe(503);
        // Before a season has a board the reader answers 400: no season card exists yet, so the page says so rather than asking back soon.
        const early = await get("/ko/share/s/407", setup(() => Response.json({error: {code: "invalid_request"}}, {status: 400})).deps);
        expect(early.status).toBe(404); expect(early.headers.get("Cache-Control")).toBe("public, max-age=30"); expect(await early.text()).toContain("이 카드는 없어요");
        const earlyCard = await get("/api/arcade/share/s/407/card.png", setup(() => Response.json({error: {code: "invalid_request"}}, {status: 400})).deps);
        expect(earlyCard.status).toBe(404); expect(earlyCard.headers.get("Cache-Control")).toBe("public, max-age=30");
        expect((await get(CARD, setup(() => Response.json({error: {code: "invalid_request"}}, {status: 400})).deps)).status).toBe(503);
    });
});
