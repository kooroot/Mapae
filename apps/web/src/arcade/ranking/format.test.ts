import {describe, expect, test} from "bun:test";
import {emptyHonors, guardianName} from "@mapae/arcade/guardians";
import type {RankingStanding, RankingStandings, SeasonStanding} from "@mapae/arcade/ranking";
import type {SeasonStatus} from "@mapae/arcade/season";
import {
    attemptsBadge, attemptsLeft, bestSeasonStanding, boardScore, countdown, freshestGame, medalName, rankLine, rankShift, resetClock, seasonBannerCopy, seasonDate, seasonPhaseLabel,
    shiftCopy, streakCopy, titleName, titlesOnNft,
} from "./format";

const seed = `0x${"1".padStart(64, "0")}` as const;
const row = (rank: number, tokenId: string, score: number) => ({rank, tokenId, seed, score});
const standingAt = (rank: number, score: number, nearby: ReturnType<typeof row>[]): RankingStanding => ({
    rank, score, moves: false, prev: null, entrants: 20, leader: nearby[0]?.rank === 1 ? nearby[0].score : 400, above: nearby.find(r => r.rank === rank - 1) ?? null, nearby,
});

describe("rank movement", () => {
    test("up, down, unchanged and new against the earlier rank; nothing without a comparison", () => {
        expect(rankShift(3, {moves: true, prev: 5})).toEqual({kind: "up", by: 2});
        expect(rankShift(4, {moves: true, prev: 1})).toEqual({kind: "down", by: 3});
        expect(rankShift(2, {moves: true, prev: 2})).toEqual({kind: "same"});
        expect(rankShift(1, {moves: true, prev: null})).toEqual({kind: "new"});
        expect(rankShift(1, {moves: false, prev: null})).toBeNull();
    });
    test("every mark has a sentence naming the earlier window, in both languages", () => {
        expect(shiftCopy({kind: "up", by: 2}, "today", "ko")).toEqual({mark: "▲2", label: "어제보다 2계단 올라감"});
        expect(shiftCopy({kind: "up", by: 2}, "today", "en")).toEqual({mark: "▲2", label: "Up 2 from yesterday"});
        expect(shiftCopy({kind: "down", by: 1}, "week", "ko")).toEqual({mark: "▼1", label: "지난주보다 1계단 내려감"});
        expect(shiftCopy({kind: "same"}, "yesterday", "ko")).toEqual({mark: "–", label: "전날과 같은 순위"});
        expect(shiftCopy({kind: "same"}, "lastweek", "en").label).toBe("Same place as the week before");
        expect(shiftCopy({kind: "new"}, "today", "ko")).toEqual({mark: "NEW", label: "새로 오름 · 어제에는 기록 없음"});
        expect(shiftCopy({kind: "new"}, "28d", "ko").label).toBe("새로 오름 · 어제까지 28일 동안 기록 없음");
        expect(shiftCopy({kind: "new"}, "28d", "en").label).toBe("New: no record in the 28 days to yesterday");
        expect(shiftCopy({kind: "new"}, "week", "en").label).toBe("New: no record last week");
        expect(shiftCopy({kind: "down", by: 3}, "s1", "ko")).toEqual({mark: "▼3", label: "어제보다 3계단 내려감"});
        expect(shiftCopy({kind: "same"}, "s1", "en").label).toBe("Same place as yesterday");
    });
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
        expect(countdown({now, closesAt: week, period: "season", locale: "ko", offsetMinutes: 540})).toBe("시즌 종료까지 4일 12시간");
        expect(countdown({now, closesAt: week, period: "season", locale: "en", offsetMinutes: 0})).toBe("Season ends in 4d 12h (midnight KST) (Sun 3:00 PM your time)");
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
        const g = {tokenId: "1", streak: {current: 0, best: 0, freezes: 0, playedToday: false}, devotion: {rank: null, days: 0}, season: null, titles: [], games};
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
        expect(resetClock({now: closesAt - (17 * 86400 + 3600) * 1000, closesAt, period: "season", locale: "ko"}).label).toBe("시즌 종료까지 17일 1:00:00");
        expect(resetClock({now: closesAt - 3600 * 1000, closesAt, period: "season", locale: "en"}).label).toBe("Season ends in 1:00:00");
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

describe("season copy", () => {
    const status = (phase: SeasonStatus["phase"], today: string): SeasonStatus => phase === "pending" ? {id: 1, start: null, end: null, today, phase}
        : {id: 1, start: "2026-11-02", end: "2026-11-29", today, phase};
    const mine: SeasonStanding = {moves: true, prev: 4, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 30};
    test("the lobby banner names the phase, the countdown, the days left and my best guardian", () => {
        expect(seasonBannerCopy(status("pending", "2026-10-20"), null, "ko")).toBe("시즌 1 준비 중 · 커피 기프티콘과 한정 문양이 걸려요 · 규칙 미리 보기");
        expect(seasonBannerCopy(status("pending", "2026-10-20"), null, "en")).toBe("Season 1 is coming · coffee gift cards and a limited mark · Preview the rules");
        expect(seasonBannerCopy(status("announced", "2026-10-20"), null, "ko")).toBe("시즌 1 · D-13 · 11월 2일 시작");
        expect(seasonBannerCopy(status("announced", "2026-10-20"), mine, "en")).toBe("Season 1 · 13 days to go · starts Nov 2");
        expect(seasonBannerCopy(status("announced", "2026-11-01"), null, "ko")).toBe("시즌 1 · D-1 · 내일 시작");
        expect(seasonBannerCopy(status("announced", "2026-11-01"), null, "en")).toBe("Season 1 · starts tomorrow");
        expect(seasonBannerCopy(status("open", "2026-11-10"), mine, "ko")).toBe("시즌 1 진행 중 · 남은 20일 · 내 전령 187점 · 2위");
        expect(seasonBannerCopy(status("open", "2026-11-10"), mine, "en")).toBe("Season 1 live · 20 days left · my guardian 187 pts · #2");
        expect(seasonBannerCopy(status("open", "2026-11-10"), null, "ko")).toBe("시즌 1 진행 중 · 남은 20일 · 매일 최대 30점");
        expect(seasonBannerCopy(status("open", "2026-11-10"), null, "en")).toBe("Season 1 live · 20 days left · up to 30 pts a day");
        expect(seasonBannerCopy(status("open", "2026-11-29"), {...mine, points: 1, rank: 40}, "ko")).toBe("시즌 1 진행 중 · 오늘 마지막 날 · 내 전령 1점 · 40위");
        expect(seasonBannerCopy(status("open", "2026-11-29"), {...mine, points: 1, rank: 40}, "en")).toBe("Season 1 live · last day today · my guardian 1 pt · #40");
        expect(seasonBannerCopy(status("closed", "2026-11-30"), mine, "ko")).toBe("시즌 1 종료 · 최종 순위 보기");
        expect(seasonBannerCopy(status("closed", "2026-11-30"), null, "en")).toBe("Season 1 is over · See the final board");
    });
    test("phase labels and dates", () => {
        expect(seasonPhaseLabel(status("pending", "2026-10-20"), "ko")).toBe("준비 중"); expect(seasonPhaseLabel(status("pending", "2026-10-20"), "en")).toBe("Coming soon");
        expect(seasonPhaseLabel(status("announced", "2026-10-20"), "ko")).toBe("D-13"); expect(seasonPhaseLabel(status("announced", "2026-11-01"), "en")).toBe("1 day to go");
        expect(seasonPhaseLabel(status("open", "2026-11-10"), "ko")).toBe("진행 중 · 남은 20일"); expect(seasonPhaseLabel(status("open", "2026-11-29"), "en")).toBe("Live · 1 day left");
        expect(seasonPhaseLabel(status("closed", "2026-12-01"), "ko")).toBe("종료"); expect(seasonPhaseLabel(status("closed", "2026-12-01"), "en")).toBe("Final");
        expect(seasonDate("2026-11-02", "ko")).toBe("11월 2일"); expect(seasonDate("2026-11-02", "en")).toBe("Nov 2"); expect(seasonDate("2027-01-31", "en")).toBe("Jan 31");
    });
    test("the banner speaks for the best placed of my guardians", () => {
        const g = (tokenId: string, season: SeasonStanding | null) => ({tokenId, season}) as RankingStandings["guardians"][number];
        const standings = {guardians: [g("1", {...mine, rank: 5}), g("2", mine), g("3", null), g("4", {...mine, rank: 1})]} as RankingStandings;
        expect(bestSeasonStanding(standings, ["1", "2", "3"])?.rank).toBe(2);
        expect(bestSeasonStanding(standings, ["3"])).toBeNull(); expect(bestSeasonStanding(null, ["1"])).toBeNull();
        expect(bestSeasonStanding(standings, ["4", "1"])?.rank).toBe(1);
    });
});
