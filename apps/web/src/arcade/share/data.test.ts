import {expect, test} from "bun:test";
import type {Hex} from "viem";
import type {RankedCard, SeasonCard, SeasonStanding} from "@mapae/arcade/ranking";
import {parseRankedCard, parseSeasonCard} from "./data";

const SEED_A = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const SEED_B = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const season: SeasonStanding = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};
const ranked: RankedCard = {game: "race", day: "2026-10-14", tokenId: "407", seed: SEED_A, score: 12_340, rank: 3, entrants: 41, leader: 15_000, final: false, season};
const closed: SeasonCard = {tokenId: "12", seed: SEED_B, status: {id: 1, start: "2026-10-05", end: "2026-11-01", today: "2026-11-03", phase: "closed"}, season: {...season, rank: 1, today: 0}};

test("a ranked card answer is copied only when it echoes the request and holds together", () => {
    const today = "2026-10-14", raw = {...ranked, seed: SEED_A.toUpperCase().replace("0X", "0x")};
    expect(parseRankedCard(raw, "race", "2026-10-14", "407", today)).toEqual(ranked);
    expect(parseRankedCard({...ranked, season: null}, "race", "2026-10-14", "407", today)?.season).toBeNull();
    for (const bad of [
        {...ranked, game: "shop"}, {...ranked, day: "2026-10-13"}, {...ranked, tokenId: "408"}, {...ranked, seed: "0x12"}, {...ranked, score: -1}, {...ranked, score: 1e10},
        {...ranked, rank: 0}, {...ranked, rank: 42}, {...ranked, entrants: 10_001, rank: 10_001}, {...ranked, leader: 12_000}, {...ranked, rank: 1}, {...ranked, leader: 12_340},
        {...ranked, final: true}, {...ranked, season: {...season, points: 5}}, {...ranked, extra: 1}, [], null, "card",
    ]) expect(parseRankedCard(bad, "race", "2026-10-14", "407", today)).toBeNull();
    expect(parseRankedCard({...ranked, day: "2026-10-13", final: true}, "race", "2026-10-13", "407", today)?.final).toBe(true);
    expect(parseRankedCard({...ranked, day: "2026-10-13"}, "race", "2026-10-13", "407", today)).toBeNull();
});
test("a season card answer needs our season in a phase with a board and a standing in it", () => {
    const ours = {id: 1, start: "2026-10-05", end: "2026-11-01"};
    expect(parseSeasonCard(closed, "12", ours)).toEqual(closed);
    for (const bad of [
        {...closed, tokenId: "13"}, {...closed, seed: "nope"}, {...closed, status: {...closed.status, id: 2}}, {...closed, status: {...closed.status, phase: "open"}},
        {...closed, status: {id: 1, start: null, end: null, today: "2026-10-01", phase: "pending"}}, {...closed, season: null}, {...closed, season: {...season, streak: 10}}, {...closed, more: true},
    ]) expect(parseSeasonCard(bad, "12", ours)).toBeNull();
    expect(parseSeasonCard(closed, "12", {id: 2, start: null, end: null})).toBeNull();
});
