import {describe, expect, test} from "bun:test";
import {pad, toHex} from "viem";
import {GUARDIAN_ZODIACS, guardianTraits, guardianZodiac, type GuardianZodiac} from "./guardians";
import {SEASON} from "./season";
import {teamBoardRows, teamGap, validTeamPeriod, type TeamMember} from "./team";

/** The lowest numbered seed born into `zodiac`: a few dozen hashes at most. */
export function seedFor(zodiac: GuardianZodiac) {
    for (let i = 0; ; i++) {const seed = pad(toHex(i), {size: 32}); if (guardianZodiac(seed) === zodiac) return seed;}
}
const member = (zodiac: GuardianZodiac, tokenId: string, points: number): TeamMember & {zodiac: GuardianZodiac} => ({zodiac, tokenId, seed: seedFor(zodiac), points});

describe("zodiac teams", () => {
    test("the team is the birth zodiac, the same one the whole trait decoder finds", () => {
        for (let i = 0; i < 64; i++) {const seed = pad(toHex(i * 7919), {size: 32}); expect(guardianZodiac(seed)).toBe(guardianTraits(seed).zodiac);}
        expect(() => guardianZodiac("0x01")).toThrow();
        expect(new Set(GUARDIAN_ZODIACS.map(seedFor)).size).toBe(12);
    });
    test("twelve rows always: totals descending, empty teams last in zodiac order", () => {
        const rows = teamBoardRows([member("tiger", "12", 187), member("tiger", "5", 120), member("rat", "88", 44), member("pig", "7", 3)]);
        expect(rows).toHaveLength(12);
        expect(rows.slice(0, 3)).toEqual([
            {rank: 1, zodiac: "tiger", points: 307, members: 2, top: {tokenId: "12", seed: seedFor("tiger"), points: 187}},
            {rank: 2, zodiac: "rat", points: 44, members: 1, top: {tokenId: "88", seed: seedFor("rat"), points: 44}},
            {rank: 3, zodiac: "pig", points: 3, members: 1, top: {tokenId: "7", seed: seedFor("pig"), points: 3}},
        ]);
        expect(rows.slice(3).map(r => [r.rank, r.zodiac, r.points, r.members, r.top])).toEqual(GUARDIAN_ZODIACS.filter(z => !["tiger", "rat", "pig"].includes(z)).map(z => [4, z, 0, 0, null]));
        expect(teamBoardRows([]).map(r => [r.rank, r.zodiac])).toEqual(GUARDIAN_ZODIACS.map(z => [1, z]));
    });
    test("an equal total shares its place and sorts by zodiac; the top member is the higher score, then the lower token", () => {
        const rows = teamBoardRows([member("dog", "9", 10), member("ox", "40", 10), member("ox", "41", 12), member("dog", "3", 10), member("dog", "50", 2), member("rabbit", "1", 1)]);
        expect(rows.slice(0, 4).map(r => [r.rank, r.zodiac, r.points, r.members, r.top?.tokenId, r.top?.points])).toEqual([
            [1, "ox", 22, 2, "41", 12], [1, "dog", 22, 3, "3", 10], [3, "rabbit", 1, 1, "1", 1], [4, "rat", 0, 0, undefined, undefined]]);
        expect(rows.slice(3).every(r => r.rank === 4 && r.points === 0)).toBe(true);
    });
    test("the gap to first: trailing, leading alone, and sharing the lead", () => {
        const rows = teamBoardRows([member("tiger", "1", 100), member("rat", "2", 60), member("ox", "3", 60), member("pig", "4", 5)]);
        expect(teamGap(rows, "pig")).toEqual({rank: 4, toFirst: 95, lead: 0});
        expect(teamGap(rows, "tiger")).toEqual({rank: 1, toFirst: 0, lead: 40});
        expect(teamGap(rows, "dog")).toEqual({rank: 5, toFirst: 100, lead: 0});
        const tied = teamBoardRows([member("rat", "2", 60), member("ox", "3", 60)]);
        expect(teamGap(tied, "ox")).toEqual({rank: 1, toFirst: 0, lead: 0});
        expect(teamGap(teamBoardRows([]), "horse")).toEqual({rank: 1, toFirst: 0, lead: 0});
        expect(() => teamGap(tied.slice(0, 2), "pig")).toThrow();
    });
    test("periods: this week, or the season by its id", () => {
        expect(validTeamPeriod("week", SEASON)).toBe(true); expect(validTeamPeriod("s1", SEASON)).toBe(true);
        for (const bad of ["s2", "today", "lastweek", "28d", "s01", ""]) expect(validTeamPeriod(bad, SEASON)).toBe(false);
        expect(validTeamPeriod("s2", {id: 2, start: null, end: null})).toBe(true);
    });
});
