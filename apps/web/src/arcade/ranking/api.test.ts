import {afterEach, describe, expect, test} from "bun:test";
import type {Hex} from "viem";
import {ARCADE_RULESET_VERSION} from "@mapae/arcade";
import {kstWeek, type RankingBoard, type RankingPage, type RankingStanding, type RankingStandings, type SeasonStanding} from "@mapae/arcade/ranking";
import type {SeasonStatus} from "@mapae/arcade/season";
import {parseRankingBoard, parseRankingPage, parseRankingStandings, parseSeasonStatus, rankingApi, type RankingDependencies} from "./api";

const receiptToken = "ranking-receipt-token".repeat(3), now = Date.parse("2026-10-14T03:00:00Z");
const origin = "https://app.mapae.io/api/arcade/ranking";
const seedOf = (tokenId: string) => `0x${tokenId.padStart(64, "0")}` as Hex;
const rowOf = (rank: number, tokenId = String(rank), score = 100 - rank) => ({rank, tokenId, seed: seedOf(tokenId), score});
const board = (rows: RankingBoard["rows"] = [{...rowOf(1), prev: 2}, {...rowOf(2), prev: null}], moves = true): RankingBoard =>
    ({board: "race", period: "today", from: "2026-10-14", to: "2026-10-14", closesAt: now + 1000, entrants: rows.length, moves, rows});
const status = (phase: SeasonStatus["phase"] = "open"): SeasonStatus => phase === "pending" ? {id: 1, start: null, end: null, today: "2026-10-14", phase}
    : {id: 1, start: phase === "announced" ? "2026-10-19" : "2026-10-05", end: phase === "closed" ? "2026-10-13" : "2026-11-01", today: "2026-10-14", phase};
/** The season board nine days in: shared places, each row's days and run. */
const seasonRow = (rank: number, tokenId: string, score: number, days: number, streak = days, prev: number | null = null) => ({...rowOf(rank, tokenId, score), prev, days, streak});
const seasonBoard = (rows = [seasonRow(1, "12", 187, 9, 9, 2), seasonRow(2, "88", 120, 9, 4, 1), seasonRow(2, "5", 120, 8, 8, 3), seasonRow(4, "7", 3, 1, 1)], moves = true): RankingBoard =>
    ({board: "season", period: "s1", from: "2026-10-05", to: "2026-10-14", closesAt: Date.parse("2026-11-01T15:00:00Z"), entrants: rows.length, moves, rows});
/** Page `offset` of a 137-entrant race board, token n at #n and one place lower yesterday. */
const page = (offset = 10, focus: string | null = null): RankingPage => ({board: "race", period: "today", from: "2026-10-14", to: "2026-10-14", entrants: 137, moves: true,
    offset, focus, rows: Array.from({length: Math.max(0, Math.min(50, 137 - offset))}, (_, i) => ({...rowOf(offset + i + 1, String(offset + i + 1), 1000 - offset - i), prev: offset + i + 2}))});
const still = (...rows: ReturnType<typeof rowOf>[]) => rows.map(r => ({...r, prev: null}));
const empty = {attemptsUsed: 0, today: null, week: null};
/** Nine days in: a full run's bonus and three wins today. */
const mySeason = (): SeasonStanding => ({moves: true, prev: 4, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 30});
function standings(): RankingStandings {
    return {day: "2026-10-14", week: "2026-10-12", closesAt: {day: now + 1000, week: now + 5000}, leaders: {stamp: null, race: 99, shop: null}, guardians: [{
        tokenId: "2", streak: {current: 2, best: 4, freezes: 0, playedToday: true}, devotion: {rank: 1, days: 6}, season: mySeason(), titles: [{game: "race", place: 3}],
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
        for (const path of ["/board/race/today?x=1", "/board/xp/today", "/board/devotion/today", "/board/race/28d", "/guardians/2,1", "/guardians/1,1", "/guardians/1,2,3,4", "/guardians/0", "/guardians/10001",
            "/board/race/today/from/0", "/board/race/today/from/11", "/board/race/today/from/010", "/board/race/today/from/10010", "/board/race/today/around/2,1",
            "/board/race/today/around/1,2,3,4", "/board/race/today/from/10?x=1", "/board/race/28d/from/10", "/board/devotion/today/around/1", "/season?x=1", "/board/season/s2",
            "/board/season/today", "/board/race/s1", "/board/season/s1/from/9"])
            expect((await call(path)).status).toBe(400);
        for (const path of ["/board/race", "/guardians", "/board/race/today/extra", "/board/race/today/at/10", "/board/race/today/from", "/board/race/today/from/10/x", "/../profile/session",
            "/season/", "/season/1", "/seasons"]) expect((await call(path)).status).toBe(404);
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
    test("the season status is cached a minute; its board and pages travel like any other; a status for another season or a wrong phase is 503", async () => {
        const {calls, entries, call} = setup(() => Response.json(status()));
        const ok = await call("/season");
        expect(ok.status).toBe(200); expect(ok.headers.get("Cache-Control")).toBe("public, max-age=60");
        expect(await ok.json<unknown>()).toEqual(status()); expect(calls[0]!.url).toBe("https://seller.mapae.io/arcade/ranking/season");
        await call("/season"); expect(calls).toHaveLength(1); expect([...entries.keys()]).toEqual(["https://app.mapae.io/api/arcade/ranking/season"]);
        for (const phase of ["pending", "announced", "closed"] as const) expect(await (await setup(() => Response.json(status(phase))).call("/season")).json<unknown>()).toEqual(status(phase));
        for (const bad of [{...status(), id: 2}, {...status(), phase: "closed"}, {...status("pending"), phase: "announced"}, {...status(), start: null}, {...status(), end: "2026-10-04"},
            {...status(), today: "2026-10-32"}, {...status(), phase: "live"}, {...status("announced"), phase: "open"}, {...status("closed"), phase: "open"}]) {
            const {entries, call} = setup(() => Response.json(bad));
            expect((await call("/season")).status).toBe(503); expect(entries.size).toBe(0);
        }
        // The injected season decides which id answers.
        expect((await setup(() => Response.json(status()), {season: {id: 2, start: null, end: null}}).call("/season")).status).toBe(503);
        expect((await setup(() => Response.json(status()), {season: {id: 2, start: null, end: null}}).call("/board/season/s1")).status).toBe(400);
        expect((await setup(() => Response.json(seasonBoard())).call("/board/season/s1")).headers.get("Cache-Control")).toBe("public, max-age=30");
        expect(await (await setup(() => Response.json(seasonBoard())).call("/board/season/s1")).json<unknown>()).toEqual(seasonBoard());
    });
    test("pages reach the seller on their own paths, are cached by the whole path, and spend the same per-IP budget", async () => {
        const {calls, limits, entries, call} = setup(() => Response.json(page(60, "74")));
        const ip = {headers: {"CF-Connecting-IP": "203.0.113.9"}};
        const around = await call("/board/race/today/around/5,74", ip);
        expect(around.status).toBe(200); expect(around.headers.get("Cache-Control")).toBe("public, max-age=30");
        expect(await around.json<unknown>()).toEqual(page(60, "74"));
        expect(calls[0]!.url).toBe("https://seller.mapae.io/arcade/ranking/board/race/today/around/5,74");
        await call("/board/race/today/around/5,74", ip);
        expect(calls).toHaveLength(1); expect(limits).toHaveLength(1);
        expect([...entries.keys()]).toEqual(["https://app.mapae.io/api/arcade/ranking/board/race/today/around/5,74"]);
        // The same page asked by offset is a different question: the answer must have no focus, so this one is refused.
        expect((await call("/board/race/today/from/60", ip)).status).toBe(503); expect(limits).toHaveLength(2);
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
            board([{...rowOf(1), prev: 3}, {...rowOf(2), prev: 3}]),
        ];
        for (const value of bad) expect(parseRankingBoard(value, "race", "today")).toBeNull();
        const devotion = {board: "devotion", period: "28d", from: "2026-09-17", to: "2026-10-14", closesAt: null, entrants: 3, moves: false, rows: still(rowOf(1, "1", 5), rowOf(1, "2", 5), rowOf(3, "3", 2))};
        expect(parseRankingBoard(devotion, "devotion", "28d")?.rows.map(r => r.rank)).toEqual([1, 1, 3]);
        // Devotion shares places, so two guardians tied yesterday both carry that earlier place.
        const tied = {...devotion, moves: true, rows: devotion.rows.map((r, i) => ({...r, prev: i < 2 ? 2 : null}))};
        expect(parseRankingBoard(tied, "devotion", "28d")?.rows.map(r => r.prev)).toEqual([2, 2, null]);
        for (const rows of [still(rowOf(1, "1", 5), rowOf(2, "2", 5)), still(rowOf(1, "1", 5), rowOf(3, "2", 2)), still(rowOf(1, "1", 29))]) expect(parseRankingBoard({...devotion, rows, entrants: rows.length}, "devotion", "28d")).toBeNull();
    });
    test("season boards: shared places, each row's days inside the window and a run no longer than them, points within what those days can earn", () => {
        expect(parseRankingBoard(seasonBoard(), "season", "s1")).toEqual(seasonBoard());
        expect(parseRankingBoard({...seasonBoard(), closesAt: null}, "season", "s1")?.closesAt).toBeNull();
        expect(parseRankingBoard({...seasonBoard(), closesAt: Date.parse("2026-10-14T15:00:00Z")}, "season", "s1")?.closesAt).toBe(Date.parse("2026-10-14T15:00:00Z"));
        // A first day: nothing to compare with, one day each, a point for taking part.
        expect(parseRankingBoard({...seasonBoard([seasonRow(1, "3", 30, 1), seasonRow(2, "9", 1, 1)], false), from: "2026-10-14"}, "season", "s1")?.rows.map(r => r.score)).toEqual([30, 1]);
        // A row says nothing about its bonus: seven scattered days at a point each, or fourteen days with one run and 20 points, are whole boards.
        expect(parseRankingBoard(seasonBoard([seasonRow(1, "3", 7, 7, 1)], false), "season", "s1")?.rows[0]!.score).toBe(7);
        expect(parseRankingBoard({...seasonBoard([seasonRow(1, "3", 20, 14, 2)], false), from: "2026-10-01"}, "season", "s1")?.rows[0]!.score).toBe(20);
        expect(parseRankingBoard(seasonBoard([seasonRow(1, "3", 6, 7, 1)], false), "season", "s1")).toBeNull();
        const edit = (change: (rows: ReturnType<typeof seasonRow>[]) => void) => {const b = seasonBoard(); change(b.rows as ReturnType<typeof seasonRow>[]); return b;};
        const bad: unknown[] = [
            {...seasonBoard(), closesAt: Date.parse("2026-10-13T15:00:00Z")}, {...seasonBoard(), closesAt: Date.parse("2026-10-14T16:00:00Z")}, {...seasonBoard(), period: "s2"},
            edit(r => {r[0]!.days = 11;}), edit(r => {r[0]!.days = 0;}), edit(r => {r[1]!.streak = 10;}), edit(r => {delete (r[3] as Partial<typeof r[3]>).days;}), edit(r => {r[2]!.streak = -1;}),
            edit(r => {r[2]!.days = 1.5;}), edit(r => {r[0]!.score = 281;}), edit(r => {r[3]!.score = 0;}), edit(r => {r[3]!.score = 31;}), edit(r => {r[1]!.score = 121;}),
            edit(r => {r[2]!.rank = 3;}), edit(r => {r[3]!.rank = 3;}), edit(r => {r[3]!.prev = 0;}),
        ];
        for (const value of bad) expect(parseRankingBoard(value, "season", "s1")).toBeNull();
        // Two rows may share an earlier place on the season board, never on a game board; days and streak belong to the season board only.
        expect(parseRankingBoard(edit(r => {r[1]!.prev = 3;}), "season", "s1")?.rows.map(r => r.prev)).toEqual([2, 3, 3, null]);
        expect(parseRankingBoard({...board(), rows: [{...rowOf(1), prev: 2, days: 1, streak: 1}, {...rowOf(2), prev: null}]}, "race", "today")).toBeNull();
        expect(parseRankingBoard({...board(), rows: [{...rowOf(1), prev: 2}, {...rowOf(2), prev: null, streak: 0}]}, "race", "today")).toBeNull();
        const page = {...seasonBoard(), offset: 10, focus: null, entrants: 12, rows: [seasonRow(9, "40", 5, 2, 0, 11), seasonRow(12, "41", 2, 1, 1, null)]};
        const {closesAt: _, ...asked} = page;
        expect(parseRankingPage(asked, "season", "s1", {offset: 10})?.rows.map(r => [r.rank, r.days, r.streak])).toEqual([[9, 2, 0], [12, 1, 1]]);
        expect(parseRankingPage({...asked, rows: [seasonRow(9, "40", 5, 2, 3, 11), asked.rows[1]!]}, "season", "s1", {offset: 10})).toBeNull();
    });
    test("pages: the asked offset or a found focus, consecutive places from it, and a length that fits the entrants", () => {
        expect(parseRankingPage(page(), "race", "today", {offset: 10})).toEqual(page());
        expect(parseRankingPage(page(110), "race", "today", {offset: 110})?.rows).toHaveLength(27);
        expect(parseRankingPage(page(160), "race", "today", {offset: 160})?.rows).toEqual([]);
        expect(parseRankingPage(page(60, "74"), "race", "today", {around: ["5", "74"]})?.focus).toBe("74");
        expect(parseRankingPage(page(10), "race", "today", {around: ["5", "500"]})?.focus).toBeNull();
        const shift = (p: RankingPage, change: (r: RankingPage["rows"]) => void) => {const rows = structuredClone(p.rows); change(rows); return {...p, rows};};
        const bad: [unknown, Parameters<typeof parseRankingPage>[3]][] = [
            [page(60), {offset: 10}], [page(10, "11"), {offset: 10}], [{...page(), offset: 11}, {offset: 10}], [{...page(), board: "shop"}, {offset: 10}],
            [{...page(), entrants: 50}, {offset: 10}], [{...page(110), entrants: 120}, {offset: 110}], [{...page(), rows: page().rows.slice(1)}, {offset: 10}],
            [shift(page(), r => {r[0]!.rank = 1;}), {offset: 10}], [shift(page(), r => {r[3]!.rank = 13;}), {offset: 10}], [shift(page(), r => {r[2]!.tokenId = "11";}), {offset: 10}],
            [shift(page(), r => {r[1]!.prev = r[0]!.prev;}), {offset: 10}], [{...page(), moves: false}, {offset: 10}], [{...page(), rows: [...page().rows, page(60).rows[0]]}, {offset: 10}],
            [page(60, "74"), {around: ["5"]}], [page(60, "200"), {around: ["200"]}], [page(60), {around: ["74"]}], [{...page(60, "74"), offset: 50}, {around: ["74"]}],
        ];
        for (const [value, at] of bad) expect(parseRankingPage(value, "race", "today", at)).toBeNull();
        // Devotion pages may open on a place shared with the rows above them.
        const devotion = {board: "devotion", period: "28d", from: "2026-09-17", to: "2026-10-14", entrants: 13, moves: false, offset: 10, focus: null,
            rows: still(rowOf(9, "11", 2), rowOf(9, "12", 2), rowOf(13, "13", 1))};
        expect(parseRankingPage(devotion, "devotion", "28d", {offset: 10})?.rows.map(r => r.rank)).toEqual([9, 9, 13]);
        for (const rows of [still(rowOf(12, "11", 2), rowOf(12, "12", 2), rowOf(13, "13", 1)), still(rowOf(9, "11", 2), rowOf(9, "12", 2), rowOf(12, "13", 1))])
            expect(parseRankingPage({...devotion, rows}, "devotion", "28d", {offset: 10})).toBeNull();
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
            // The season standing: null or whole, with days, run, bonus and today inside what the days allow.
            s => {delete (s.guardians[0] as Partial<typeof s.guardians[0]>).season;}, s => {s.guardians[0]!.season!.rank = 0;}, s => {s.guardians[0]!.season!.entrants = 1;},
            s => {s.guardians[0]!.season!.streak = 10;}, s => {s.guardians[0]!.season!.bonus = 5;}, s => {s.guardians[0]!.season!.bonus = 20;}, s => {s.guardians[0]!.season!.today = 31;},
            s => {s.guardians[0]!.season!.points = 281;}, s => {s.guardians[0]!.season!.points = 18;}, s => {s.guardians[0]!.season!.days = 0;}, s => {s.guardians[0]!.season!.prev = 0;},
            s => {s.guardians[0]!.season!.moves = false;}, s => {s.guardians[0]!.season = {} as SeasonStanding;},
        ];
        for (const change of corrupt) {const value = standings(); change(value); expect(parseRankingStandings(value, ["2"])).toBeNull();}
        const none = standings(); none.guardians[0]!.season = null;
        expect(parseRankingStandings(none, ["2"])?.guardians[0]!.season).toBeNull();
        expect(parseRankingStandings({...standings(), guardians: [{...standings().guardians[0]!, season: {...mySeason(), points: 280, bonus: 10, today: 30}}]}, ["2"])?.guardians[0]!.season?.points).toBe(280);
    });
    test("season status: our id, dates as a pair of ranking days or none, and the phase those dates give today", () => {
        for (const phase of ["pending", "announced", "open", "closed"] as const) expect(parseSeasonStatus(status(phase))).toEqual(status(phase));
        expect(parseSeasonStatus({...status(), extra: 1})).toEqual(status());
        expect(parseSeasonStatus({...status(), id: 2}, {id: 2, start: null, end: null})).toEqual({...status(), id: 2});
        for (const bad of [{...status(), id: 2}, {...status(), id: "1"}, {...status(), phase: "announced"}, {...status(), today: "2026-10-14T00:00"}, {...status(), start: "2026-10-04x"},
            {...status("pending"), end: "2026-11-01"}, {...status(), today: "2026-10-32"}, null, [], "open"]) expect(parseSeasonStatus(bad)).toBeNull();
    });
});

describe("real seller contract", () => {
    const stores: {close(): void}[] = [];
    afterEach(() => {for (const s of stores.splice(0)) s.close();});
    test("the seller's own boards and standings pass the proxy validator unchanged", async () => {
        const {OutingStore} = await import("../../../../delegated-seller/outings/store");
        const season = {id: 1, start: "2026-10-05", end: "2026-11-01"};
        const {RankingReader} = await import("../../../../delegated-seller/ranking/board");
        const {createRankingApp} = await import("../../../../delegated-seller/ranking/routes");
        const store = new OutingStore(":memory:"); stores.push(store);
        const collection = "0x5555555555555555555555555555555555555555" as const;
        const add = (tokenId: string, game: string, day: string, attempt: number, score: number) => store.db.query("INSERT INTO arcade_guardian_ranked VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(`${tokenId}:${game}:${day}:${attempt}`, collection, tokenId, seedOf(tokenId), ARCADE_RULESET_VERSION, game, day, kstWeek(day), attempt, score, 0, now - 1000 + Number(tokenId));
        for (let i = 1; i <= 14; i++) add(String(i), "race", "2026-10-14", 1, 500 - i * 3);
        add("12", "race", "2026-10-13", 1, 7); add("12", "shop", "2026-10-06", 1, 70); add("3", "stamp", "2026-10-01", 1, 9); add("4", "stamp", "2026-10-02", 1, 9);
        const app = createRankingApp({token: receiptToken, reader: new RankingReader(store, collection, () => now, season)});
        const fetcher = async (url: string, init?: RequestInit) => app.request(new Request(url.replace("https://seller.mapae.io/arcade/ranking", "https://seller.local"), init));
        const deps: RankingDependencies = {receiptToken, fetcher, rateLimit: async () => true, now};
        for (const path of ["/board/race/today", "/board/race/week", "/board/race/yesterday", "/board/shop/lastweek", "/board/stamp/today", "/board/devotion/28d", "/guardians/3,12,40", "/season", "/board/season/s1"]) {
            const response = await rankingApi(new Request(origin + path), deps);
            expect(response.status).toBe(200);
        }
        const mine = await (await rankingApi(new Request(origin + "/guardians/12"), deps)).json() as RankingStandings;
        expect(mine.guardians[0]!.games.race.today).toMatchObject({rank: 12, entrants: 14, moves: true, prev: 1});
        // Token 12: #1 alone on 13 Oct (10) and #12 today (1); its shop round of 6 Oct settled after that week sealed, so it earns nothing. Tokens 3 and 4 played before the season.
        expect(mine.guardians[0]!.season).toEqual({moves: true, prev: 1, points: 11, rank: 1, entrants: 14, days: 2, streak: 2, bonus: 0, today: 1});
        expect(await (await rankingApi(new Request(origin + "/season"), deps)).json<unknown>()).toEqual({...season, today: "2026-10-14", phase: "open"});
        const s1 = await (await rankingApi(new Request(origin + "/board/season/s1"), deps)).json() as RankingBoard;
        expect(s1.rows[0]).toMatchObject({tokenId: "12", score: 11, days: 2, streak: 2}); expect(s1.entrants).toBe(14); expect(s1.closesAt).toBe(Date.parse("2026-11-01T15:00:00Z"));
        const race = await (await rankingApi(new Request(origin + "/board/race/today"), deps)).json() as RankingBoard;
        expect(race.moves).toBe(true); expect(race.rows.map(r => r.prev)).toEqual(Array(10).fill(null)); expect(mine.guardians[0]!.streak).toMatchObject({current: 2});
        // 75 entrants: a page past the top ten, a short last page, an empty one past the end, and around lookups.
        for (let i = 15; i <= 75; i++) add(String(i), "race", "2026-10-14", 1, 100 - i);
        for (const path of ["/board/race/today/from/10", "/board/race/today/from/60", "/board/race/today/from/110", "/board/race/today/around/3,70", "/board/race/today/around/40",
            "/board/devotion/28d/from/10", "/board/shop/lastweek/around/12", "/board/season/s1/from/10", "/board/season/s1/around/3,70"]) {
            const response = await rankingApi(new Request(origin + path), deps);
            expect(response.status).toBe(200);
        }
        const around = await (await rankingApi(new Request(origin + "/board/race/today/around/3,70"), deps)).json() as RankingPage;
        expect(around).toMatchObject({entrants: 75, offset: 60, focus: "70"}); expect(around.rows).toHaveLength(15);
    });
});
