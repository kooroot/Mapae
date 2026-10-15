import {beforeEach, describe, expect, test} from "bun:test";
import type {Hex} from "viem";
import type {RankedCard, SeasonCard, SeasonStanding} from "@mapae/arcade/ranking";
import {shareApi, type ShareDependencies} from "./api";
import {CARD_REVISION} from "./card";
import {decodePng, encodePng} from "./png";
import {createBitmap, rgb} from "./raster";

const SEED = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const receiptToken = "r".repeat(40), now = Date.parse("2026-10-14T03:00:00Z"), season = {id: 1, start: "2026-10-05", end: "2026-11-01"};
const standing: SeasonStanding = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};
const ranked = (day = "2026-10-14"): RankedCard => ({game: "race", day, tokenId: "407", seed: SEED, score: 12_340, rank: 3, entrants: 41, leader: 15_000, final: day < "2026-10-14", season: standing});
const seasonCard = (phase: "open" | "closed" = "open"): SeasonCard =>
    ({tokenId: "407", seed: SEED, status: {id: 1, start: season.start, end: season.end, today: phase === "open" ? "2026-10-14" : "2026-11-03", phase}, season: standing});
const stubPng = await encodePng(createBitmap(32, 32, rgb("#5a8a7a")));

function memoryCache() {
    const entries = new Map<string, Response>();
    const cache = {async match(key: Request) {return entries.get(key.url)?.clone();}, async put(key: Request, value: Response) {entries.set(key.url, value);}} as unknown as Cache;
    return {entries, cache};
}
function setup(answer: (path: string) => Response | Promise<Response> = path => Response.json(path.startsWith("/card/season/") ? seasonCard() : ranked(path.split("/")[3])), overrides: Partial<ShareDependencies> = {}) {
    const calls: string[] = [], assetCalls: string[] = [], limits: string[] = [], {entries, cache} = memoryCache();
    const deps: ShareDependencies = {
        receiptToken, now, cache: Promise.resolve(cache), season, base: "https://mapae.io",
        fetcher: async url => {calls.push(url); return answer(url.replace("https://seller.mapae.io/arcade/ranking", ""));},
        assets: {async fetch(request) {assetCalls.push(new URL(request.url).pathname); return new Response(stubPng.slice(), {headers: {"Content-Type": "image/png"}});}},
        rateLimit: async bucket => {limits.push(bucket); return true;},
        ...overrides,
    };
    return {deps, calls, assetCalls, limits, entries};
}
const get = (path: string, deps: ShareDependencies, init: RequestInit = {}, origin = "https://mapae.io") => shareApi(new Request(`${origin}${path}`, {headers: {"CF-Connecting-IP": "203.0.113.9"}, ...init}), deps);
const CARD = "/api/arcade/share/g/407/race/2026-10-14/card.png", PAGE = "/share/g/407/race/2026-10-14";

describe("share card image", () => {
    test("draws a validated round as a cached PNG with an ETag, and serves HEAD and the cache without the seller", async () => {
        const {deps, calls, assetCalls, entries, limits} = setup();
        const response = await get(CARD, deps);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.get("ETag")).toBe(`"card-407-race-2026-10-14-12340-3-41-187-2-${CARD_REVISION}"`);
        const png = await decodePng(new Uint8Array(await response.arrayBuffer()));
        expect(png.width).toBe(1200); expect(png.height).toBe(630);
        expect(calls).toEqual(["https://seller.mapae.io/arcade/ranking/card/race/2026-10-14/407"]);
        expect(limits).toHaveLength(1); expect(limits[0]).toStartWith("ranking-ip:");
        expect([...entries.keys()]).toEqual([`https://mapae.io${CARD}?card=${CARD_REVISION}`]);
        expect(new Set(assetCalls).size).toBe(assetCalls.length); expect(assetCalls.every(p => p.startsWith("/arcade/share/") && p.endsWith(".png"))).toBe(true);
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
        const closed = setup(() => Response.json(seasonCard("closed")), {now: Date.parse("2026-11-03T03:00:00Z")});
        expect((await get("/api/arcade/share/s/407/card.png", closed.deps)).headers.get("Cache-Control")).toBe("public, max-age=300");
        const open = await get("/api/arcade/share/s/407/card.png", setup().deps);
        expect(open.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(open.headers.get("ETag")).toBe(`"card-407-season-187-2-212-${CARD_REVISION}"`);
    });
    test("a malformed, future, too-old or queried path is not there; another method is not allowed", async () => {
        const {deps, calls} = setup();
        for (const path of ["/api/arcade/share/g/0/race/2026-10-14/card.png", "/api/arcade/share/g/407/chess/2026-10-14/card.png", "/api/arcade/share/g/407/race/2026-02-30/card.png",
            "/api/arcade/share/g/407/race/2026-10-15/card.png", "/api/arcade/share/g/407/race/2025-10-13/card.png", `${CARD}?ref=share`, "/api/arcade/share/g/407/race/2026-10-14/card.svg",
            "/api/arcade/share/s/100000/card.png"]) {
            const response = await get(path, deps);
            expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
        }
        expect((await get("/api/arcade/share/g/407/race/2025-10-14/card.png", deps)).status).toBe(200);
        const post = await get(CARD, deps, {method: "POST"});
        expect(post.status).toBe(405); expect(post.headers.get("Allow")).toBe("GET, HEAD");
        expect(calls).toHaveLength(1);
    });
    test("no token, a seller outage, a tampered answer, a missing layer or a spent budget never draw a card", async () => {
        expect((await get(CARD, setup(undefined, {receiptToken: "short"}).deps)).status).toBe(503);
        const down = await get(CARD, setup(() => new Response("nope", {status: 500})).deps);
        expect(down.status).toBe(503); expect(down.headers.get("Retry-After")).toBe("5"); expect(down.headers.get("Cache-Control")).toBe("no-store");
        expect((await get(CARD, setup(() => Response.json({...ranked(), rank: 99})).deps)).status).toBe(503);
        expect((await get(CARD, setup(() => Response.json({...ranked(), tokenId: "408"})).deps)).status).toBe(503);
        expect((await get(CARD, setup(() => Response.json(ranked("2026-10-13"))).deps)).status).toBe(503);
        // Decoded layers stay with the isolate per origin, so a fresh origin is what reaches the failing asset store.
        expect((await get(CARD, setup(undefined, {assets: {async fetch() {return new Response(null, {status: 404});}}}).deps, {}, "https://app.mapae.io")).status).toBe(503);
        const limited = await get(CARD, setup(undefined, {rateLimit: async () => false}).deps);
        expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
        const missing = await get(CARD, setup(() => new Response(null, {status: 404})).deps);
        expect(missing.status).toBe(404); expect(missing.headers.get("Cache-Control")).toBe("public, max-age=30");
    });
});

describe("share page", () => {
    let html: string, response: Response;
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
    });
});
