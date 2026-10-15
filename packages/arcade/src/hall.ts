import {concat, keccak256, toHex, type Hex} from "viem";
import type {GameId} from "./contracts";
import {guardianZodiac, type GuardianZodiac} from "./guardians";
import {kstWeek, weekCutoff} from "./ranking";
import type {Season} from "./season";
import type {TeamRow} from "./team";

/**
 * The hall of fame: what a season leaves behind once it is sealed. The seller seals it once, at the first read after the last
 * week's cutoff, and keeps the JSON; the web draws the marks from it. Nothing here touches the chain: the Honor struct has no
 * lane for a season mark, so the marks are seller-sealed and rendered as SVG (a later contract upgrade could add `uint80 marks`
 * to Honor and move them on-chain without changing this shape).
 */
export const RAFFLE_WINNERS = 5;
export const HALL_PODIUM = 3;

/** A season mark on a guardian: a podium place, the winning team's flag, or the entrant stamp every ranked guardian gets. */
export type SeasonMark = {season: number; kind: "podium"; place: 1 | 2 | 3} | {season: number; kind: "team"; zodiac: GuardianZodiac} | {season: number; kind: "entrant"};
export type HallRow = {rank: number; tokenId: string; seed: Hex; points: number; days: number};
/** The first place of one game in one of the season's weeks, as the honor book sealed it. */
export type HallChampion = {week: string; game: GameId; tokenId: string; seed: Hex; score: number};
/** A raffle entrant: a guardian with at least one completed 7-day run inside the season. */
export type HallStreak = {tokenId: string; seed: Hex; runs: number};
export type SealedHall = {
    season: number; sealed: true; sealedAt: number; start: string; end: string; entrants: number;
    podium: HallRow[]; teams: TeamRow[]; champions: HallChampion[]; streakPool: HallStreak[];
    closeBlock: {number: string; hash: Hex}; raffle: string[]; participants: string[];
};
export type SeasonHall = {season: number; sealed: false; sealsAt: number} | SealedHall;

/** When a closed season seals: the cutoff of the KST week holding its last day (Tuesday 00:00 KST); null without dates. */
export function hallSealsAt(season: Season): number | null {
    return season.end === null ? null : weekCutoff(kstWeek(season.end));
}
/** The rows on the podium: places 1–3, more than three guardians when a place is shared. */
export const hallPodium = (rows: readonly HallRow[]): HallRow[] => rows.filter(row => row.rank <= HALL_PODIUM);
/** The winning team or, on a shared first place, every team on it. */
export const hallTeams = (rows: readonly TeamRow[]): TeamRow[] => rows.filter(row => row.rank === 1);
export const byTokenId = (a: string, b: string): number => Number(a) - Number(b);

/**
 * The raffle anyone can recompute: the pool in guardian-number order, then for each pick `i` the index
 * `keccak256(seed ‖ uint256(i)) mod remaining` of the guardians not yet drawn. The seed is the hash of the first GIWA block at or
 * after the season closed, which nobody can choose after seeing the pool.
 */
export function raffleDraw(seed: Hex, pool: readonly string[], count = RAFFLE_WINNERS): string[] {
    const remaining = [...new Set(pool)].sort(byTokenId), winners: string[] = [];
    for (let i = 0; i < count && remaining.length; i++) {
        const k = Number(BigInt(keccak256(concat([seed, toHex(i, {size: 32})]))) % BigInt(remaining.length));
        winners.push(remaining.splice(k, 1)[0]!);
    }
    return winners;
}
/** A guardian's marks from a sealed hall, podium first; a guardian off the season's boards has none. */
export function seasonMarks(hall: SeasonHall | null, tokenId: string, seed: Hex): SeasonMark[] {
    if (!hall?.sealed || !hall.participants.includes(tokenId)) return [];
    const marks: SeasonMark[] = [], place = hall.podium.find(row => row.tokenId === tokenId)?.rank;
    if (place === 1 || place === 2 || place === 3) marks.push({season: hall.season, kind: "podium", place});
    const zodiac = guardianZodiac(seed);
    if (hall.teams.some(team => team.zodiac === zodiac)) marks.push({season: hall.season, kind: "team", zodiac});
    marks.push({season: hall.season, kind: "entrant"});
    return marks;
}
