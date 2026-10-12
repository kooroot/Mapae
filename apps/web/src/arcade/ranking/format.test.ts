import {describe, expect, test} from "bun:test";
import {emptyHonors, guardianName} from "@mapae/arcade/guardians";
import type {RankingStanding, RankingStandings} from "@mapae/arcade/ranking";
import {attemptsBadge, attemptsLeft, boardScore, countdown, freshestGame, medalName, rankLine, resetClock, streakCopy, titleName, titlesOnNft} from "./format";

const seed = `0x${"1".padStart(64, "0")}` as const;
const row = (rank: number, tokenId: string, score: number) => ({rank, tokenId, seed, score});
const standingAt = (rank: number, score: number, nearby: ReturnType<typeof row>[]): RankingStanding => ({
    rank, score, entrants: 20, leader: nearby[0]?.rank === 1 ? nearby[0].score : 400, above: nearby.find(r => r.rank === rank - 1) ?? null, nearby,
});

describe("rank line", () => {
    test("no record yet: the first record, or the mark to beat", () => {
        expect(rankLine({locale: "ko", attemptsUsed: 0, standing: null, leader: null})).toBe("오늘 첫 기록을 남겨 보세요 · 랭크 도전 3판");
        expect(rankLine({locale: "ko", attemptsUsed: 1, standing: null, leader: 1234})).toBe("오늘 랭크 도전 2판 남음 · 지금 1위 1,234점");
        expect(rankLine({locale: "en", attemptsUsed: 2, standing: null, leader: 1})).toBe("1 ranked try left today · #1 has 1 pt");
        expect(rankLine({locale: "ko", attemptsUsed: 3, standing: null, leader: 50})).toContain("결과를 기다리는 중");
    });
    test("gaps to #1 and to the place above, named", () => {
        const third = standingAt(3, 300, [row(1, "1", 400), row(2, "2", 320), row(3, "3", 300), row(4, "4", 200)]);
        expect(rankLine({locale: "ko", attemptsUsed: 1, standing: third, leader: 400}))
            .toBe(`오늘 3위 · 1위까지 100점 · 2위 ${guardianName("2", "ko")}까지 20점 · 랭크 도전 2판 남음`);
        const second = standingAt(2, 320, [row(1, "1", 400), row(2, "2", 320)]);
        expect(rankLine({locale: "en", attemptsUsed: 1, standing: second, leader: 400})).toBe(`#2 today · 80 pts to #1 ${guardianName("1", "en")} · 2 ranked tries left`);
        const far = standingAt(14, 1440, [row(12, "12", 1600), row(13, "13", 1510), row(14, "14", 1440)]);
        expect(rankLine({locale: "ko", attemptsUsed: 1, standing: {...far, leader: 2500}, leader: 2500})).toContain("1위까지 1,060점");
        const tied = standingAt(2, 400, [row(1, "1", 400), row(2, "2", 400)]);
        expect(rankLine({locale: "ko", attemptsUsed: 1, standing: tied, leader: 400})).toContain(`1위 ${guardianName("1", "ko")}: 동점`);
    });
    test("first place shows the lead; spent tries close the day calmly", () => {
        const first = standingAt(1, 400, [row(1, "1", 400), row(2, "2", 350)]);
        expect(rankLine({locale: "ko", attemptsUsed: 1, standing: first, leader: 400})).toBe("오늘 1위! · 2위와 50점 차 · 랭크 도전 2판 남음");
        expect(rankLine({locale: "en", attemptsUsed: 1, standing: {...first, nearby: [row(1, "1", 400)]}, leader: 400})).toBe("#1 today · 2 ranked tries left");
        expect(rankLine({locale: "ko", attemptsUsed: 3, standing: first, leader: 400})).toBe("오늘 1위로 마감 · 자정에 도전 3판이 다시 열려요");
    });
});

describe("countdown", () => {
    const now = Date.parse("2026-10-14T03:00:00Z"), day = Date.parse("2026-10-14T15:00:00Z"), week = Date.parse("2026-10-18T15:00:00Z");
    test("KST visitors see only the span", () => {
        expect(countdown({now, closesAt: day, period: "day", locale: "ko", offsetMinutes: 540})).toBe("한국 시간 자정까지 12시간 0분");
        expect(countdown({now, closesAt: week, period: "week", locale: "ko", offsetMinutes: 540})).toBe("월요일 0시까지 4일 12시간");
        expect(countdown({now: day - 30_000, closesAt: day, period: "day", locale: "en", offsetMinutes: 540})).toBe("Resets in 1m (midnight KST)");
    });
    test("elsewhere the reset is also given in local time", () => {
        expect(countdown({now, closesAt: day, period: "day", locale: "en", offsetMinutes: -240})).toBe("Resets in 12h 0m (midnight KST) (11:00 AM your time)");
        expect(countdown({now, closesAt: week, period: "week", locale: "ko", offsetMinutes: 0})).toBe("월요일 0시까지 4일 12시간 (내 시간 일요일 오후 3:00)");
    });
});

describe("streak, titles, scores", () => {
    test("streak copy names the next stamp and today's gap", () => {
        expect(streakCopy({current: 0, best: 0, freezes: 0, playedToday: false}, "ko").title).toBe("첫 랭크 도전으로 도장을 시작해요");
        expect(streakCopy({current: 0, best: 5, freezes: 0, playedToday: false}, "en").title).toBe("New stamp book · best 5 days");
        expect(streakCopy({current: 5, best: 9, freezes: 1, playedToday: false}, "ko")).toEqual({title: "출석 도장 5일째 · 쉼표 1개", detail: "7일 도장까지 2일 · 오늘 도장은 아직이에요"});
        expect(streakCopy({current: 120, best: 120, freezes: 2, playedToday: true}, "en").detail).toBe("Every stamp collected");
    });
    test("titles, units, attempt nudges and the freshest game", () => {
        expect([1, 3, 10, 11].map(p => titleName(p, "ko"))).toEqual(["장원", "급제", "입격", null]);
        expect(boardScore("devotion", 1, "en")).toBe("1 day"); expect(boardScore("race", 2500, "ko")).toBe("2,500점");
        const games = {stamp: {attemptsUsed: 3, today: null, week: null}, race: {attemptsUsed: 1, today: null, week: null}, shop: {attemptsUsed: 1, today: null, week: null}};
        const g = {tokenId: "1", streak: {current: 0, best: 0, freezes: 0, playedToday: false}, devotion: {rank: null, days: 0}, titles: [], games};
        const standings = {guardians: [g, {...g, tokenId: "2"}]} as unknown as RankingStandings;
        expect(attemptsLeft(standings)).toBe(8); expect(attemptsLeft(null)).toBe(0);
        expect(attemptsBadge(8, "ko")).toBe("도전 8"); expect(attemptsBadge(0, "en")).toBeUndefined();
        expect(freshestGame(g)).toBe("race"); expect(freshestGame(undefined)).toBe("stamp");
    });
});
describe("reset clock and medals", () => {
    test("ticks to the second, adds days for weekly boards, and flags the last hour and ten minutes", () => {
        const closesAt = Date.UTC(2026, 9, 11, 15);
        expect(resetClock({now: closesAt - (3 * 3600 + 12 * 60 + 45) * 1000, closesAt, period: "day", locale: "ko"})).toEqual({label: "자정까지 3:12:45", soon: false, final: false});
        expect(resetClock({now: closesAt - (2 * 86400 + 5) * 1000, closesAt, period: "week", locale: "ko"}).label).toBe("월요일 0시까지 2일 0:00:05");
        expect(resetClock({now: closesAt - 59 * 60_000, closesAt, period: "day", locale: "en"})).toEqual({label: "Resets in 0:59:00", soon: true, final: false});
        expect(resetClock({now: closesAt - 9 * 60_000, closesAt, period: "day", locale: "en"})).toMatchObject({soon: true, final: true});
        expect(resetClock({now: closesAt + 5000, closesAt, period: "day", locale: "ko"}).label).toBe("자정까지 0:00:00");
    });
    test("only places 1 to 3 have a medal name", () => {
        expect([1, 2, 3].map(r => medalName(r, "ko"))).toEqual(["금메달", "은메달", "동메달"]);
        expect(medalName(1, "en")).toBe("Gold medal");
        expect(medalName(4, "ko")).toBeNull(); expect(medalName(0, "en")).toBeNull();
    });
});

test("last week's titles read as on the NFT once its honors reach that week", () => {
    // Standings for the week of 2026-10-12 show the titles of week 2961 (2026-10-05).
    expect(titlesOnNft(emptyHonors(), "2026-10-12")).toBe(false);
    expect(titlesOnNft({...emptyHonors(), week: 2960}, "2026-10-12")).toBe(false);
    expect(titlesOnNft({...emptyHonors(), week: 2961}, "2026-10-12")).toBe(true);
    expect(titlesOnNft({...emptyHonors(), week: 2961}, "2026-10-19")).toBe(false);
});
