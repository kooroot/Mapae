import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {pad, toHex, type Hex} from "viem";
import {guardianName, guardianZodiac, type GuardianZodiac} from "@mapae/arcade/guardians";
import {raffleDraw, seasonMarks, type SealedHall} from "@mapae/arcade/hall";
import type {GuardianDesk} from "../nft/useGuardianDesk";
import {HallOfFame} from "./HallOfFame";

const seedFor = (zodiac: GuardianZodiac) => {for (let i = 0; ; i++) {const seed = pad(toHex(i), {size: 32}); if (guardianZodiac(seed) === zodiac) return seed;}};
const BLOCK_HASH = `0xabcd${"0".repeat(56)}ef12` as Hex, seed = {12: seedFor("tiger"), 5: seedFor("ox"), 88: seedFor("rat"), 7: seedFor("pig")};
const hall: SealedHall = {season: 1, sealed: true, sealedAt: Date.parse("2026-11-03T15:00:00Z"), start: "2026-10-05", end: "2026-11-01", entrants: 4,
    podium: [{rank: 1, tokenId: "12", seed: seed[12], points: 187, days: 9}, {rank: 2, tokenId: "5", seed: seed[5], points: 120, days: 8}, {rank: 2, tokenId: "88", seed: seed[88], points: 120, days: 9}],
    teams: [{rank: 1, zodiac: "tiger", points: 1240, members: 18, top: {tokenId: "12", seed: seed[12], points: 187}}],
    champions: [{week: "2026-10-05", game: "stamp", tokenId: "12", seed: seed[12], score: 1234}],
    streakPool: [{tokenId: "5", seed: seed[5], runs: 1}, {tokenId: "12", seed: seed[12], runs: 2}], closeBlock: {number: "31700000", hash: BLOCK_HASH}, raffle: raffleDraw(BLOCK_HASH, ["5", "12"]), participants: ["5", "7", "12", "88"]};
/** The hall needs only the locale, my revealed guardians and their marks from the desk. */
const desk = (locale: "ko" | "en", revealed: {tokenId: string; seed: Hex}[]): GuardianDesk =>
    ({ko: locale === "ko", locale, revealed, marksOf: (tokenId: string) => seasonMarks(hall, tokenId, revealed.find(t => t.tokenId === tokenId)!.seed)} as unknown as GuardianDesk);

test("the hall: podium with marks, the winning team, champions, the raffle pool with its winners and block, my marks and the prize notes", () => {
    const html = renderToStaticMarkup(<HallOfFame desk={desk("ko", [{tokenId: "12", seed: seed[12]}, {tokenId: "7", seed: seed[7]}])} hall={hall} />);
    expect(html).toContain('id="hall"'); expect(html).toContain("시즌 1 명예의 전당"); expect(html).toContain("참가 4 · 확정 11월 4일");
    expect(html).toContain(`<strong>${guardianName("12", "ko")}<span class="season-marks"`); expect(html).toContain(">시즌 1 시상대 1위 문양</title>"); expect(html).toContain(">시즌 1 우승 호랑이팀 표식</title>");
    expect(html).toContain("우승 팀</h3>"); expect(html).toContain("호랑이팀 · 1,240점 · 팀원 18명 모두 우승 팀 표식"); expect(html).toContain('src="/arcade/guardians/tiger-256.webp"');
    expect(html).toContain(`10월 5일 주 · 도깨비 도장찍기 ${guardianName("12", "ko")} · 1,234점`);
    expect(html).toContain("7일 연속 출석 추첨"); expect(html).toContain("블록 #31,700,000 · 0xabcd…ef12"); expect(html).toContain(`${guardianName("5", "ko")} · 7일 연속 1회`);
    expect((html.match(/class="is-winner"/g) ?? []).length).toBe(2); expect((html.match(/>당첨</g) ?? []).length).toBe(2);
    expect(html).toContain(`<span>내 전령 ${guardianName("12", "ko")}: 시상대 1위 문양 · 우승 호랑이팀 표식 · 참가 문양</span>`); expect(html).toContain(`<span>내 전령 ${guardianName("7", "ko")}: 참가 문양</span>`);
    expect(html).toContain("상품 전달</h3>"); expect(html).toContain("시즌 상위 3명과 7일 연속 출석 추첨 5명에게 커피 기프티콘을 드려요."); expect(html).toContain("테스트넷이라 실제 돈은 오가지 않아요.");
});
test("in English, with no guardian of mine and two teams sharing first, the marks line is absent and the team heading says so", () => {
    const shared: SealedHall = {...hall, teams: [...hall.teams, {rank: 1, zodiac: "ox", points: 1240, members: 3, top: {tokenId: "5", seed: seed[5], points: 120}}]};
    const html = renderToStaticMarkup(<HallOfFame desk={desk("en", [])} hall={shared} />);
    expect(html).toContain("Season 1 hall of fame"); expect(html).toContain("4 entrants · sealed Nov 4"); expect(html).toContain("Shared first · teams</h3>");
    expect(html).toContain("Team Tiger · 1,240 pts · all 18 members wear the winners&#x27; mark"); expect(html).toContain("Team Ox · 1,240 pts · all 3 members wear the winners&#x27; mark");
    expect(html).toContain(">Season 1 winning team · Ox</title>"); expect(html).not.toContain("rank-hall-mine"); expect(html).toContain("Prizes</h3>");
    expect(html).toContain("Pool sorted by guardian number; pick i is keccak256(block hash ‖ i) mod remaining · 5 winners · block #31,700,000 · 0xabcd…ef12");
});
test("an empty pool and no champions say so instead of drawing nothing", () => {
    const quiet: SealedHall = {...hall, champions: [], streakPool: [], raffle: []};
    const ko = renderToStaticMarkup(<HallOfFame desk={desk("ko", [])} hall={quiet} />), en = renderToStaticMarkup(<HallOfFame desk={desk("en", [])} hall={quiet} />);
    expect(ko).toContain("이번 시즌에는 주간 장원이 없었어요."); expect(ko).toContain("7일 연속 출석을 완주한 전령이 없어 추첨은 없었어요.");
    expect(en).toContain("No weekly champion this season."); expect(en).toContain("Nobody completed a 7-day run, so there was no draw."); expect(en).not.toContain("is-winner");
});
