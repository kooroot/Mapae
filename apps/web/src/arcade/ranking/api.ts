import {isHash, type Hex} from "viem";
import type {GameId} from "@mapae/arcade";
import {GUARDIAN_MAX_SUPPLY} from "@mapae/arcade/guardians";
import {
    BOARD_ROWS, DEVOTION_DAYS, isRankingDay, NEARBY_SPAN, parseRankingIds, parseRankingPageOffset, RANKED_ATTEMPTS, RANKED_GAMES, RANKING_PAGE_ROWS, rankingPageOffset,
    STREAK_FREEZE_MAX, validRankingBoard, validRankingTokenId,
    type GuardianStanding, type RankingBoard, type RankingBoardId, type RankingPage, type RankingPeriod, type RankingRow, type RankingStanding, type RankingStandings,
} from "@mapae/arcade/ranking";
import {tokenHash} from "../../lib/siwe-session";

const UPSTREAM = "https://seller.mapae.io/arcade/ranking";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SCORE = 1_000_000_000;
const RATE_PER_MINUTE = 120;
/** A board's top rows, or with `/from/<offset>` or `/around/<ids>` one page of the whole board below them. */
const BOARD_PATH = /^\/api\/arcade\/ranking\/board\/([a-z]{1,16})\/([a-z0-9]{1,16})(?:\/(from|around)\/([0-9,]{1,20}))?$/;
const STANDINGS_PATH = /^\/api\/arcade\/ranking\/guardians\/([0-9,]{1,20})$/;
/** Boards change when a round settles; a short shared cache absorbs a crowd without hiding a new record for long. */
const MAX_AGE = {board: 30, standings: 10};
const HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer"};

export type RankingDependencies = {
    receiptToken?: string;
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
    /** The edge cache; absent where the runtime has none. */
    cache?: Promise<Cache>;
    rateLimit: (bucket: string, until: number, limit: number) => Promise<boolean>;
    now?: number;
};

const failure = (code: string, status: number, extra: Record<string, string> = {}) =>
    Response.json({error: {code}}, {status, headers: {...HEADERS, "Cache-Control": "no-store", ...extra}});

/**
 * Public leaderboards: no session, cookie or wallet is read, and nothing but a validated copy of the seller's answer leaves.
 * Hits come from the edge cache; only a miss spends the per-IP budget and one bearer call to the seller.
 */
export async function rankingApi(request: Request, deps: RankingDependencies): Promise<Response> {
    const url = new URL(request.url), board = BOARD_PATH.exec(url.pathname), standing = STANDINGS_PATH.exec(url.pathname);
    if (!board && !standing) return failure("not_found", 404);
    if (request.method !== "GET") return failure("method_not_allowed", 405, {Allow: "GET"});
    const ids = standing ? parseRankingIds(standing[1]!) : null, by = board?.[3] as "from" | "around" | undefined;
    const at = by === "from" ? parseRankingPageOffset(board![4]!) : by === "around" ? parseRankingIds(board![4]!) : null;
    if (url.search || (board && !validRankingBoard(board[1]!, board[2]!)) || (standing && !ids) || (by && at === null)) return failure("invalid_request", 400);
    if (!deps.receiptToken || deps.receiptToken.length < 32) return failure("ranking_unavailable", 503);
    const key = new Request(`${url.origin}${url.pathname}`), cache = deps.cache ? await deps.cache.catch(() => undefined) : undefined;
    const hit = await cache?.match(key);
    if (hit) return hit;
    const now = deps.now ?? Date.now(), minute = Math.floor(now / 60_000), until = (minute + 1) * 60_000, ip = request.headers.get("CF-Connecting-IP");
    if (ip && !await deps.rateLimit(`ranking-ip:${await tokenHash(ip)}:${minute}`, until, RATE_PER_MINUTE)) {
        return failure("rate_limited", 429, {"Retry-After": String(Math.max(1, Math.ceil((until - now) / 1000)))});
    }
    let value: unknown;
    try {
        const response = await (deps.fetcher ?? fetch)(`${UPSTREAM}${url.pathname.slice("/api/arcade/ranking".length)}`, {
            method: "GET", headers: {Authorization: `Bearer ${deps.receiptToken}`, Accept: "application/json"}, redirect: "manual", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {await response.body?.cancel(); throw new Error("upstream");}
        value = await boundedJson(response);
    } catch {return failure("ranking_unavailable", 503);}
    const copy = !board ? parseRankingStandings(value, ids!)
        : by ? parseRankingPage(value, board[1] as RankingBoardId, board[2] as RankingPeriod, typeof at === "number" ? {offset: at} : {around: at!})
        : parseRankingBoard(value, board[1] as RankingBoardId, board[2] as RankingPeriod);
    if (!copy) return failure("ranking_unavailable", 503);
    const response = Response.json(copy, {headers: {...HEADERS, "Cache-Control": `public, max-age=${board ? MAX_AGE.board : MAX_AGE.standings}`}});
    await cache?.put(key, response.clone()).catch(() => {/* A cold cache only costs the next visitor one seller call. */});
    return response;
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
    return JSON.parse(text + decoder.decode());
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const score = (v: unknown): v is number => uint(v) && v <= MAX_SCORE;
const instant = (v: unknown): v is number => uint(v) && v <= 8_640_000_000_000_000;
/** An earlier rank: a place on a board, or null for no entry there. With no comparison every one is null. */
const earlierRank = (v: unknown, moves: boolean): v is number | null => v === null || (moves && uint(v) && v >= 1 && v <= GUARDIAN_MAX_SUPPLY);

function row(v: unknown): RankingRow | null {
    if (!object(v) || !uint(v.rank) || v.rank < 1 || !validRankingTokenId(v.tokenId) || typeof v.seed !== "string" || !isHash(v.seed) || !score(v.score)) return null;
    return {rank: v.rank, tokenId: v.tokenId, seed: v.seed.toLowerCase() as Hex, score: v.score};
}
/**
 * Rows in board order from the 0-based place `start`: scores never rise, tokens never repeat, and ranks are consecutive (or,
 * when `shared`, equal on equal scores and otherwise their place).
 */
function rows(v: unknown, max: number, shared: boolean, start = 0): RankingRow[] | null {
    if (!Array.isArray(v) || v.length > max) return null;
    const out: RankingRow[] = [];
    for (const item of v) {
        const next = row(item), previous = out.at(-1);
        if (!next || out.some(r => r.tokenId === next.tokenId)) return null;
        if (previous && (next.score > previous.score || (shared
            ? next.rank !== (next.score === previous.score ? previous.rank : start + out.length + 1)
            : next.rank !== previous.rank + 1))) return null;
        out.push(next);
    }
    return out;
}
/**
 * A board's rows from the 0-based place `start`, each with its earlier rank. The first row holds place start + 1, or on devotion,
 * which shares places, a place no lower; every row fits the entrant count, and a short list reaches its end.
 */
function placedRows(v: Record<string, unknown>, board: RankingBoardId, start: number, max: number): RankingBoard["rows"] | null {
    const devotion = board === "devotion", list = rows(v.rows, max, devotion, start), moves = v.moves;
    if (!list || !uint(v.entrants) || typeof moves !== "boolean" || list.length !== Math.max(0, Math.min(max, v.entrants - start)) ||
        (list.length > 0 && (devotion ? list[0]!.rank > start + 1 : list[0]!.rank !== start + 1)) || (devotion && list.some(r => r.score > DEVOTION_DAYS))) return null;
    // Only devotion shares places, so on any other board two rows never held the same earlier place.
    const prevs = (v.rows as Record<string, unknown>[]).map(r => r.prev), held = prevs.filter(p => p !== null);
    if (!prevs.every(p => earlierRank(p, moves)) || (!devotion && new Set(held).size !== held.length)) return null;
    return list.map((r, i) => ({...r, prev: prevs[i] as number | null}));
}

export function parseRankingBoard(v: unknown, board: RankingBoardId, period: RankingPeriod): RankingBoard | null {
    if (!object(v) || v.board !== board || v.period !== period || !isRankingDay(v.from) || !isRankingDay(v.to) || v.from > v.to ||
        !(v.closesAt === null || instant(v.closesAt))) return null;
    const list = placedRows(v, board, 0, BOARD_ROWS);
    return list && {board, period, from: v.from, to: v.to, closesAt: v.closesAt, entrants: v.entrants as number, moves: v.moves as boolean, rows: list};
}

/**
 * One page of a whole board: the asked offset, or for an `around` lookup a page on the grid whose focus is one of the named
 * guardians on that page, or the first page with no focus.
 */
export function parseRankingPage(v: unknown, board: RankingBoardId, period: RankingPeriod, at: {offset: number} | {around: readonly string[]}): RankingPage | null {
    if (!object(v) || v.board !== board || v.period !== period || !isRankingDay(v.from) || !isRankingDay(v.to) || v.from > v.to || !uint(v.offset) ||
        rankingPageOffset(v.offset) !== v.offset || !(v.focus === null || validRankingTokenId(v.focus))) return null;
    const list = placedRows(v, board, v.offset, RANKING_PAGE_ROWS), focus = v.focus;
    if (!list || ("offset" in at ? v.offset !== at.offset || focus !== null
        : focus === null ? v.offset !== BOARD_ROWS : !at.around.includes(focus) || !list.some(r => r.tokenId === focus))) return null;
    return {board, period, from: v.from, to: v.to, entrants: v.entrants as number, moves: v.moves as boolean, offset: v.offset, focus, rows: list};
}

function standing(v: unknown, tokenId: string): RankingStanding | null {
    if (!object(v) || !uint(v.rank) || v.rank < 1 || !score(v.score) || !uint(v.entrants) || v.entrants < v.rank || !score(v.leader) || v.leader < v.score ||
        typeof v.moves !== "boolean" || !earlierRank(v.prev, v.moves)) return null;
    const nearby = rows(v.nearby, NEARBY_SPAN * 2 + 1, false), above = v.above === null ? null : row(v.above);
    const self = nearby?.find(r => r.tokenId === tokenId);
    if (!nearby || !self || self.rank !== v.rank || self.score !== v.score || (v.rank === 1) !== (above === null) || (v.rank === 1 && v.leader !== v.score) ||
        (above && (above.rank !== v.rank - 1 || above.score < v.score || !nearby.some(r => r.tokenId === above.tokenId && r.rank === above.rank && r.score === above.score)))) return null;
    return {rank: v.rank, score: v.score, moves: v.moves, prev: v.prev, entrants: v.entrants, leader: v.leader, above, nearby};
}
function optionalStanding(v: unknown, tokenId: string): RankingStanding | null | undefined {
    return v === null ? null : standing(v, tokenId) ?? undefined;
}
function guardian(v: unknown, tokenId: string): GuardianStanding | null {
    if (!object(v) || v.tokenId !== tokenId || !object(v.streak) || !object(v.devotion) || !Array.isArray(v.titles) || v.titles.length > RANKED_GAMES.length || !object(v.games)) return null;
    const {streak, devotion} = v;
    if (!uint(streak.current) || !uint(streak.best) || streak.current > streak.best || !uint(streak.freezes) || streak.freezes > STREAK_FREEZE_MAX || typeof streak.playedToday !== "boolean" ||
        (streak.playedToday && streak.current < 1)) return null;
    if (!uint(devotion.days) || devotion.days > DEVOTION_DAYS || !(devotion.rank === null ? devotion.days === 0 : uint(devotion.rank) && devotion.rank >= 1 && devotion.days > 0)) return null;
    const titles: GuardianStanding["titles"] = [];
    for (const t of v.titles) {
        if (!object(t) || !RANKED_GAMES.includes(t.game as GameId) || titles.some(x => x.game === t.game) || !uint(t.place) || t.place < 1 || t.place > BOARD_ROWS) return null;
        titles.push({game: t.game as GameId, place: t.place});
    }
    if (Object.keys(v.games).length !== RANKED_GAMES.length) return null;
    const games = {} as GuardianStanding["games"];
    for (const game of RANKED_GAMES) {
        const g = v.games[game];
        if (!object(g) || !uint(g.attemptsUsed) || g.attemptsUsed > RANKED_ATTEMPTS) return null;
        const today = optionalStanding(g.today, tokenId), week = optionalStanding(g.week, tokenId);
        if (today === undefined || week === undefined || (today && g.attemptsUsed < 1)) return null;
        games[game] = {attemptsUsed: g.attemptsUsed, today, week};
    }
    return {tokenId, streak: {current: streak.current, best: streak.best, freezes: streak.freezes, playedToday: streak.playedToday},
        devotion: {rank: devotion.rank as number | null, days: devotion.days}, titles, games};
}

export function parseRankingStandings(v: unknown, ids: readonly string[]): RankingStandings | null {
    if (!object(v) || !isRankingDay(v.day) || !isRankingDay(v.week) || v.week > v.day || !object(v.closesAt) || !instant(v.closesAt.day) || !instant(v.closesAt.week) ||
        v.closesAt.week < v.closesAt.day || !object(v.leaders) || Object.keys(v.leaders).length !== RANKED_GAMES.length || !Array.isArray(v.guardians) || v.guardians.length !== ids.length) return null;
    const leaders = {} as RankingStandings["leaders"];
    for (const game of RANKED_GAMES) {
        const leader = v.leaders[game];
        if (!(leader === null || score(leader))) return null;
        leaders[game] = leader;
    }
    const guardians: GuardianStanding[] = [];
    for (const [index, item] of v.guardians.entries()) {
        const parsed = guardian(item, ids[index]!);
        if (!parsed || RANKED_GAMES.some(game => parsed.games[game].today && parsed.games[game].today!.leader !== leaders[game])) return null;
        guardians.push(parsed);
    }
    return {day: v.day, week: v.week, closesAt: {day: v.closesAt.day, week: v.closesAt.week}, leaders, guardians};
}
