import {describe, expect, test} from "bun:test";
import {emptyHonors, guardianName} from "@mapae/arcade/guardians";
import type {RankingStanding, RankingStandings, SeasonStanding} from "@mapae/arcade/ranking";
import type {SeasonStatus} from "@mapae/arcade/season";
import type {TeamRow} from "@mapae/arcade/team";
import {
    attemptsBadge, attemptsLeft, averagePoints, bestSeasonStanding, boardScore, championCopy, closeBlockCopy, countdown, finalStandingCopy, freshestGame, hallChip, medalName, myTeamShare,
    prizeNotes, raffleFormula, rankLine, rankShift, resetClock, seasonBannerCopy, seasonDate, seasonPhaseLabel, shiftCopy, streakCopy, streakEntrantCopy, tallyNotice, teamCheerCopy, teamIntro,
    teamName, teamRowDetail, teamWinnerCopy, titleName, titlesOnNft,
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
        const g = {tokenId: "1", streak: {current: 0, best: 0, freezes: 0, playedToday: false}, devotion: {rank: null, days: 0}, season: null, weekPoints: 0, titles: [], games};
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
        expect(seasonBannerCopy(status("closed", "2026-11-30"), mine, "ko")).toBe("시즌 1 종료 · 최종 집계 중 · 화요일 0시 확정");
        expect(seasonBannerCopy(status("closed", "2026-11-30"), null, "en")).toBe("Season 1 is over · final tally Tue 00:00 KST");
        expect(seasonBannerCopy(status("closed", "2026-12-01"), null, "ko", true)).toBe("시즌 1 종료 · 명예의 전당 보기");
        expect(seasonBannerCopy(status("closed", "2026-12-01"), null, "en", true)).toBe("Season 1 is over · See the hall of fame");
        expect(seasonBannerCopy(status("closed", "2026-12-01"), mine, "ko", true)).toBe("시즌 1 종료 · 내 전령 최종 2위 · 명예의 전당 보기");
        expect(seasonBannerCopy(status("closed", "2026-12-01"), mine, "en", true)).toBe("Season 1 is over · my guardian finished #2 · See the hall of fame");
    });
    test("a closed season tallies until it seals: the overline, the notice and my final line say so", () => {
        expect(seasonPhaseLabel(status("closed", "2026-12-01"), "ko", true)).toBe("최종 순위"); expect(seasonPhaseLabel(status("closed", "2026-12-01"), "en", true)).toBe("Final standings");
        expect(tallyNotice("ko")).toBe("최종 순위는 화요일 0시(한국 시간)에 확정돼요. 늦게 정산된 모험이 들어올 수 있어요.");
        expect(tallyNotice("en")).toBe("Final standings lock at Tuesday 00:00 KST, once late settlements are in.");
        expect(finalStandingCopy(mine, "ko", true)).toBe("최종 2위/212 · 187점"); expect(finalStandingCopy(mine, "en", true)).toBe("Finished #2 of 212 · 187 pts");
        expect(finalStandingCopy(mine, "ko", false)).toBe("최종 2위/212 · 187점 (집계 중)"); expect(finalStandingCopy({...mine, points: 1}, "en", false)).toBe("Finished #2 of 212 · 1 pt (tally pending)");
    });
    test("the hall of fame lines: the chip, the winning team, a champion, a raffle entrant, the formula, the block and the prize notes", () => {
        const hall = {entrants: 212, sealedAt: Date.parse("2026-11-03T15:00:00Z"), closeBlock: {number: "31700000", hash: `0xabcd${"0".repeat(56)}ef12`}} as Parameters<typeof hallChip>[0];
        expect(hallChip(hall, "ko")).toBe("참가 212 · 확정 11월 4일"); expect(hallChip(hall, "en")).toBe("212 entrants · sealed Nov 4"); expect(hallChip({...hall, entrants: 1}, "en")).toBe("1 entrant · sealed Nov 4");
        const tiger = {rank: 1, zodiac: "tiger", points: 1240, members: 18, top: null} as const;
        expect(teamWinnerCopy(tiger, "ko")).toBe("호랑이팀 · 1,240점 · 팀원 18명 모두 우승 팀 표식"); expect(teamWinnerCopy(tiger, "en")).toBe("Team Tiger · 1,240 pts · all 18 members wear the winners' mark");
        expect(teamWinnerCopy({...tiger, members: 1}, "en")).toBe("Team Tiger · 1,240 pts · all 1 member wears the winners' mark");
        const champion = {week: "2026-10-05", game: "stamp", tokenId: "12", seed, score: 1234} as const;
        expect(championCopy(champion, "ko")).toBe(`10월 5일 주 · 도깨비 도장찍기 ${guardianName("12", "ko")} · 1,234점`); expect(championCopy(champion, "en")).toBe(`Week of Oct 5 · Dokkaebi Stamp ${guardianName("12", "en")} · 1,234 pts`);
        expect(streakEntrantCopy("407", 2, "ko")).toBe(`${guardianName("407", "ko")} · 7일 연속 2회`); expect(streakEntrantCopy("407", 1, "en")).toBe(`${guardianName("407", "en")} · 1 run of 7 days`);
        expect(raffleFormula("ko")).toBe("풀을 전령 번호 순으로 세우고 i번째 당첨은 keccak256(블록 해시 ‖ i) mod 남은 수 · 5명");
        expect(raffleFormula("en")).toBe("Pool sorted by guardian number; pick i is keccak256(block hash ‖ i) mod remaining · 5 winners");
        expect(closeBlockCopy(hall.closeBlock, "ko")).toBe("블록 #31,700,000 · 0xabcd…ef12"); expect(closeBlockCopy(hall.closeBlock, "en")).toBe("block #31,700,000 · 0xabcd…ef12");
        expect(prizeNotes("ko")).toEqual([
            "시즌 상위 3명과 7일 연속 출석 추첨 5명에게 커피 기프티콘을 드려요.",
            "추첨은 시즌 종료 직후 첫 GIWA 블록 해시로 뽑아요: 풀을 전령 번호 순으로 세우고 keccak256(블록 해시 ‖ i)로 i번째를 고르니 누구나 다시 셀 수 있어요.",
            "공유는 확인할 길이 없어 추첨 자격은 시즌 안 7일 연속 출석 1회 이상만 봐요.",
            "당첨된 전령의 주인은 X에서 @mapae_io에 전령 번호(#407)를 DM으로 보내 주세요. X 계정 하나에 상품 하나예요.",
            "소유 확인으로 지갑의 '메시지 서명'을 한 번 부탁드려요 — 안내하는 문장을 서명해 보내면 돼요. 가스도 트랜잭션도 없어요.",
            "테스트넷이라 실제 돈은 오가지 않아요.",
        ]);
        expect(prizeNotes("en")).toEqual([
            "Coffee gift cards go to the top 3 and to 5 guardians drawn from the 7-day-streak pool.",
            "The draw uses the hash of the first GIWA block after the season closed: the pool sorted by guardian number, the i-th pick from keccak256(block hash ‖ i), so anyone can recompute it.",
            "Sharing cannot be verified, so eligibility is one completed 7-day run inside the season and nothing else.",
            "Owners DM @mapae_io on X with the guardian's number (#407). One prize per X account.",
            "To confirm ownership you sign one message in your wallet; no gas, no transaction.",
            "Testnet only — no real money moves.",
        ]);
    });
    test("phase labels and dates", () => {
        expect(seasonPhaseLabel(status("pending", "2026-10-20"), "ko")).toBe("준비 중"); expect(seasonPhaseLabel(status("pending", "2026-10-20"), "en")).toBe("Coming soon");
        expect(seasonPhaseLabel(status("announced", "2026-10-20"), "ko")).toBe("D-13"); expect(seasonPhaseLabel(status("announced", "2026-11-01"), "en")).toBe("1 day to go");
        expect(seasonPhaseLabel(status("open", "2026-11-10"), "ko")).toBe("진행 중 · 남은 20일"); expect(seasonPhaseLabel(status("open", "2026-11-29"), "en")).toBe("Live · 1 day left");
        expect(seasonPhaseLabel(status("closed", "2026-12-01"), "ko")).toBe("종료 · 최종 집계 중"); expect(seasonPhaseLabel(status("closed", "2026-12-01"), "en")).toBe("Final tally pending");
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
describe("zodiac teams", () => {
    const team = (rank: number, zodiac: TeamRow["zodiac"], points: number, members: number, top: [string, number] | null): TeamRow =>
        ({rank, zodiac, points, members, top: top && {tokenId: top[0], seed, points: top[1]}});
    const rows = [team(1, "tiger", 307, 2, ["12", 187]), team(2, "rat", 44, 1, ["88", 44]), team(2, "ox", 44, 3, ["5", 20]), team(4, "pig", 0, 0, null)];
    test("names, averages and the row detail", () => {
        expect(teamName("tiger", "ko")).toBe("호랑이팀"); expect(teamName("tiger", "en")).toBe("Team Tiger");
        expect(averagePoints(307, 2, "ko")).toBe("평균 153.5점"); expect(averagePoints(307, 2, "en")).toBe("avg 153.5 pts");
        expect(averagePoints(44, 3, "ko")).toBe("평균 14.7점"); expect(averagePoints(20, 2, "en")).toBe("avg 10 pts"); expect(averagePoints(0, 0, "ko")).toBe("평균 0점");
        expect(teamRowDetail(rows[0]!, "ko")).toBe(`2명 · 평균 153.5점 · 최고 기여 ${guardianName("12", "ko")} 187점`);
        expect(teamRowDetail(rows[0]!, "en")).toBe(`2 members · avg 153.5 pts · top: ${guardianName("12", "en")} 187 pts`);
        expect(teamRowDetail(rows[1]!, "en")).toBe(`1 member · avg 44 pts · top: ${guardianName("88", "en")} 44 pts`);
        expect(teamRowDetail(rows[3]!, "ko")).toBe("아직 참가 없음 · 랭크 도전 한 판이면 첫 점수");
        expect(teamRowDetail(rows[3]!, "en")).toBe("No entrants yet · one ranked round opens the score");
    });
    test("the cheer line: leading alone, sharing first, or chasing", () => {
        expect(teamCheerCopy(rows, "tiger", "ko")).toBe("우리 호랑이팀 1위 · 2위보다 263점 앞섬"); expect(teamCheerCopy(rows, "tiger", "en")).toBe("Team Tiger leads · 263 pts ahead");
        expect(teamCheerCopy(rows, "ox", "ko")).toBe("우리 소팀 2위 · 1위까지 263점"); expect(teamCheerCopy(rows, "ox", "en")).toBe("Team Ox #2 · 263 pts to #1");
        expect(teamCheerCopy(rows, "pig", "en")).toBe("Team Pig #4 · 307 pts to #1");
        const tied = [team(1, "rat", 44, 1, ["88", 44]), team(1, "ox", 44, 3, ["5", 20]), team(3, "pig", 0, 0, null)];
        expect(teamCheerCopy(tied, "ox", "ko")).toBe("우리 소팀 공동 1위"); expect(teamCheerCopy(tied, "ox", "en")).toBe("Team Ox tied for #1");
        expect(() => teamCheerCopy(rows, "dog", "ko")).toThrow("Unknown team");
    });
    test("the cheer line once the season is over: won, shared first, or how it finished, pending until the seal", () => {
        expect(teamCheerCopy(rows, "tiger", "ko", "sealed")).toBe("우리 호랑이팀 우승 · 2위보다 263점 앞섬"); expect(teamCheerCopy(rows, "tiger", "en", "sealed")).toBe("Team Tiger won the season · 263 pts ahead");
        expect(teamCheerCopy(rows, "ox", "ko", "sealed")).toBe("우리 소팀 최종 2위 · 1위와 263점 차"); expect(teamCheerCopy(rows, "ox", "en", "sealed")).toBe("Team Ox finished #2 · 263 pts behind");
        expect(teamCheerCopy(rows, "pig", "ko", "pending")).toBe("우리 돼지팀 최종 4위 · 1위와 307점 차 (집계 중)"); expect(teamCheerCopy(rows, "tiger", "en", "pending")).toBe("Team Tiger won the season · 263 pts ahead (tally pending)");
        const tied = [team(1, "rat", 44, 1, ["88", 44]), team(1, "ox", 44, 3, ["5", 20]), team(3, "pig", 0, 0, null)];
        expect(teamCheerCopy(tied, "ox", "ko", "sealed")).toBe("우리 소팀 공동 우승"); expect(teamCheerCopy(tied, "ox", "en", "sealed")).toBe("Team Ox shared first");
        expect(teamIntro("ko", true)[4]).toBe("1위 팀 전령 모두 우승 팀 표식을 달았어요."); expect(teamIntro("en", true)[4]).toBe("Every guardian of the winning team now wears the mark.");
        expect(teamIntro("en", true).slice(0, 4)).toEqual(teamIntro("en").slice(0, 4));
    });
    test("my share and the intro", () => {
        expect(myTeamShare(45, 307, "ko")).toBe("내 기여 45점 (15%)"); expect(myTeamShare(45, 307, "en")).toBe("my share 45 pts (15%)");
        expect(myTeamShare(0, 0, "ko")).toBe("내 기여 0점"); expect(myTeamShare(1, 1, "en")).toBe("my share 1 pt (100%)");
        expect(teamIntro("ko")).toHaveLength(5); expect(teamIntro("en")).toHaveLength(5);
        expect(teamIntro("ko")[4]).toContain("우승 팀 표식"); expect(teamIntro("en")[1]).toContain("no attendance bonus");
    });
});
