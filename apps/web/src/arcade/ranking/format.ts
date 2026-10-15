import type {GameId} from "@mapae/arcade";
import {GAME_NAMES} from "@mapae/arcade";
import {ZODIAC_NAMES} from "@mapae/arcade/guardian-art";
import {guardianName, type GuardianHonors, type GuardianZodiac} from "@mapae/arcade/guardians";
import {RAFFLE_WINNERS, type HallChampion, type SealedHall} from "@mapae/arcade/hall";
import {
    addDays, DEVOTION_DAYS, kstDay, RANKED_ATTEMPTS, RANKED_GAMES, rankingWeekIndex, STREAK_FREEZE_EVERY, STREAK_MILESTONES, titlePlace,
    type GamePeriod, type GuardianStreak, type RankingBoardId, type RankingMove, type RankingPeriod, type RankingStanding, type RankingStandings, type SeasonStanding,
} from "@mapae/arcade/ranking";
import {SEASON_MAX_DAY_POINTS, SEASON_STREAK_DAYS, seasonCountdown, seasonDaysLeft, type SeasonStatus} from "@mapae/arcade/season";
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
/** The season board's overline: where the season stands today; a closed season is tallying until its hall seals. */
export function seasonPhaseLabel(status: SeasonStatus, locale: Locale, sealed = false): string {
    const ko = locale === "ko";
    switch (status.phase) {
    case "pending": return ko ? "준비 중" : "Coming soon";
    case "announced": {const n = seasonCountdown(status, status.today); return ko ? `D-${n}` : `${n} ${n === 1 ? "day" : "days"} to go`;}
    case "open": {const n = seasonDaysLeft(status, status.today); return ko ? `진행 중 · 남은 ${n}일` : `Live · ${n} ${n === 1 ? "day" : "days"} left`;}
    case "closed": return sealed ? ko ? "최종 순위" : "Final standings" : ko ? "종료 · 최종 집계 중" : "Final tally pending";
    }
}
/** Under a closed board until it seals: when the standings lock, and why they may still move. */
export function tallyNotice(locale: Locale): string {
    return locale === "ko" ? "최종 순위는 화요일 0시(한국 시간)에 확정돼요. 늦게 정산된 모험이 들어올 수 있어요." : "Final standings lock at Tuesday 00:00 KST, once late settlements are in.";
}
const pending = (locale: Locale) => locale === "ko" ? " (집계 중)" : " (tally pending)";
/** My guardian's line once the season is over: its final place and points, marked as pending until the seal. */
export function finalStandingCopy(season: SeasonStanding, locale: Locale, sealed: boolean): string {
    const line = locale === "ko" ? `최종 ${season.rank}위/${season.entrants} · ${points(season.points, "ko")}` : `Finished #${season.rank} of ${season.entrants} · ${points(season.points, "en")}`;
    return sealed ? line : line + pending(locale);
}
/**
 * The lobby strip, one line per phase: what is on, what is at stake, and where my best guardian stands once there is a score.
 * Closed, it points at the hall of fame once the season has sealed, with my best final place when I have one.
 */
export function seasonBannerCopy(status: SeasonStatus, mine: SeasonStanding | null, locale: Locale, sealed = false): string {
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
    case "closed":
        if (!sealed) return ko ? `${name} 종료 · 최종 집계 중 · 화요일 0시 확정` : `${name} is over · final tally Tue 00:00 KST`;
        if (mine) return ko ? `${name} 종료 · 내 전령 최종 ${mine.rank}위 · 명예의 전당 보기` : `${name} is over · my guardian finished #${mine.rank} · See the hall of fame`;
        return ko ? `${name} 종료 · 명예의 전당 보기` : `${name} is over · See the hall of fame`;
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
/** How a closed season's team race reads: still tallying, or sealed for good; null while the race is on. */
export type TeamFinal = "pending" | "sealed" | null;
/** One line for my team: leading alone, sharing first, or how far from first; once the season is over, how it finished. */
export function teamCheerCopy(rows: readonly TeamRow[], zodiac: GuardianZodiac, locale: Locale, final: TeamFinal = null): string {
    const ko = locale === "ko", name = teamName(zodiac, locale), {rank, toFirst, lead} = teamGap(rows, zodiac);
    if (final) {
        const line = rank === 1 && lead > 0 ? ko ? `우리 ${name} 우승 · 2위보다 ${points(lead, locale)} 앞섬` : `${name} won the season · ${points(lead, locale)} ahead`
            : rank === 1 ? ko ? `우리 ${name} 공동 우승` : `${name} shared first`
            : ko ? `우리 ${name} 최종 ${rank}위 · 1위와 ${points(toFirst, locale)} 차` : `${name} finished #${rank} · ${points(toFirst, locale)} behind`;
        return final === "sealed" ? line : line + pending(locale);
    }
    if (rank === 1 && lead > 0) return ko ? `우리 ${name} 1위 · 2위보다 ${points(lead, locale)} 앞섬` : `${name} leads · ${points(lead, locale)} ahead`;
    if (rank === 1) return ko ? `우리 ${name} 공동 1위` : `${name} tied for #1`;
    return ko ? `우리 ${name} ${rank}위 · 1위까지 ${points(toFirst, locale)}` : `${name} #${rank} · ${points(toFirst, locale)} to #1`;
}
/** What my guardian brought to its team's total, with its share once the team has any points. */
export function myTeamShare(mine: number, total: number, locale: Locale): string {
    const share = total ? ` (${Math.round(mine / total * 100)}%)` : "";
    return locale === "ko" ? `내 기여 ${points(mine, locale)}${share}` : `my share ${points(mine, locale)}${share}`;
}
/** The team race in plain words: who is on a team, what counts, how places are decided, who is a member, and what the winners get (or got, once sealed). */
export function teamIntro(locale: Locale, sealed = false): string[] {
    if (sealed) return [...teamIntro(locale).slice(0, 4), locale === "ko" ? "1위 팀 전령 모두 우승 팀 표식을 달았어요." : "Every guardian of the winning team now wears the mark."];
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

/** The hall's chip: how many took part and when the standings sealed. */
export function hallChip(hall: SealedHall, locale: Locale): string {
    const sealed = seasonDate(kstDay(hall.sealedAt), locale);
    return locale === "ko" ? `참가 ${hall.entrants} · 확정 ${sealed}` : `${hall.entrants} ${hall.entrants === 1 ? "entrant" : "entrants"} · sealed ${sealed}`;
}
/** A winning team's row: the team, its total, and that every member wears the mark. */
export function teamWinnerCopy(team: TeamRow, locale: Locale): string {
    const name = teamName(team.zodiac, locale), total = points(team.points, locale);
    return locale === "ko" ? `${name} · ${total} · 팀원 ${team.members}명 모두 우승 팀 표식` : `${name} · ${total} · all ${team.members} ${team.members === 1 ? "member wears" : "members wear"} the winners' mark`;
}
/** A weekly champion's row: the week by its Monday, the game, the guardian and its weekly score. */
export function championCopy(champion: HallChampion, locale: Locale): string {
    const week = seasonDate(champion.week, locale), game = GAME_NAMES[locale][champion.game], name = guardianName(champion.tokenId, locale);
    return locale === "ko" ? `${week} 주 · ${game} ${name} · ${points(champion.score, "ko")}` : `Week of ${week} · ${game} ${name} · ${points(champion.score, "en")}`;
}
/** A raffle entrant's row: the guardian and how many full runs it completed. */
export function streakEntrantCopy(tokenId: string, runs: number, locale: Locale): string {
    return locale === "ko" ? `${guardianName(tokenId, "ko")} · ${SEASON_STREAK_DAYS}일 연속 ${runs}회` : `${guardianName(tokenId, "en")} · ${runs} ${runs === 1 ? "run" : "runs"} of ${SEASON_STREAK_DAYS} days`;
}
/** The draw in one line: the formula anyone can recompute. */
export function raffleFormula(locale: Locale): string {
    return locale === "ko" ? `풀을 전령 번호 순으로 세우고 i번째 당첨은 keccak256(블록 해시 ‖ i) mod 남은 수 · ${RAFFLE_WINNERS}명`
        : `Pool sorted by guardian number; pick i is keccak256(block hash ‖ i) mod remaining · ${RAFFLE_WINNERS} winners`;
}
/** The close block that seeded the draw: its number and a short hash. */
export function closeBlockCopy(block: SealedHall["closeBlock"], locale: Locale): string {
    return `${locale === "ko" ? "블록" : "block"} #${Number(block.number).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")} · ${block.hash.slice(0, 6)}…${block.hash.slice(-4)}`;
}
/** How prizes reach the winners, in six lines, shown only once the season has sealed. */
export function prizeNotes(locale: Locale): string[] {
    return locale === "ko" ? [
        `시즌 상위 3명과 ${SEASON_STREAK_DAYS}일 연속 출석 추첨 ${RAFFLE_WINNERS}명에게 커피 기프티콘을 드려요.`,
        "추첨은 시즌 종료 직후 첫 GIWA 블록 해시로 뽑아요: 풀을 전령 번호 순으로 세우고 keccak256(블록 해시 ‖ i)로 i번째를 고르니 누구나 다시 셀 수 있어요.",
        `공유는 확인할 길이 없어 추첨 자격은 시즌 안 ${SEASON_STREAK_DAYS}일 연속 출석 1회 이상만 봐요.`,
        "당첨된 전령의 주인은 X에서 @mapae_io에 전령 번호(#407)를 DM으로 보내 주세요. X 계정 하나에 상품 하나예요.",
        "소유 확인으로 지갑의 '메시지 서명'을 한 번 부탁드려요 — 안내하는 문장을 서명해 보내면 돼요. 가스도 트랜잭션도 없어요.",
        "테스트넷이라 실제 돈은 오가지 않아요.",
    ] : [
        `Coffee gift cards go to the top 3 and to ${RAFFLE_WINNERS} guardians drawn from the ${SEASON_STREAK_DAYS}-day-streak pool.`,
        "The draw uses the hash of the first GIWA block after the season closed: the pool sorted by guardian number, the i-th pick from keccak256(block hash ‖ i), so anyone can recompute it.",
        `Sharing cannot be verified, so eligibility is one completed ${SEASON_STREAK_DAYS}-day run inside the season and nothing else.`,
        "Owners DM @mapae_io on X with the guardian's number (#407). One prize per X account.",
        "To confirm ownership you sign one message in your wallet; no gas, no transaction.",
        "Testnet only — no real money moves.",
    ];
}
