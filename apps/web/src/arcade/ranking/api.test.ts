import {afterEach, describe, expect, test} from "bun:test";
import type {Hex} from "viem";
import {ARCADE_RULESET_VERSION} from "@mapae/arcade";
import {kstWeek, type RankingBoard, type RankingStanding, type RankingStandings} from "@mapae/arcade/ranking";
import {parseRankingBoard, parseRankingStandings, rankingApi, type RankingDependencies} from "./api";

const receiptToken = "ranking-receipt-token".repeat(3), now = Date.parse("2026-10-14T03:00:00Z");
const origin = "https://app.mapae.io/api/arcade/ranking";
const seedOf = (tokenId: string) => `0x${tokenId.padStart(64, "0")}` as Hex;
const rowOf = (rank: number, tokenId = String(rank), score = 100 - rank) => ({rank, tokenId, seed: seedOf(tokenId), score});
const board = (rows: RankingBoard["rows"] = [{...rowOf(1), prev: 2}, {...rowOf(2), prev: null}], moves = true): RankingBoard =>
    ({board: "race", period: "today", from: "2026-10-14", to: "2026-10-14", closesAt: now + 1000, entrants: rows.length, moves, rows});
const still = (...rows: ReturnType<typeof rowOf>[]) => rows.map(r => ({...r, prev: null}));
const empty = {attemptsUsed: 0, today: null, week: null};
function standings(): RankingStandings {
    return {day: "2026-10-14", week: "2026-10-12", closesAt: {day: now + 1000, week: now + 5000}, leaders: {stamp: null, race: 99, shop: null}, guardians: [{
        tokenId: "2", streak: {current: 2, best: 4, freezes: 0, playedToday: true}, devotion: {rank: 1, days: 6}, titles: [{game: "race", place: 3}],
        games: {stamp: empty, race: {attemptsUsed: 2, today: {rank: 2, score: 98, moves: true, prev: 5, entrants: 2, leader: 99, above: rowOf(1), nearby: [rowOf(1), rowOf(2)]}, week: null}, shop: empty},
    }]};
}
function memoryCache() {
    const entries = new Map<string, Response>();
    const cache = {
        async match(key: Request) {return entries.get(key.url)?.clone();},
        async put(key: Request, value: Response) {entries.set(key.url, value);},
    } as unknown as Cache;
    return {entries, cache};
}
function setup(answer: () => Response | Promise<Response> = () => Response.json(board()), overrides: Partial<RankingDependencies> = {}) {
    const calls: {url: string; init?: RequestInit}[] = [], limits: string[] = [], {entries, cache} = memoryCache();
    const deps: RankingDependencies = {receiptToken, now, cache: Promise.resolve(cache),
        fetcher: async (url, init) => {calls.push({url, init}); return answer();},
        rateLimit: async bucket => {limits.push(bucket); return limits.filter(b => b === bucket).length <= 120;}, ...overrides};
    return {calls, limits, entries, call: (path: string, init: RequestInit = {}) => rankingApi(new Request(origin + path, init), deps)};
}

describe("public ranking proxy", () => {
    test("exact paths, GET only, no query, and only sorted unique ids reach the seller", async () => {
        const {calls, call} = setup();
        expect((await call("/board/race/today", {method: "POST"})).status).toBe(405);
        for (const path of ["/board/race/today?x=1", "/board/xp/today", "/board/devotion/today", "/board/race/28d", "/guardians/2,1", "/guardians/1,1", "/guardians/1,2,3,4", "/guardians/0", "/guardians/10001"])
            expect((await call(path)).status).toBe(400);
        for (const path of ["/board/race", "/guardians", "/board/race/today/extra", "/../profile/session"]) expect((await call(path)).status).toBe(404);
        expect(calls).toHaveLength(0);
        const ok = await call("/board/race/today", {headers: {Cookie: "__Host-mapae-arcade-session=" + "a".repeat(64), Origin: "https://evil.test"}});
        expect(ok.status).toBe(200); expect(ok.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(calls[0]!.url).toBe("https://seller.mapae.io/arcade/ranking/board/race/today");
        expect(calls[0]!.init?.redirect).toBe("manual");
        expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe(`Bearer ${receiptToken}`);
        expect(new Headers(calls[0]!.init?.headers).has("Cookie")).toBe(false); expect(new Headers(calls[0]!.init?.headers).has("X-Mapae-Owner")).toBe(false);
    });
    test("a miss is cached with its max-age; a hit skips both the seller and the rate limit", async () => {
        const {calls, limits, entries, call} = setup(() => Response.json(board()));
        const first = await call("/board/race/today", {headers: {"CF-Connecting-IP": "203.0.113.9"}});
        expect(first.headers.get("Cache-Control")).toBe("public, max-age=30"); expect(first.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
        expect(entries.has("https://app.mapae.io/api/arcade/ranking/board/race/today")).toBe(true);
        expect(await (await call("/board/race/today", {headers: {"CF-Connecting-IP": "203.0.113.9"}})).json<unknown>()).toEqual(board());
        expect(calls).toHaveLength(1); expect(limits).toHaveLength(1); expect(limits[0]).not.toContain("203.0.113.9");
        const standing = setup(() => Response.json(standings()));
        expect((await standing.call("/guardians/2")).headers.get("Cache-Control")).toBe("public, max-age=10");
    });
    test("past 120 misses a minute from one address, callers wait", async () => {
        const {calls, call} = setup(() => Response.json(board()), {cache: undefined});
        for (let i = 0; i < 120; i++) await call("/board/race/today", {headers: {"CF-Connecting-IP": "198.51.100.4"}});
        const limited = await call("/board/race/today", {headers: {"CF-Connecting-IP": "198.51.100.4"}});
        expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0); expect(calls).toHaveLength(120);
    });
    test("no token, seller errors, redirects, oversize and malformed answers are 503 and never cached", async () => {
        expect((await setup().call("/board/race/today", {})).status).toBe(200);
        expect((await rankingApi(new Request(origin + "/board/race/today"), {rateLimit: async () => true})).status).toBe(503);
        for (const answer of [() => new Response(null, {status: 302, headers: {Location: "https://evil.test"}}), () => Response.json({error: {code: "disabled"}}, {status: 503}),
            () => new Response("{}", {headers: {"Content-Length": String(65 * 1024)}}), () => new Response(`{"x":"${"a".repeat(70_000)}"}`), () => new Response("not json"),
            () => Response.json({...board(), rows: still(rowOf(2))})]) {
            const {entries, call} = setup(answer);
            const response = await call("/board/race/today");
            expect(response.status).toBe(503); expect(await response.json<unknown>()).toEqual({error: {code: "ranking_unavailable"}}); expect(entries.size).toBe(0);
        }
    });
});

describe("strict copies", () => {
    test("boards: well-formed ranks, seeds, scores and counts; unknown fields dropped", () => {
        const extra = {...board(), owner: "0x1111111111111111111111111111111111111111", rows: [{...rowOf(1), prev: 2, actor: "x"}, {...rowOf(2), prev: null}]};
        expect(parseRankingBoard(extra, "race", "today")).toEqual(board());
        expect(parseRankingBoard(board(still(rowOf(1)), false), "race", "today")?.moves).toBe(false);
        const bad: unknown[] = [
            {...board(), board: "shop"}, {...board(), period: "week"}, {...board(), from: "2026-10-15"}, {...board(), entrants: 1},
            {...board(), entrants: 5}, board(still(rowOf(1), rowOf(3))), board(still(rowOf(1), rowOf(2, "1"))), board(still(rowOf(1, "1", 1), rowOf(2, "2", 5))),
            board(still({...rowOf(1), seed: "0x12"})), board(still({...rowOf(1), score: 1_000_000_001})), board(still({...rowOf(1), tokenId: "01"})),
            {...board(still(...Array.from({length: 11}, (_, i) => rowOf(i + 1, String(i + 1), 50)))), entrants: 11}, {...board(), closesAt: -1},
            // Movement: a flag on every board, an earlier rank only while it compares, and a real place when given.
            {...board(), moves: undefined}, {...board(), moves: "yes"}, board([{...rowOf(1), prev: 2}], false),
            ...[undefined, 0, "2", 1.5, 10_001].map(prev => ({...board(), entrants: 1, rows: [{...rowOf(1), prev}]})),
        ];
        for (const value of bad) expect(parseRankingBoard(value, "race", "today")).toBeNull();
        const devotion = {board: "devotion", period: "28d", from: "2026-09-17", to: "2026-10-14", closesAt: null, entrants: 3, moves: false, rows: still(rowOf(1, "1", 5), rowOf(1, "2", 5), rowOf(3, "3", 2))};
        expect(parseRankingBoard(devotion, "devotion", "28d")?.rows.map(r => r.rank)).toEqual([1, 1, 3]);
        for (const rows of [still(rowOf(1, "1", 5), rowOf(2, "2", 5)), still(rowOf(1, "1", 5), rowOf(3, "2", 2)), still(rowOf(1, "1", 29))]) expect(parseRankingBoard({...devotion, rows, entrants: rows.length}, "devotion", "28d")).toBeNull();
    });
    test("standings: the requested guardians in order, with consistent ranks, attempts, streaks and titles", () => {
        expect(parseRankingStandings(standings(), ["2"])).toEqual(standings());
        const corrupt: ((s: RankingStandings) => void)[] = [
            s => {s.guardians[0]!.tokenId = "3";}, s => {s.guardians.push(s.guardians[0]!);}, s => {s.guardians[0]!.games.race.attemptsUsed = 4;},
            s => {s.guardians[0]!.games.race.attemptsUsed = 0;}, s => {s.guardians[0]!.games.race.today!.above = null;},
            s => {s.guardians[0]!.games.race.today!.nearby = [1, 2, 3, 4, 5, 6].map(n => rowOf(n));}, s => {s.guardians[0]!.games.race.today!.leader = 97;},
            s => {s.leaders.race = 120;}, s => {s.guardians[0]!.streak.freezes = 3;}, s => {s.guardians[0]!.streak.current = 5;},
            s => {s.guardians[0]!.devotion = {rank: null, days: 3};}, s => {s.guardians[0]!.titles.push({game: "race", place: 1});},
            s => {s.guardians[0]!.titles = [{game: "race", place: 11}];}, s => {delete (s.guardians[0]!.games as Partial<typeof s.guardians[0]["games"]>).shop;},
            s => {s.closesAt.week = s.closesAt.day - 1;}, s => {delete (s.guardians[0]!.games.race.today as Partial<RankingStanding>).moves;},
            s => {s.guardians[0]!.games.race.today!.moves = false;}, s => {s.guardians[0]!.games.race.today!.prev = 0;},
        ];
        for (const change of corrupt) {const value = standings(); change(value); expect(parseRankingStandings(value, ["2"])).toBeNull();}
    });
});

describe("real seller contract", () => {
    const stores: {close(): void}[] = [];
    afterEach(() => {for (const s of stores.splice(0)) s.close();});
    test("the seller's own boards and standings pass the proxy validator unchanged", async () => {
        const {OutingStore} = await import("../../../../delegated-seller/outings/store");
        const {RankingReader} = await import("../../../../delegated-seller/ranking/board");
        const {createRankingApp} = await import("../../../../delegated-seller/ranking/routes");
        const store = new OutingStore(":memory:"); stores.push(store);
        const collection = "0x5555555555555555555555555555555555555555" as const;
        const add = (tokenId: string, game: string, day: string, attempt: number, score: number) => store.db.query("INSERT INTO arcade_guardian_ranked VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(`${tokenId}:${game}:${day}:${attempt}`, collection, tokenId, seedOf(tokenId), ARCADE_RULESET_VERSION, game, day, kstWeek(day), attempt, score, 0, now - 1000 + Number(tokenId));
        for (let i = 1; i <= 14; i++) add(String(i), "race", "2026-10-14", 1, 500 - i * 3);
        add("12", "race", "2026-10-13", 1, 7); add("12", "shop", "2026-10-06", 1, 70); add("3", "stamp", "2026-10-01", 1, 9); add("4", "stamp", "2026-10-02", 1, 9);
        const app = createRankingApp({token: receiptToken, reader: new RankingReader(store, collection, () => now)});
        const fetcher = async (url: string, init?: RequestInit) => app.request(new Request(url.replace("https://seller.mapae.io/arcade/ranking", "https://seller.local"), init));
        const deps: RankingDependencies = {receiptToken, fetcher, rateLimit: async () => true, now};
        for (const path of ["/board/race/today", "/board/race/week", "/board/race/yesterday", "/board/shop/lastweek", "/board/stamp/today", "/board/devotion/28d", "/guardians/3,12,40"]) {
            const response = await rankingApi(new Request(origin + path), deps);
            expect(response.status).toBe(200);
        }
        const mine = await (await rankingApi(new Request(origin + "/guardians/12"), deps)).json() as RankingStandings;
        expect(mine.guardians[0]!.games.race.today).toMatchObject({rank: 12, entrants: 14, moves: true, prev: 1});
        const race = await (await rankingApi(new Request(origin + "/board/race/today"), deps)).json() as RankingBoard;
        expect(race.moves).toBe(true); expect(race.rows.map(r => r.prev)).toEqual(Array(10).fill(null)); expect(mine.guardians[0]!.streak).toMatchObject({current: 2});
    });
});
