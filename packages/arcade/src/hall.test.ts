import {describe, expect, test} from "bun:test";
import {keccak256, toHex, type Hex} from "viem";
import {GUARDIAN_ZODIACS, guardianZodiac} from "./guardians";
import {hallPodium, hallSealsAt, hallTeams, raffleDraw, RAFFLE_WINNERS, seasonMarks, type HallRow, type SealedHall} from "./hall";
import {SEASON} from "./season";
import type {TeamRow} from "./team";

const seedOf = (n: number): Hex => keccak256(toHex(n, {size: 32}));
/** A seed whose guardian belongs to `zodiac`. */
const seedFor = (zodiac: (typeof GUARDIAN_ZODIACS)[number]): Hex => {for (let i = 1; ; i++) if (guardianZodiac(seedOf(i)) === zodiac) return seedOf(i);};
const block: Hex = "0x9f2c1e4b7a6d5c3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e";
const rows: HallRow[] = [
    {rank: 1, tokenId: "12", seed: seedOf(12), points: 220, days: 28}, {rank: 2, tokenId: "407", seed: seedOf(407), points: 187, days: 25},
    {rank: 2, tokenId: "9", seed: seedOf(9), points: 187, days: 20}, {rank: 4, tokenId: "33", seed: seedOf(33), points: 120, days: 12},
];
const team = (rank: number, zodiac: TeamRow["zodiac"], points: number): TeamRow => ({rank, zodiac, points, members: 3, top: null});
const hall: SealedHall = {
    season: 1, sealed: true, sealedAt: Date.parse("2026-11-02T15:00:00Z"), start: "2026-10-05", end: "2026-11-01", entrants: 4,
    podium: hallPodium(rows), teams: hallTeams([team(1, "tiger", 1240), team(2, "rabbit", 1120)]), champions: [], streakPool: [{tokenId: "9", seed: seedOf(9), runs: 2}],
    closeBlock: {number: "1234567", hash: block}, raffle: ["9"], participants: ["9", "12", "33", "407"],
};

describe("hall of fame", () => {
    test("a season seals at the Tuesday 00:00 KST cutoff of the week holding its last day; never without dates", () => {
        expect(hallSealsAt({id: 1, start: "2026-10-05", end: "2026-11-01"})).toBe(Date.parse("2026-11-02T15:00:00Z"));
        expect(hallSealsAt({id: 1, start: "2026-10-05", end: "2026-11-03"})).toBe(Date.parse("2026-11-09T15:00:00Z"));
        expect(hallSealsAt(SEASON)).toBeNull();
    });
    test("the podium keeps every shared place within three; the winning teams are the rows at first", () => {
        expect(hallPodium(rows).map(row => row.tokenId)).toEqual(["12", "407", "9"]);
        expect(hallTeams([team(1, "tiger", 10), team(1, "ox", 10), team(3, "rat", 1)]).map(row => row.zodiac)).toEqual(["tiger", "ox"]);
        // A season nobody entered ranks all twelve teams first at zero: none of them won.
        expect(hallTeams(GUARDIAN_ZODIACS.map(zodiac => ({...team(1, zodiac, 0), members: 0})))).toEqual([]);
    });
    test("marks come podium, team, entrant; a guardian off the boards or an unsealed hall has none", () => {
        expect(seasonMarks(hall, "407", seedFor("tiger"))).toEqual([{season: 1, kind: "podium", place: 2}, {season: 1, kind: "team", zodiac: "tiger"}, {season: 1, kind: "entrant"}]);
        expect(seasonMarks(hall, "33", seedFor("rabbit"))).toEqual([{season: 1, kind: "entrant"}]);
        expect(seasonMarks(hall, "33", seedFor("tiger"))).toEqual([{season: 1, kind: "team", zodiac: "tiger"}, {season: 1, kind: "entrant"}]);
        expect(seasonMarks(hall, "5000", seedFor("tiger"))).toEqual([]);
        expect(seasonMarks({season: 1, sealed: false, sealsAt: 0}, "12", seedFor("tiger"))).toEqual([]);
        expect(seasonMarks(null, "12", seedFor("tiger"))).toEqual([]);
    });
});
describe("raffle", () => {
    const pool = ["407", "12", "9", "33", "1200", "77", "5", "88"];
    test("the same seed and pool draw the same winners, without a repeat", () => {
        const winners = raffleDraw(block, pool);
        expect(winners).toHaveLength(RAFFLE_WINNERS); expect(new Set(winners).size).toBe(RAFFLE_WINNERS);
        expect(raffleDraw(block, pool)).toEqual(winners);
        expect(winners.every(id => pool.includes(id))).toBe(true);
    });
    test("the pool's order never matters: it is sorted by guardian number first", () => {
        expect(raffleDraw(block, [...pool].reverse())).toEqual(raffleDraw(block, pool));
        expect(raffleDraw(block, [...pool].sort())).toEqual(raffleDraw(block, pool));
    });
    test("each pick is keccak256(seed ‖ i) over the guardians still in", () => {
        const sorted = [...pool].sort((a, b) => Number(a) - Number(b));
        const first = Number(BigInt(keccak256(`${block}${"0".repeat(64)}`)) % BigInt(sorted.length));
        expect(raffleDraw(block, pool, 1)).toEqual([sorted[first]!]);
    });
    test("a pool smaller than the count all win; an empty pool draws nobody; another seed draws differently", () => {
        expect(raffleDraw(block, ["3", "1"])).toEqual(expect.arrayContaining(["1", "3"])); expect(raffleDraw(block, ["3", "1"])).toHaveLength(2);
        expect(raffleDraw(block, [])).toEqual([]);
        expect(raffleDraw(seedOf(1), pool)).not.toEqual(raffleDraw(block, pool));
    });
});
