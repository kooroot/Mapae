import type {Database} from 'bun:sqlite';
import type {Address, Hex} from 'viem';
import {ARCADE_RULESET_VERSION, type GameId} from '@mapae/arcade';
import {
    addDays, BOARD_ROWS, DEVOTION_DAYS, guardianStreak, kstDay, kstWeek, NEARBY_SPAN, nextReset, RANKED_GAMES, RANKING_PAGE_ROWS, rankingPageOffset, WEEKLY_COUNTED_DAYS, weekCutoff,
    type GuardianStanding, type RankingBoard, type RankingBoardId, type RankingPage, type RankingPeriod, type RankingRow, type RankingStanding, type RankingStandings, type SeasonRowExtras,
    type SeasonStanding,
} from '@mapae/arcade/ranking';
import {
    SEASON, SEASON_ENTRY_POINTS, SEASON_RANK_POINTS, SEASON_TOP10_POINTS, seasonClosesAt, seasonStatus, seasonStreak, seasonWindow, type Season, type SeasonStatus,
} from '@mapae/arcade/season';
import {OutingError} from '../outings/validation';
import type {OutingStore} from '../outings/store';

/** A guardian's best ranked attempt per board day; ties go to whoever reached the score first, then the lower token. */
const DAY_BOARD = `WITH best AS (
        SELECT token_id, guardian_seed, score, created_at,
            ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY score DESC, created_at, attempt) AS n
        FROM arcade_guardian_ranked WHERE collection=? AND ruleset=? AND game=? AND day=?)
    SELECT ROW_NUMBER() OVER (ORDER BY score DESC, created_at, CAST(token_id AS INTEGER)) AS rank, token_id AS tokenId, guardian_seed AS seed, score
    FROM best WHERE n=1 ORDER BY rank`;
/**
 * The sum of a guardian's best daily bests in the week (at most WEEKLY_COUNTED_DAYS days), reached when its last counted day was.
 * Only rows settled before the week's cutoff count, so a sealed week's board, and the titles it awards, never change.
 */
const WEEK_BOARD = `WITH daily AS (
        SELECT token_id, guardian_seed, day, score, created_at,
            ROW_NUMBER() OVER (PARTITION BY token_id, day ORDER BY score DESC, created_at, attempt) AS n
        FROM arcade_guardian_ranked WHERE collection=? AND ruleset=? AND game=? AND week=? AND created_at<?),
    counted AS (
        SELECT token_id, guardian_seed, score, created_at, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY score DESC, day) AS k
        FROM daily WHERE n=1),
    totals AS (
        SELECT token_id, MAX(guardian_seed) AS guardian_seed, SUM(score) AS score, MAX(created_at) AS reached FROM counted WHERE k<=? GROUP BY token_id)
    SELECT ROW_NUMBER() OVER (ORDER BY score DESC, reached, CAST(token_id AS INTEGER)) AS rank, token_id AS tokenId, guardian_seed AS seed, score
    FROM totals ORDER BY rank`;
/** Distinct days with a ranked round, across rulesets and games; equal counts share a rank. */
const DEVOTION_BOARD = `WITH days AS (
        SELECT token_id, MAX(guardian_seed) AS guardian_seed, COUNT(DISTINCT day) AS score
        FROM arcade_guardian_ranked WHERE collection=? AND day BETWEEN ? AND ? GROUP BY token_id)
    SELECT RANK() OVER (ORDER BY score DESC) AS rank, token_id AS tokenId, guardian_seed AS seed, score
    FROM days ORDER BY rank, CAST(token_id AS INTEGER)`;

/** The ruleset a closed week ranked under when it closed: a later ruleset bump never empties it. */
const WEEK_RULESET = 'SELECT MAX(ruleset) AS ruleset FROM arcade_guardian_ranked WHERE collection=? AND week=? AND created_at<?';
/**
 * Season points per guardian over the season's days so far (?: collection, from, to, yesterday, today), summed from each day's
 * boards as DAY_BOARD ranks them. A day's board ranks under the highest ruleset played that day, like a closed week does, and
 * rows settled at or after their week's cutoff never count, so a sealed week's points never change. Yesterday's total comes from
 * the same scan for the movement column.
 */
const SEASON_TOTALS = `WITH rows AS (
        SELECT token_id, guardian_seed, game, day, ruleset, attempt, score, created_at FROM arcade_guardian_ranked
        WHERE collection=? AND day BETWEEN ? AND ? AND created_at<(strftime('%s', week, '+8 days') - 32400) * 1000),
    day_ruleset AS (SELECT game, day, MAX(ruleset) AS ruleset FROM rows GROUP BY game, day),
    best AS (
        SELECT r.token_id, r.guardian_seed, r.game, r.day, r.score, r.created_at,
            ROW_NUMBER() OVER (PARTITION BY r.token_id, r.game, r.day ORDER BY r.score DESC, r.created_at, r.attempt) AS n
        FROM rows r JOIN day_ruleset d ON d.game=r.game AND d.day=r.day AND d.ruleset=r.ruleset),
    placed AS (
        SELECT token_id, guardian_seed, day, ROW_NUMBER() OVER (PARTITION BY game, day ORDER BY score DESC, created_at, CAST(token_id AS INTEGER)) AS rank
        FROM best WHERE n=1),
    daily AS (
        SELECT token_id, MAX(guardian_seed) AS guardian_seed, day,
            SUM(CASE ${SEASON_RANK_POINTS.map((points, i) => `WHEN rank=${i + 1} THEN ${points}`).join(' ')} WHEN rank<=${BOARD_ROWS} THEN ${SEASON_TOP10_POINTS} ELSE ${SEASON_ENTRY_POINTS} END) AS points
        FROM placed GROUP BY token_id, day)
    SELECT token_id AS tokenId, MAX(guardian_seed) AS seed, SUM(points) AS points, COALESCE(SUM(points) FILTER (WHERE day<=?), 0) AS before,
        COALESCE(SUM(points) FILTER (WHERE day=?), 0) AS today, GROUP_CONCAT(day) AS days
    FROM daily GROUP BY token_id`;

/** A board window; `ruleset` is the one its rows ranked under, null for devotion and the season, which count across rulesets. */
type Window = {from: string; to: string; closesAt: number | null; ruleset: number | null; rows: (RankingRow & Partial<SeasonRowExtras>)[]};
type Moves = ReadonlyMap<string, number> | null;
/** The season board at `to` and at the day before, from one scan, with what each guardian's bonus and today added. */
type SeasonWindows = {current: Window; earlier: Window; totals: ReadonlyMap<string, {bonus: number; today: number}>};

/** Every entrant of one game's week board at `at`: the open week under the current ruleset, a closed one under its own. */
export function weekBoard(db: Database, collection: Address, game: GameId, week: string, at: number): {ruleset: number; rows: RankingRow[]} {
    const c = collection.toLowerCase(), cutoff = weekCutoff(week);
    const ruleset = week < kstWeek(kstDay(at))
        ? db.query<{ruleset: number | null}, [string, string, number]>(WEEK_RULESET).get(c, week, cutoff)?.ruleset ?? ARCADE_RULESET_VERSION
        : ARCADE_RULESET_VERSION;
    return {ruleset, rows: db.query<RankingRow, [string, number, string, string, number, number]>(WEEK_BOARD).all(c, ruleset, game, week, cutoff, WEEKLY_COUNTED_DAYS)
        .map(r => ({rank: r.rank, tokenId: r.tokenId, seed: r.seed, score: r.score}))};
}

/**
 * Each guardian's rank on the whole earlier board, so a guardian that was simply below the shown rows is never called new. No
 * comparison when the earlier board is empty (every row would read "new") or ranked under another ruleset: a ruleset change
 * starts every course afresh, so a climb across it would compare different games.
 */
function previousRanks(current: Window, earlier: Window): Moves {
    return earlier.rows.length && earlier.ruleset === current.ruleset ? new Map(earlier.rows.map(row => [row.tokenId, row.rank])) : null;
}
const move = (moves: Moves, tokenId: string) => ({moves: moves !== null, prev: moves?.get(tokenId) ?? null});
/** `count` rows of a whole board from the 0-based place `offset`, each with its earlier rank. */
const placed = (rows: RankingRow[], offset: number, count: number, moves: Moves) =>
    rows.slice(offset, offset + count).map(row => ({...row, prev: moves?.get(row.tokenId) ?? null}));

/**
 * Public leaderboards read from verified ranked rows only. Every board is derived on read; nothing here is stored, so a
 * ruleset change (filtered on read, and part of every ranked seed) starts fresh open boards with no migration, while a closed
 * week keeps the ruleset it closed under.
 */
export class RankingReader {
    constructor(readonly store: OutingStore, readonly collection: Address, readonly now: () => number = Date.now, readonly season: Season = SEASON) {}

    seasonStatus(): SeasonStatus {
        return seasonStatus(this.season, this.now());
    }

    /** A board's top rows, each with its rank one window earlier: reading the earlier board doubles the work of a request, nothing more. */
    board(board: RankingBoardId, period: RankingPeriod): RankingBoard {
        const [window, earlier] = this.windows(board, period, this.now()), moves = previousRanks(window, earlier);
        return {board, period, from: window.from, to: window.to, closesAt: window.closesAt, entrants: window.rows.length, moves: moves !== null,
            rows: placed(window.rows, 0, BOARD_ROWS, moves)};
    }

    /**
     * One page of the whole board below the top rows: the page at `offset`, or the page holding the best placed of the `around`
     * guardians below the top rows (the first page when none is). The page is sliced from the whole board in memory rather than
     * read with SQL LIMIT/OFFSET: the entrant count and every earlier rank already need both whole windows, and the window
     * functions rank every entrant before any LIMIT could apply, so a SQL page would only save copying rows this request reads.
     */
    page(board: RankingBoardId, period: RankingPeriod, at: {offset: number} | {around: readonly string[]}): RankingPage {
        const [window, earlier] = this.windows(board, period, this.now()), moves = previousRanks(window, earlier);
        const found = 'around' in at ? window.rows.findIndex((row, index) => index >= BOARD_ROWS && at.around.includes(row.tokenId)) : -1;
        const offset = 'offset' in at ? at.offset : rankingPageOffset(found);
        return {board, period, from: window.from, to: window.to, entrants: window.rows.length, moves: moves !== null, offset,
            focus: found < 0 ? null : window.rows[found]!.tokenId, rows: placed(window.rows, offset, RANKING_PAGE_ROWS, moves)};
    }

    /** Where each named guardian stands on every current board, computing each window once for the whole request. */
    standings(tokenIds: readonly string[]): RankingStandings {
        const at = this.now(), today = kstDay(at), week = kstWeek(today);
        const boards = Object.fromEntries(RANKED_GAMES.map(game => {
            const [today, yesterday, week, lastweek] = (['today', 'yesterday', 'week', 'lastweek'] as const).map(period => this.window(game, period, at)) as [Window, Window, Window, Window];
            return [game, {today: today.rows, week: week.rows, lastweek: lastweek.rows, todayMoves: previousRanks(today, yesterday), weekMoves: previousRanks(week, lastweek)}];
        })) as Record<GameId, Record<'today' | 'week' | 'lastweek', RankingRow[]> & {todayMoves: Moves; weekMoves: Moves}>;
        const devotion = this.window('devotion', '28d', at).rows, season = this.seasonWindows(today), seasonMoves = season && previousRanks(season.current, season.earlier);
        const guardians = tokenIds.map((tokenId): GuardianStanding => {
            const taken = this.store.rankedAttemptsTaken(this.collection, tokenId, today);
            const devoted = devotion.find(row => row.tokenId === tokenId), raced = season?.current.rows.find(row => row.tokenId === tokenId);
            return {
                tokenId, streak: guardianStreak(this.playedDays(tokenId, today), today),
                devotion: {rank: devoted?.rank ?? null, days: devoted?.score ?? 0},
                season: season && raced ? seasonStanding(raced, season, seasonMoves) : null,
                titles: RANKED_GAMES.flatMap(game => {const row = boards[game].lastweek.find(r => r.tokenId === tokenId); return row && row.rank <= BOARD_ROWS ? [{game, place: row.rank}] : [];}),
                games: Object.fromEntries(RANKED_GAMES.map(game => [game, {
                    attemptsUsed: taken[game].length, today: standing(boards[game].today, tokenId, boards[game].todayMoves),
                    week: standing(boards[game].week, tokenId, boards[game].weekMoves),
                }])) as GuardianStanding['games'],
            };
        });
        return {day: today, week, closesAt: {day: nextReset(at, 'day'), week: nextReset(at, 'week')},
            leaders: Object.fromEntries(RANKED_GAMES.map(game => [game, boards[game].today[0]?.score ?? null])) as RankingStandings['leaders'], guardians};
    }

    /** A board's window at `at` and the one before it. The season reads both from one scan; every other board reads twice. */
    private windows(board: RankingBoardId, period: RankingPeriod, at: number): [Window, Window] {
        if (board !== 'season') return [this.window(board, period, at), this.window(board, period, at, 1)];
        const season = this.seasonWindows(kstDay(at));
        if (!season) throw new OutingError('invalid_request');
        return [season.current, season.earlier];
    }

    /**
     * The season board as of `today` (or its last day) and as of the day before, or null before the season opens. Points are
     * summed per day in SQL; the attendance bonus and the shared ranks are added here from each guardian's season days.
     */
    private seasonWindows(today: string): SeasonWindows | null {
        const window = seasonWindow(this.season, today);
        if (!window) return null;
        const {from, to} = window, yesterday = addDays(to, -1), totals = new Map<string, {bonus: number; today: number}>();
        const current: (RankingRow & SeasonRowExtras)[] = [], earlier: RankingRow[] = [];
        for (const row of this.store.db.query<{tokenId: string; seed: Hex; points: number; before: number; today: number; days: string}, [string, string, string, string, string]>(SEASON_TOTALS)
            .all(this.collection.toLowerCase(), from, to, yesterday, to)) {
            const days = row.days.split(','), run = seasonStreak(days, to), before = days.filter(day => day <= yesterday);
            current.push({rank: 0, tokenId: row.tokenId, seed: row.seed, score: row.points + run.bonus, days: days.length, streak: run.current});
            totals.set(row.tokenId, {bonus: run.bonus, today: row.today});
            if (before.length) earlier.push({rank: 0, tokenId: row.tokenId, seed: row.seed, score: row.before + seasonStreak(before, yesterday).bonus});
        }
        return {current: {from, to, closesAt: seasonClosesAt(this.season, today), ruleset: null, rows: sharedRanks(current)},
            earlier: {from, to: yesterday, closesAt: null, ruleset: null, rows: sharedRanks(earlier)}, totals};
    }

    /** The board's window at `at`, or `back` windows earlier: the day, week or 28-day span ending `back` days or weeks sooner. */
    private window(board: RankingBoardId, period: RankingPeriod, at: number, back = 0): Window {
        if (board === 'season') throw new Error('season windows read in pairs');
        const today = kstDay(at), week = kstWeek(today), collection = this.collection.toLowerCase(), db = this.store.db;
        const rows = (sql: string, ...args: (string | number)[]) => db.query<RankingRow, (string | number)[]>(sql).all(...args)
            .map(r => ({rank: r.rank, tokenId: r.tokenId, seed: r.seed, score: r.score}));
        if (board === 'devotion') {
            const to = addDays(today, -back), from = addDays(to, 1 - DEVOTION_DAYS);
            return {from, to, closesAt: back ? null : nextReset(at, 'day'), ruleset: null, rows: rows(DEVOTION_BOARD, collection, from, to)};
        }
        if (period === 'today' || period === 'yesterday') {
            const day = addDays(today, (period === 'today' ? 0 : -1) - back);
            return {from: day, to: day, closesAt: period === 'today' && !back ? nextReset(at, 'day') : null, ruleset: ARCADE_RULESET_VERSION,
                rows: rows(DAY_BOARD, collection, ARCADE_RULESET_VERSION, board, day)};
        }
        const start = addDays(week, (period === 'week' ? 0 : -7) - 7 * back), {ruleset, rows: entrants} = weekBoard(db, this.collection, board, start, at);
        return {from: start, to: addDays(start, 6), closesAt: period === 'week' && !back ? nextReset(at, 'week') : null, ruleset, rows: entrants};
    }

    /** The token's ranked days over the last year: enough for any streak a board shows, bounded however long a token plays. */
    private playedDays(tokenId: string, today: string): string[] {
        return this.store.db.query<{day: string}, [string, string, string, string]>(
            'SELECT DISTINCT day FROM arcade_guardian_ranked WHERE collection=? AND token_id=? AND day BETWEEN ? AND ? ORDER BY day')
            .all(this.collection.toLowerCase(), tokenId, addDays(today, -364), today).map(r => r.day);
    }
}

/** Equal scores share a place and sort by token inside it, as devotion ranks; the next place counts every row above it. */
function sharedRanks<T extends RankingRow>(rows: T[]): T[] {
    rows.sort((a, b) => b.score - a.score || Number(a.tokenId) - Number(b.tokenId));
    let rank = 0;
    return rows.map((row, i) => {if (i === 0 || rows[i - 1]!.score !== row.score) rank = i + 1; return {...row, rank};});
}
function seasonStanding(row: RankingRow & Partial<SeasonRowExtras>, season: SeasonWindows, moves: Moves): SeasonStanding {
    const {bonus, today} = season.totals.get(row.tokenId)!;
    return {...move(moves, row.tokenId), points: row.score, rank: row.rank, entrants: season.current.rows.length, days: row.days!, streak: row.streak!, bonus, today};
}
function standing(rows: RankingRow[], tokenId: string, moves: Moves): RankingStanding | null {
    const index = rows.findIndex(row => row.tokenId === tokenId);
    if (index < 0) return null;
    const row = rows[index]!;
    return {rank: row.rank, score: row.score, ...move(moves, tokenId), entrants: rows.length, leader: rows[0]!.score, above: rows[index - 1] ?? null,
        nearby: rows.slice(Math.max(0, index - NEARBY_SPAN), index + NEARBY_SPAN + 1)};
}
