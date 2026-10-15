import type {GameId} from "@mapae/arcade";
import {ZODIAC_NAMES} from "@mapae/arcade/guardian-art";
import {guardianName, type GuardianHonors, type GuardianZodiac} from "@mapae/arcade/guardians";
import {
    addDays, DEVOTION_DAYS, RANKED_ATTEMPTS, RANKED_GAMES, rankingWeekIndex, STREAK_FREEZE_EVERY, STREAK_MILESTONES, titlePlace,
    type GamePeriod, type GuardianStreak, type RankingBoardId, type RankingMove, type RankingPeriod, type RankingStanding, type RankingStandings, type SeasonStanding,
} from "@mapae/arcade/ranking";
import {SEASON_MAX_DAY_POINTS, seasonCountdown, seasonDaysLeft, type SeasonStatus} from "@mapae/arcade/season";
import {teamGap, type TeamRow} from "@mapae/arcade/team";
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
/** The earlier window each period is measured against, with the Korean comparison particle it takes; a season (`s1`) against yesterday's totals. */
const SINCE: Record<GamePeriod | "28d" | "season", {ko: [string, string]; en: string}> = {
    today: {ko: ["어제", "와"], en: "yesterday"}, yesterday: {ko: ["전날", "과"], en: "the day before"},
    week: {ko: ["지난주", "와"], en: "last week"}, lastweek: {ko: ["전주", "와"], en: "the week before"}, "28d": {ko: ["어제", "와"], en: "yesterday"}, season: {ko: ["어제", "와"], en: "yesterday"},
};
/** The movement tick's short mark and the sentence that says it in words, so colour and arrows never carry it alone. */
export function shiftCopy(shift: RankShift, period: RankingPeriod, locale: Locale): {mark: string; label: string} {
    const {ko: [since, particle], en} = period in SINCE ? SINCE[period as keyof typeof SINCE] : SINCE.season;
    switch (shift.kind) {
    case "up": return {mark: `▲${shift.by}`, label: locale === "ko" ? `${since}보다 ${shift.by}계단 올라감` : `Up ${shift.by} from ${en}`};
    case "down": return {mark: `▼${shift.by}`, label: locale === "ko" ? `${since}보다 ${shift.by}계단 내려감` : `Down ${shift.by} from ${en}`};
    case "same": return {mark: "–", label: locale === "ko" ? `${since}${particle} 같은 순위` : `Same place as ${en}`};
    // Devotion's earlier board is the 28 days to yesterday, so a newcomer there had no ranked day in all of them.
    case "new": return {mark: "NEW", label: period === "28d"
        ? locale === "ko" ? `새로 오름 · 어제까지 ${DEVOTION_DAYS}일 동안 기록 없음` : `New: no record in the ${DEVOTION_DAYS} days to yesterday`
        : locale === "ko" ? `새로 오름 · ${since}에는 기록 없음` : `New: no record ${en}`};
    }
}

/** Which close a clock counts to: the day's, the week's, or the season's. */
export type ClockPeriod = "day" | "week" | "season";
/**
 * Time left in a window, in Korean time, plus the reset in the visitor's own clock when it is not KST. `offsetMinutes` is the
 * visitor's UTC offset (east positive), passed in so the line is the same on the server and in tests.
 */
export function countdown({now, closesAt, period, locale, offsetMinutes}: {
    now: number; closesAt: number; period: ClockPeriod; locale: Locale; offsetMinutes: number;
}): string {
    const ko = locale === "ko", left = Math.max(MINUTE, closesAt - now);
    const days = Math.floor(left / (24 * 60 * MINUTE)), hours = Math.floor(left / (60 * MINUTE)) % 24, minutes = Math.floor(left / MINUTE) % 60;
    const span = ko
        ? days ? `${days}일 ${hours}시간` : hours ? `${hours}시간 ${minutes}분` : `${minutes}분`
        : days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    const local = offsetMinutes === KST_MINUTES ? "" : ko ? ` (내 시간 ${clock(closesAt, offsetMinutes, period, locale)})` : ` (${clock(closesAt, offsetMinutes, period, locale)} your time)`;
    if (ko) return `${period === "day" ? "한국 시간 자정까지" : period === "week" ? "월요일 0시까지" : "시즌 종료까지"} ${span}${local}`;
    return `${period === "season" ? "Season ends in" : "Resets in"} ${span} (${period === "week" ? "Monday 00:00 KST" : "midnight KST"})${local}`;
}
/** The reset chip: a ticking clock to the window's close, flagged under an hour and pulsing in the last ten minutes. */
export function resetClock({now, closesAt, period, locale}: {now: number; closesAt: number; period: ClockPeriod; locale: Locale}): {label: string; soon: boolean; final: boolean} {
    const left = Math.max(0, closesAt - now), seconds = Math.floor(left / 1000) % 60, minutes = Math.floor(left / MINUTE) % 60;
    const hours = Math.floor(left / (60 * MINUTE)) % 24, days = Math.floor(left / (24 * 60 * MINUTE)), ko = locale === "ko";
    const time = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    const span = days ? ko ? `${days}일 ${time}` : `${days}d ${time}` : time;
    const label = ko ? `${period === "day" ? "자정까지" : period === "week" ? "월요일 0시까지" : "시즌 종료까지"} ${span}` : `${period === "season" ? "Season ends in" : "Resets in"} ${span}`;
    return {label, soon: left < 60 * MINUTE, final: left < 10 * MINUTE};
}
/** Medal names for places 1–3, which always travel with the numeral; colour alone never carries the rank. */
export function medalName(rank: number, locale: Locale): string | null {
    if (rank < 1 || rank > 3) return null;
    return (locale === "ko" ? ["금메달", "은메달", "동메달"] : ["Gold medal", "Silver medal", "Bronze medal"])[rank - 1]!;
}
function clock(at: number, offsetMinutes: number, period: ClockPeriod, locale: Locale): string {
    const local = new Date(at + offsetMinutes * MINUTE), hour = local.getUTCHours(), minute = String(local.getUTCMinutes()).padStart(2, "0");
    const twelve = hour % 12 || 12, ko = locale === "ko";
    const weekday = period !== "day" ? ko ? `${"일월화수목금토"[local.getUTCDay()]}요일 ` : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()]} ` : "";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A ranking day as a short date: 11월 2일, Nov 2. */
export function seasonDate(day: string, locale: Locale): string {
    const month = Number(day.slice(5, 7)), date = Number(day.slice(8, 10));
    return locale === "ko" ? `${month}월 ${date}일` : `${MONTHS[month - 1]} ${date}`;
}
/** The season board's overline: where the season stands today. */
export function seasonPhaseLabel(status: SeasonStatus, locale: Locale): string {
    const ko = locale === "ko";
    switch (status.phase) {
    case "pending": return ko ? "준비 중" : "Coming soon";
    case "announced": {const n = seasonCountdown(status, status.today); return ko ? `D-${n}` : `${n} ${n === 1 ? "day" : "days"} to go`;}
    case "open": {const n = seasonDaysLeft(status, status.today); return ko ? `진행 중 · 남은 ${n}일` : `Live · ${n} ${n === 1 ? "day" : "days"} left`;}
    case "closed": return ko ? "종료" : "Final";
    }
}
/** The lobby strip, one line per phase: what is on, what is at stake, and where my best guardian stands once there is a score. */
export function seasonBannerCopy(status: SeasonStatus, mine: SeasonStanding | null, locale: Locale): string {
    const ko = locale === "ko", name = ko ? `시즌 ${status.id}` : `Season ${status.id}`;
    switch (status.phase) {
    case "pending": return ko ? `${name} 준비 중 · 커피 기프티콘과 한정 문양이 걸려요 · 규칙 미리 보기` : `${name} is coming · coffee gift cards and a limited mark · Preview the rules`;
    case "announced": {
        const n = seasonCountdown(status, status.today);
        if (n === 1) return ko ? `${name} · D-1 · 내일 시작` : `${name} · starts tomorrow`;
        return ko ? `${name} · D-${n} · ${seasonDate(status.start!, locale)} 시작` : `${name} · ${n} days to go · starts ${seasonDate(status.start!, locale)}`;
    }
    case "open": {
        const n = seasonDaysLeft(status, status.today), left = n === 1 ? ko ? "오늘 마지막 날" : "last day today" : ko ? `남은 ${n}일` : `${n} days left`;
        if (mine) return ko ? `${name} 진행 중 · ${left} · 내 전령 ${points(mine.points, locale)} · ${mine.rank}위` : `${name} live · ${left} · my guardian ${points(mine.points, locale)} · #${mine.rank}`;
        return ko ? `${name} 진행 중 · ${left} · 매일 최대 ${SEASON_MAX_DAY_POINTS}점` : `${name} live · ${left} · up to ${SEASON_MAX_DAY_POINTS} pts a day`;
    }
    case "closed": return ko ? `${name} 종료 · 최종 순위 보기` : `${name} is over · See the final board`;
    }
}
/** A zodiac team's name: 호랑이팀 / Team Tiger. */
export function teamName(zodiac: GuardianZodiac, locale: Locale): string {
    return locale === "ko" ? `${ZODIAC_NAMES.ko[zodiac]}팀` : `Team ${ZODIAC_NAMES.en[zodiac]}`;
}
/** Points a member of the team: one decimal, none when whole; shown beside the total, never ranked by. */
export function averagePoints(points: number, members: number, locale: Locale): string {
    const average = members ? Math.round(points / members * 10) / 10 : 0, text = average.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {maximumFractionDigits: 1});
    return locale === "ko" ? `평균 ${text}점` : `avg ${text} pts`;
}
/** A team row's second line: its members, the average and who brought the most; or that nobody has played yet. */
export function teamRowDetail(row: TeamRow, locale: Locale): string {
    const ko = locale === "ko";
    if (!row.top) return ko ? "아직 참가 없음 · 랭크 도전 한 판이면 첫 점수" : "No entrants yet · one ranked round opens the score";
    const who = `${guardianName(row.top.tokenId, locale)} ${points(row.top.points, locale)}`;
    return ko ? `${row.members}명 · ${averagePoints(row.points, row.members, locale)} · 최고 기여 ${who}`
        : `${row.members} ${row.members === 1 ? "member" : "members"} · ${averagePoints(row.points, row.members, locale)} · top: ${who}`;
}
/** One line for my team: leading alone, sharing first, or how far from first. */
export function teamCheerCopy(rows: readonly TeamRow[], zodiac: GuardianZodiac, locale: Locale): string {
    const ko = locale === "ko", name = teamName(zodiac, locale), {rank, toFirst, lead} = teamGap(rows, zodiac);
    if (rank === 1 && lead > 0) return ko ? `우리 ${name} 1위 · 2위보다 ${points(lead, locale)} 앞섬` : `${name} leads · ${points(lead, locale)} ahead`;
    if (rank === 1) return ko ? `우리 ${name} 공동 1위` : `${name} tied for #1`;
    return ko ? `우리 ${name} ${rank}위 · 1위까지 ${points(toFirst, locale)}` : `${name} #${rank} · ${points(toFirst, locale)} to #1`;
}
/** What my guardian brought to its team's total, with its share once the team has any points. */
export function myTeamShare(mine: number, total: number, locale: Locale): string {
    const share = total ? ` (${Math.round(mine / total * 100)}%)` : "";
    return locale === "ko" ? `내 기여 ${points(mine, locale)}${share}` : `my share ${points(mine, locale)}${share}`;
}
/** The team race in plain words: who is on a team, what counts, how places are decided, who is a member, and what the winners get. */
export function teamIntro(locale: Locale): string[] {
    return locale === "ko" ? [
        "전령은 태어난 띠대로 열두 팀 중 하나에 속해요. 바꿀 수 없고, 같은 띠 전령은 모두 한 팀이에요.",
        "팀 점수는 팀원이 받은 시즌 점수를 모두 더해요. 이번 주 보기는 이번 주 일별 순위 점수만 더하고(출석 보너스 없음), 시즌과 상관없이 늘 열려 있어요.",
        "순위는 합계로 정해요. 인원이 적은 팀을 위해 1인 평균도 함께 보여 주지만, 순위에는 들어가지 않아요.",
        "팀원 수는 그 기간에 랭크 도전을 한 번이라도 한 전령만 세요. 참가만 해도 팀에 1점이 가요.",
        "시즌이 끝날 때 1위 팀의 전령은 모두 우승 팀 표식을 받아요. 표식은 시즌이 끝난 뒤 열려요.",
    ] : [
        "Every guardian belongs to one of twelve zodiac teams from birth. It never changes, and every guardian of the same zodiac is a teammate.",
        "A team's score adds every member's season points. The weekly view adds only this week's daily-board points (no attendance bonus) and is open all year, season or not.",
        "Teams rank by total. The per-member average is shown for small teams but does not affect the ranking.",
        "Members are guardians with at least one ranked round in the window. Even taking part sends the team 1 point.",
        "When the season ends, every guardian of the winning team gets the winners' mark. The mark opens after the season.",
    ];
}
/** The guardian whose season place is best: the one the banner speaks for. */
export function bestSeasonStanding(standings: RankingStandings | null, tokenIds: readonly string[]): SeasonStanding | null {
    return standings?.guardians.filter(g => tokenIds.includes(g.tokenId)).reduce<SeasonStanding | null>((best, g) => g.season && (!best || g.season.rank < best.rank) ? g.season : best, null) ?? null;
}
