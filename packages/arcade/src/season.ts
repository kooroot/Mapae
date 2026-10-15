import {addDays, BOARD_ROWS, daysBetween, isRankingDay, kstDay, RANKED_GAMES, STREAK_FREEZE_EVERY, streakProgress} from "./ranking";

/**
 * A season: a run of KST days in which the daily boards also earn season points. Dates stay null while the season is being
 * prepared; the operator sets both with a commit once the arcade is complete and stable. Only the seller reads the dates, so a
 * date change needs a seller restart and no web deploy: the web learns the phase from the seller's season status.
 */
export type Season = {id: number; start: string | null; end: string | null};
export const SEASON: Season = {id: 1, start: null, end: null};

/** Season points per game and day: places 1–3, then every other place in the top BOARD_ROWS, then every other entrant. */
export const SEASON_RANK_POINTS = [10, 7, 5] as const;
export const SEASON_TOP10_POINTS = 3;
export const SEASON_ENTRY_POINTS = 1;
export const SEASON_MAX_DAY_POINTS = SEASON_RANK_POINTS[0] * RANKED_GAMES.length;
/** Every full attendance run of this many days inside the season adds the bonus; rest days (쉼표) work as they always do. */
export const SEASON_STREAK_DAYS = STREAK_FREEZE_EVERY;
export const SEASON_STREAK_BONUS = 10;

export type SeasonPhase = "pending" | "announced" | "open" | "closed";
export type SeasonStatus = {id: number; start: string | null; end: string | null; today: string; phase: SeasonPhase};

const KST_OFFSET = 9 * 60 * 60 * 1000;

/** The board period a season answers to: `s1`. */
export const seasonPeriod = (season: Season): `s${number}` => `s${season.id}`;
/** A positive id, and either no dates yet or two ranking days in order. */
export function validSeason(season: Season): boolean {
    if (!Number.isInteger(season.id) || season.id < 1) return false;
    if (season.start === null || season.end === null) return season.start === null && season.end === null;
    return isRankingDay(season.start) && isRankingDay(season.end) && season.start <= season.end;
}
export function seasonPhase(season: Season, today: string): SeasonPhase {
    if (season.start === null || season.end === null) return "pending";
    return today < season.start ? "announced" : today <= season.end ? "open" : "closed";
}
export function seasonStatus(season: Season, at: number): SeasonStatus {
    const today = kstDay(at);
    return {id: season.id, start: season.start, end: season.end, today, phase: seasonPhase(season, today)};
}
/** The days that count so far: from the start to today, or to the end once it has passed; null before the season opens. */
export function seasonWindow(season: Season, today: string): {from: string; to: string} | null {
    const phase = seasonPhase(season, today);
    return phase === "open" || phase === "closed" ? {from: season.start!, to: today < season.end! ? today : season.end!} : null;
}
/** When an open season closes: 00:00 KST after its last day (epoch ms); null in any other phase. */
export function seasonClosesAt(season: Season, today: string): number | null {
    return seasonPhase(season, today) === "open" ? Date.parse(`${addDays(season.end!, 1)}T00:00:00Z`) - KST_OFFSET : null;
}
/** Days left in an open season counting today, so the last day reads 1. */
export function seasonDaysLeft(season: Season, today: string): number {
    return seasonPhase(season, today) === "open" ? daysBetween(today, season.end!) + 1 : 0;
}
/** Days until an announced season starts: D-n. */
export function seasonCountdown(season: Season, today: string): number {
    return seasonPhase(season, today) === "announced" ? daysBetween(today, season.start!) : 0;
}
/** What one place on a daily board is worth. */
export function seasonDayPoints(rank: number): number {
    return SEASON_RANK_POINTS[rank - 1] ?? (rank <= BOARD_ROWS ? SEASON_TOP10_POINTS : SEASON_ENTRY_POINTS);
}
/** The attendance run over the season's own days only: a run that began before the season starts counting at its first day. */
export function seasonStreak(days: readonly string[], today: string): {current: number; completed: number; bonus: number} {
    const {current, completed} = streakProgress(days, today);
    return {current, completed, bonus: completed * SEASON_STREAK_BONUS};
}
