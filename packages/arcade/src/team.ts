import type {Hex} from "viem";
import {GUARDIAN_ZODIACS, type GuardianZodiac} from "./guardians";
import type {Season} from "./season";

/**
 * The zodiac team race: every guardian belongs to the team its birth zodiac names, for good. A team's score is the sum of its
 * members' points in the window, so the twelve teams race by total; the per-member average is shown beside it but never ranks.
 * The weekly board adds this week's daily-board points and is open all year; the season board adds season points, bonus and all.
 */
export type TeamPeriod = "week" | `s${number}`;
/** A guardian's share of its team: its public birth seed and points, nothing about its owner. */
export type TeamMember = {tokenId: string; seed: Hex; points: number};
/** One team's row: `members` counts guardians with a ranked round in the window, `top` the one that brought the most. */
export type TeamRow = {rank: number; zodiac: GuardianZodiac; points: number; members: number; top: TeamMember | null};
/** Always twelve rows, one per zodiac, teams without a member included at the bottom. */
export type TeamBoard = {period: TeamPeriod; from: string; to: string; closesAt: number | null; entrants: number; rows: TeamRow[]};

/** The team periods that exist: this week, and the season by its id whatever its dates (the seller judges those). */
export const validTeamPeriod = (period: string, season: Season): period is TeamPeriod => period === "week" || period === `s${season.id}`;

/**
 * The twelve team rows from each member's points: totals descending, an equal total sharing its place (and sorting in zodiac
 * order), the next place counting every row above it. A team's top contributor is its highest-scoring member, the lower token on
 * a tie.
 */
export function teamBoardRows(members: readonly (TeamMember & {zodiac: GuardianZodiac})[]): TeamRow[] {
    const teams = new Map(GUARDIAN_ZODIACS.map(zodiac => [zodiac, {points: 0, members: 0, top: null as TeamMember | null}]));
    for (const {zodiac, tokenId, seed, points} of members) {
        const team = teams.get(zodiac)!;
        team.points += points;
        team.members++;
        if (!team.top || points > team.top.points || (points === team.top.points && Number(tokenId) < Number(team.top.tokenId))) team.top = {tokenId, seed, points};
    }
    const rows = GUARDIAN_ZODIACS.map(zodiac => ({rank: 0, zodiac, ...teams.get(zodiac)!}));
    rows.sort((a, b) => b.points - a.points || GUARDIAN_ZODIACS.indexOf(a.zodiac) - GUARDIAN_ZODIACS.indexOf(b.zodiac));
    let rank = 0;
    return rows.map((row, i) => {if (i === 0 || rows[i - 1]!.points !== row.points) rank = i + 1; return {...row, rank};});
}

/**
 * Where a team stands against the top: its place, the points to #1 (0 when it is there), and, while it leads alone, its lead
 * over the best of the rest (0 when it shares first place or trails).
 */
export function teamGap(rows: readonly TeamRow[], zodiac: GuardianZodiac): {rank: number; toFirst: number; lead: number} {
    const mine = rows.find(row => row.zodiac === zodiac), first = rows[0];
    if (!mine || !first) throw new Error("Unknown team");
    const rest = rows.find(row => row.zodiac !== zodiac);
    return {rank: mine.rank, toFirst: first.points - mine.points, lead: mine.rank === 1 && rest ? mine.points - rest.points : 0};
}
