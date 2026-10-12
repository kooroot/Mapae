import type {GameId} from "@mapae/arcade";
import {guardianName, type GuardianHonors} from "@mapae/arcade/guardians";
import {
    addDays, RANKED_ATTEMPTS, RANKED_GAMES, rankingWeekIndex, STREAK_FREEZE_EVERY, STREAK_MILESTONES, titlePlace,
    type GuardianStreak, type RankingBoardId, type RankingMove, type RankingPeriod, type RankingStanding, type RankingStandings,
} from "@mapae/arcade/ranking";
import type {Locale} from "../../lib/i18n";

const KST_MINUTES = 9 * 60;
const MINUTE = 60_000;

/**
 * The one line that tells a guardian's owner where it stands today and what is in reach: the gap to #1 and to the place just
 * above while tries remain, a calm close once they are spent.
 */
export function rankLine({locale, attemptsUsed, standing, leader}: {
    locale: Locale; attemptsUsed: number; standing: RankingStanding | null; leader: number | null;
}): string {
    const ko = locale === "ko", left = Math.max(0, RANKED_ATTEMPTS - attemptsUsed);
    const tries = ko ? `랭크 도전 ${left}판 남음` : `${left} ranked ${left === 1 ? "try" : "tries"} left`;
    if (!standing) {
        if (left === 0) return ko ? "오늘 랭크 도전 결과를 기다리는 중 · 곧 순위에 올라가요" : "Today’s ranked rounds are settling · on the board soon";
        if (leader === null) return ko ? `오늘 첫 기록을 남겨 보세요 · 랭크 도전 ${left}판` : `Set today’s first record · ${left} ranked ${left === 1 ? "try" : "tries"}`;
        return ko ? `오늘 랭크 도전 ${left}판 남음 · 지금 1위 ${points(leader, locale)}` : `${tries} today · #1 has ${points(leader, locale)}`;
    }
    const {rank} = standing;
    if (left === 0) return ko ? `오늘 ${rank}위로 마감 · 자정에 도전 ${RANKED_ATTEMPTS}판이 다시 열려요` : `Finished #${rank} today · ${RANKED_ATTEMPTS} new tries at midnight (KST)`;
    if (rank === 1) {
        const second = standing.nearby.find(row => row.rank === 2);
        const lead = second ? ko ? ` · 2위와 ${points(standing.score - second.score, locale)} 차` : ` · ${points(standing.score - second.score, locale)} ahead` : "";
        return ko ? `오늘 1위!${lead} · ${tries}` : `#1 today${lead} · ${tries}`;
    }
    const parts = [ko ? `오늘 ${rank}위` : `#${rank} today`, gap(1, standing.leader - standing.score, locale, rank === 2 ? standing.above?.tokenId : undefined)];
    if (rank > 2 && standing.above) parts.push(gap(standing.above.rank, standing.above.score - standing.score, locale, standing.above.tokenId));
    return [...parts, tries].join(" · ");
}
function gap(place: number, difference: number, locale: Locale, tokenId?: string): string {
    const ko = locale === "ko", name = tokenId ? ` ${guardianName(tokenId, locale)}` : "";
    if (difference === 0) return ko ? `${place}위${name}: 동점` : `level with #${place}${name}`;
    return ko ? `${place}위${name}까지 ${points(difference, locale)}` : `${points(difference, locale)} to #${place}${name}`;
}
export function points(value: number, locale: Locale): string {
    return locale === "ko" ? `${value.toLocaleString("ko-KR")}점` : `${value.toLocaleString("en-US")} ${value === 1 ? "pt" : "pts"}`;
}
/** A board's score with its unit: points, or days for devotion. */
export function boardScore(board: RankingBoardId, value: number, locale: Locale): string {
    if (board !== "devotion") return points(value, locale);
    return locale === "ko" ? `${value}일` : `${value} ${value === 1 ? "day" : "days"}`;
}
export function placeLabel(rank: number, locale: Locale): string {
    return locale === "ko" ? `${rank}위` : `#${rank}`;
}

export type RankShift = {kind: "up" | "down"; by: number} | {kind: "same" | "new"};
/** How a place moved since the board one window earlier; null when the seller found nothing fair to compare with. */
export function rankShift(rank: number, {moves, prev}: RankingMove): RankShift | null {
    if (!moves) return null;
    if (prev === null) return {kind: "new"};
    return prev === rank ? {kind: "same"} : prev > rank ? {kind: "up", by: prev - rank} : {kind: "down", by: rank - prev};
}
/** The earlier window each period is measured against, with the Korean comparison particle it takes. */
const SINCE: Record<RankingPeriod, {ko: [string, string]; en: string}> = {
    today: {ko: ["어제", "와"], en: "yesterday"}, yesterday: {ko: ["전날", "과"], en: "the day before"},
    week: {ko: ["지난주", "와"], en: "last week"}, lastweek: {ko: ["전주", "와"], en: "the week before"}, "28d": {ko: ["어제", "와"], en: "yesterday"},
};
/** The movement tick's short mark and the sentence that says it in words, so colour and arrows never carry it alone. */
export function shiftCopy(shift: RankShift, period: RankingPeriod, locale: Locale): {mark: string; label: string} {
    const [since, particle] = SINCE[period].ko, en = SINCE[period].en;
    switch (shift.kind) {
    case "up": return {mark: `▲${shift.by}`, label: locale === "ko" ? `${since}보다 ${shift.by}계단 올라감` : `Up ${shift.by} from ${en}`};
    case "down": return {mark: `▼${shift.by}`, label: locale === "ko" ? `${since}보다 ${shift.by}계단 내려감` : `Down ${shift.by} from ${en}`};
    case "same": return {mark: "–", label: locale === "ko" ? `${since}${particle} 같은 순위` : `Same place as ${en}`};
    case "new": return {mark: "NEW", label: locale === "ko" ? `새로 오름 · ${since}에는 기록 없음` : `New: no record ${en}`};
    }
}

/**
 * Time left in a window, in Korean time, plus the reset in the visitor's own clock when it is not KST. `offsetMinutes` is the
 * visitor's UTC offset (east positive), passed in so the line is the same on the server and in tests.
 */
export function countdown({now, closesAt, period, locale, offsetMinutes}: {
    now: number; closesAt: number; period: "day" | "week"; locale: Locale; offsetMinutes: number;
}): string {
    const ko = locale === "ko", left = Math.max(MINUTE, closesAt - now);
    const days = Math.floor(left / (24 * 60 * MINUTE)), hours = Math.floor(left / (60 * MINUTE)) % 24, minutes = Math.floor(left / MINUTE) % 60;
    const span = ko
        ? days ? `${days}일 ${hours}시간` : hours ? `${hours}시간 ${minutes}분` : `${minutes}분`
        : days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    const local = offsetMinutes === KST_MINUTES ? "" : ko ? ` (내 시간 ${clock(closesAt, offsetMinutes, period, locale)})` : ` (${clock(closesAt, offsetMinutes, period, locale)} your time)`;
    if (ko) return `${period === "day" ? "한국 시간 자정까지" : "월요일 0시까지"} ${span}${local}`;
    return `Resets in ${span} (${period === "day" ? "midnight KST" : "Monday 00:00 KST"})${local}`;
}
/** The reset chip: a ticking clock to the window's close, flagged under an hour and pulsing in the last ten minutes. */
export function resetClock({now, closesAt, period, locale}: {now: number; closesAt: number; period: "day" | "week"; locale: Locale}): {label: string; soon: boolean; final: boolean} {
    const left = Math.max(0, closesAt - now), seconds = Math.floor(left / 1000) % 60, minutes = Math.floor(left / MINUTE) % 60;
    const hours = Math.floor(left / (60 * MINUTE)) % 24, days = Math.floor(left / (24 * 60 * MINUTE)), ko = locale === "ko";
    const time = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    const span = days ? ko ? `${days}일 ${time}` : `${days}d ${time}` : time;
    const label = ko ? `${period === "day" ? "자정까지" : "월요일 0시까지"} ${span}` : `Resets in ${span}`;
    return {label, soon: left < 60 * MINUTE, final: left < 10 * MINUTE};
}
/** Medal names for places 1–3, which always travel with the numeral; colour alone never carries the rank. */
export function medalName(rank: number, locale: Locale): string | null {
    if (rank < 1 || rank > 3) return null;
    return (locale === "ko" ? ["금메달", "은메달", "동메달"] : ["Gold medal", "Silver medal", "Bronze medal"])[rank - 1]!;
}
function clock(at: number, offsetMinutes: number, period: "day" | "week", locale: Locale): string {
    const local = new Date(at + offsetMinutes * MINUTE), hour = local.getUTCHours(), minute = String(local.getUTCMinutes()).padStart(2, "0");
    const twelve = hour % 12 || 12, ko = locale === "ko";
    const weekday = period === "week" ? ko ? `${"일월화수목금토"[local.getUTCDay()]}요일 ` : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()]} ` : "";
    return ko ? `${weekday}${hour < 12 ? "오전" : "오후"} ${twelve}:${minute}` : `${weekday}${twelve}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

/** The streak card: where the run stands, and the next stamp (or how a run starts). */
export function streakCopy(streak: GuardianStreak, locale: Locale): {title: string; detail: string} {
    const ko = locale === "ko", {current, best, freezes} = streak;
    if (current === 0) {
        return best > 0
            ? {title: ko ? `새 도장첩 · 최고 ${best}일` : `New stamp book · best ${best} ${best === 1 ? "day" : "days"}`,
                detail: ko ? "오늘 랭크 도전 한 판으로 다시 시작해요" : "One ranked round today starts it again"}
            : {title: ko ? "첫 랭크 도전으로 도장을 시작해요" : "Your first ranked round starts the streak",
                detail: ko ? `${STREAK_FREEZE_EVERY}일마다 쉼표 1개` : `a rest day every ${STREAK_FREEZE_EVERY}`};
    }
    const title = ko ? `출석 도장 ${current}일째 · 쉼표 ${freezes}개` : `${current}-day streak · ${freezes} rest ${freezes === 1 ? "day" : "days"}`;
    const milestone = STREAK_MILESTONES.find(m => m > current);
    const next = milestone === undefined ? null : ko ? `${milestone}일 도장까지 ${milestone - current}일` : `${milestone - current} to the ${milestone}-day stamp`;
    const today = streak.playedToday ? null : ko ? "오늘 도장은 아직이에요" : "not stamped today yet";
    return {title, detail: [next, today].filter(Boolean).join(" · ") || (ko ? "가장 높은 도장을 모았어요" : "Every stamp collected")};
}

export const TITLE_NAMES: Record<Locale, Record<"champion" | "podium" | "top10", string>> = {
    ko: {champion: "장원", podium: "급제", top10: "입격"},
    en: {champion: "Champion", podium: "Podium", top10: "Top 10"},
};
export function titleName(place: number, locale: Locale): string | null {
    const title = titlePlace(place);
    return title ? TITLE_NAMES[locale][title] : null;
}

/** Whether the NFT already carries last week's titles: its honors reach the week before `standingsWeek` (this week's Monday). */
export function titlesOnNft(honors: GuardianHonors, standingsWeek: string): boolean {
    return honors.week >= rankingWeekIndex(addDays(standingsWeek, -7));
}

/** Ranked tries the crew has left today across every game: the menu's nudge. */
export function attemptsLeft(standings: RankingStandings | null): number {
    return standings?.guardians.reduce((sum, g) => sum + RANKED_GAMES.reduce((n, game) => n + Math.max(0, RANKED_ATTEMPTS - g.games[game].attemptsUsed), 0), 0) ?? 0;
}
export function attemptsBadge(left: number, locale: Locale): string | undefined {
    return left > 0 ? locale === "ko" ? `도전 ${left}` : `${left} left` : undefined;
}
/** The game with the most ranked tries left for a guardian, the first in game order on a tie. */
export function freshestGame(standing: RankingStandings["guardians"][number] | undefined): GameId {
    return RANKED_GAMES.reduce((best, game) => (standing?.games[game].attemptsUsed ?? 0) < (standing?.games[best].attemptsUsed ?? 0) ? game : best, RANKED_GAMES[0]);
}
