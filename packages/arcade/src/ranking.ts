import type {Hex} from "viem";
import {ARCADE_RULESET_VERSION, type GameId} from "./contracts";
import {GUARDIAN_MAX_SUPPLY} from "./guardians";
import type {Season} from "./season";

/**
 * Ranked play: the first RANKED_ATTEMPTS settled outing rounds of each game per guardian and Korean calendar day count toward the
 * public boards. Later rounds still grow the guardian; only the board is capped, so spending more never buys a higher rank.
 */
export const RANKED_ATTEMPTS = 3;
/** A week's total adds a guardian's best WEEKLY_COUNTED_DAYS daily bests, so two days off cost nothing. */
export const WEEKLY_COUNTED_DAYS = 5;
export const DEVOTION_DAYS = 28;
/** One rest day (쉼표) is earned for every STREAK_FREEZE_EVERY played days in a run, held up to STREAK_FREEZE_MAX. */
export const STREAK_FREEZE_EVERY = 7;
export const STREAK_FREEZE_MAX = 2;
export const STREAK_MILESTONES = [3, 7, 14, 30, 100] as const;
export const BOARD_ROWS = 10;
/** Past the top BOARD_ROWS, the whole board reads in pages this long, starting at #11, #61, #111, … */
export const RANKING_PAGE_ROWS = 50;
/** How many places either side of a guardian its standing lists. */
export const NEARBY_SPAN = 2;
export const RANKED_GAMES = ["stamp", "race", "shop"] as const satisfies readonly GameId[];

export type RankedAttempt = {day: string; attempt: number};
export type RankingBoardId = GameId | "devotion" | "season";
export type GamePeriod = "today" | "yesterday" | "week" | "lastweek";
/** Game boards read the four day/week windows; the devotion board reads only the last 28 days; the season board its own `s<id>`. */
export type RankingPeriod = GamePeriod | "28d" | `s${number}`;
export const GAME_PERIODS = ["today", "week", "yesterday", "lastweek"] as const satisfies readonly GamePeriod[];
/** `seed` is the guardian's public birth seed: enough to draw its portrait, nothing about its owner. */
export type RankingRow = {rank: number; tokenId: string; seed: Hex; score: number};
/**
 * Rank movement against the same board one window earlier (the day before, the week before, devotion as of yesterday).
 * `moves` is false when there is nothing fair to compare with: an empty earlier board, or one ranked under another ruleset.
 * While it is true, `prev` is the guardian's rank on the whole earlier board, or null when it had no entry there at all.
 */
export type RankingMove = {moves: boolean; prev: number | null};
/** What a season row carries besides its points: days played inside the season and the current attendance run there. */
export type SeasonRowExtras = {days: number; streak: number};
export type RankingBoard = {
    board: RankingBoardId; period: RankingPeriod; from: string; to: string;
    /** When the window closes (epoch ms); null once it has. */
    closesAt: number | null; entrants: number; moves: boolean; rows: (RankingRow & Pick<RankingMove, "prev"> & Partial<SeasonRowExtras>)[];
};
/**
 * One page of a whole board: its rows from the 0-based place `offset` (offset 10 starts at #11), with movement against the same
 * earlier board the top rows use. `focus` is the guardian an `around` lookup found on the page; null for a page asked by offset,
 * or when none of the named guardians places below the top rows.
 */
export type RankingPage = Omit<RankingBoard, "closesAt"> & {offset: number; focus: string | null};
export type RankingStanding = RankingMove & {rank: number; score: number; entrants: number; leader: number; above: RankingRow | null; nearby: RankingRow[]};
export type GuardianStreak = {current: number; best: number; freezes: number; playedToday: boolean};
/** A guardian's place in the season race: points with the attendance bonus in, and what today and the run added. */
export type SeasonStanding = RankingMove & SeasonRowExtras & {points: number; rank: number; entrants: number; bonus: number; today: number};
export type GuardianStanding = {
    tokenId: string; streak: GuardianStreak; devotion: {rank: number | null; days: number};
    /** Null outside a season window, or with no ranked day inside it yet. */
    season: SeasonStanding | null;
    /** Last week's places 1–10, per game. */
    titles: {game: GameId; place: number}[];
    games: Record<GameId, {attemptsUsed: number; today: RankingStanding | null; week: RankingStanding | null}>;
};
export type RankingStandings = {
    day: string; week: string; closesAt: {day: number; week: number};
    /** Today's #1 score per game, so a guardian with no record yet still sees the mark to beat. */
    leaders: Record<GameId, number | null>;
    guardians: GuardianStanding[];
};

const KST_OFFSET = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Monday of ranking week 0; MapaeGuardians counts honor weeks from the same day. */
const WEEK_ZERO = "1970-01-05";
/** Late settlements may still land in a closed week for this long; after it the week is sealed. MapaeGuardians.HONOR_GRACE mirrors it. */
export const HONOR_GRACE_MS = DAY_MS;

export function isRankingDay(value: unknown): value is string {
    return typeof value === "string" && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dayStart(day: string): number {
    if (!isRankingDay(day)) throw new Error("Invalid ranking day");
    return Date.parse(`${day}T00:00:00Z`);
}
/** The Korean calendar day of an instant: every board, challenge and streak turns over at 00:00 KST. */
export function kstDay(at: number): string {
    if (!Number.isFinite(at)) throw new Error("Invalid ranking time");
    return new Date(at + KST_OFFSET).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
    return new Date(dayStart(day) + n * DAY_MS).toISOString().slice(0, 10);
}
/** The Monday that starts the KST week holding `day`. */
export function kstWeek(day: string): string {
    return addDays(day, -((new Date(dayStart(day)).getUTCDay() + 6) % 7));
}
/** Epoch ms of the next 00:00 KST, or of the next Monday 00:00 KST. */
export function nextReset(at: number, period: "day" | "week"): number {
    const today = kstDay(at);
    return dayStart(period === "day" ? addDays(today, 1) : addDays(kstWeek(today), 7)) - KST_OFFSET;
}
/** A KST week's index from week 0 (Monday 1970-01-05): the `week` an on-chain honor carries. Only a Monday names a week. */
export function rankingWeekIndex(week: string): number {
    if (kstWeek(week) !== week || week < WEEK_ZERO) throw new Error("Invalid ranking week");
    return (dayStart(week) - dayStart(WEEK_ZERO)) / DAY_MS / 7;
}
export function rankingWeekOf(index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid ranking week");
    return addDays(WEEK_ZERO, index * 7);
}
/** When a week seals (epoch ms): the next Tuesday 00:00 KST. Rows settled at or after it never change the week's board. */
export function weekCutoff(week: string): number {
    rankingWeekIndex(week);
    return dayStart(addDays(week, 7)) - KST_OFFSET + HONOR_GRACE_MS;
}
/** The latest week sealed at `at`, or null before week 1 (the contract refuses week 0). */
export function sealedWeek(at: number): string | null {
    const week = addDays(kstWeek(kstDay(at - HONOR_GRACE_MS)), -7);
    return week > WEEK_ZERO ? week : null;
}
/** 32-bit FNV-1a: the stable scenario hash behind daily challenges and ranked seeds. */
export function fnv1a(key: string): number {
    let seed = 2166136261;
    for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    return seed;
}
/**
 * The seed of a guardian's ranked attempt. Fixed per guardian, game, day and attempt, so nobody can reroll a ranked course, and
 * different per guardian, so a board does not collapse into ties between guardians with the same aptitudes. The ruleset is part
 * of the key: a ruleset change starts every ranked course afresh. Validators pass a stored result's own ruleset.
 */
export function rankedSeed(game: GameId, day: string, attempt: number, tokenId: string, ruleset = ARCADE_RULESET_VERSION): number {
    if (!RANKED_GAMES.includes(game) || !isRankingDay(day) || !Number.isInteger(attempt) || attempt < 1 || attempt > RANKED_ATTEMPTS || !validRankingTokenId(tokenId) ||
        !Number.isSafeInteger(ruleset) || ruleset < 1) {
        throw new Error("Invalid ranked attempt");
    }
    return fnv1a(`${ruleset}:ranked:${day}:${game}:${attempt}:${tokenId}`);
}
export function validRankedAttempt(value: unknown): value is RankedAttempt {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 2 && isRankingDay(v.day) && typeof v.attempt === "number" && Number.isInteger(v.attempt) && v.attempt >= 1 && v.attempt <= RANKED_ATTEMPTS;
}
export function validRankingTokenId(value: unknown): value is string {
    return typeof value === "string" && /^[1-9]\d{0,4}$/.test(value) && Number(value) <= GUARDIAN_MAX_SUPPLY;
}
/** The board/period pairs that exist. The season board answers to its own id whatever its dates: the seller judges those. */
export function validRankingBoard(board: string, period: string, season: Season): board is RankingBoardId {
    if (board === "season") return period === `s${season.id}`;
    return board === "devotion" ? period === "28d" : (RANKED_GAMES as readonly string[]).includes(board) && (GAME_PERIODS as readonly string[]).includes(period);
}
/** The page offset holding a 0-based place below the top rows. */
export function rankingPageOffset(index: number): number {
    return BOARD_ROWS + Math.floor(Math.max(0, index - BOARD_ROWS) / RANKING_PAGE_ROWS) * RANKING_PAGE_ROWS;
}
/** A page offset from a path: below the top rows, on the page grid, and inside the largest board there can be. */
export function parseRankingPageOffset(value: string): number | null {
    if (!/^[1-9]\d{1,4}$/.test(value)) return null;
    const offset = Number(value);
    return offset < GUARDIAN_MAX_SUPPLY && rankingPageOffset(offset) === offset ? offset : null;
}
/** A standings request names one to three guardians, ascending and unique, like a roster does. */
export function parseRankingIds(value: string): string[] | null {
    if (!/^[1-9]\d{0,4}(,[1-9]\d{0,4}){0,2}$/.test(value)) return null;
    const ids = value.split(",");
    return ids.every(validRankingTokenId) && ids.every((id, i) => i === 0 || Number(ids[i - 1]) < Number(id)) ? ids : null;
}

/**
 * A guardian's attendance streak (출석 도장) from the KST days it played a ranked round. Each played day adds one; a missed day
 * spends a held rest day (keeping the run without adding to it) or ends the run. Today never breaks a run before it is over.
 */
export function guardianStreak(days: readonly string[], today: string): GuardianStreak {
    const {current, best, freezes, playedToday} = streakProgress(days, today);
    return {current, best, freezes, playedToday};
}
/** The streak with `completed`: how many times a run reached a multiple of STREAK_FREEZE_EVERY, each the moment a rest day was earned. */
export function streakProgress(days: readonly string[], today: string): GuardianStreak & {completed: number} {
    const played = new Set(days.filter(day => isRankingDay(day) && day <= today));
    const first = [...played].sort()[0];
    let current = 0, best = 0, freezes = 0, completed = 0;
    if (first) {
        for (let day = first; day <= today; day = addDays(day, 1)) {
            if (played.has(day)) {
                current++;
                best = Math.max(best, current);
                if (current % STREAK_FREEZE_EVERY === 0) {freezes = Math.min(STREAK_FREEZE_MAX, freezes + 1); completed++;}
            } else if (day === today) break;
            else if (freezes > 0) freezes--;
            else {current = 0; freezes = 0;}
        }
    }
    return {current, best, freezes, completed, playedToday: played.has(today)};
}
/** The highest attendance milestone a longest streak reached, 0 if none. GuardianMetadata mirrors STREAK_MILESTONES. */
export function streakMilestone(best: number): number {
    return STREAK_MILESTONES.findLast(m => best >= m) ?? 0;
}
/** Last week's cosmetic titles: 장원 (#1), 급제 (#2–3), 입격 (#4–10). */
export function titlePlace(place: number): "champion" | "podium" | "top10" | null {
    if (!Number.isInteger(place) || place < 1 || place > BOARD_ROWS) return null;
    return place === 1 ? "champion" : place <= 3 ? "podium" : "top10";
}
