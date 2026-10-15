import {GAME_NAMES} from "@mapae/arcade";
import {guardianName} from "@mapae/arcade/guardians";
import type {RankingStanding, SeasonStanding} from "@mapae/arcade/ranking";
import {SEASON} from "@mapae/arcade/season";
import {landingUrl} from "../../lib/config";
import {localizePath, type Locale} from "../../lib/i18n";
import {points} from "../ranking/format";
import {sharePaths, type ShareTarget} from "./page";

const X_INTENT = "https://x.com/intent/post";
export type ShareLinks = {intent: string; page: string; card: string; download: string};

/** The origin shared links carry: the landing site, or on a combined dev server the page's own origin (none while rendering on the server). */
export function shareOrigin(): string {
    if (/^https?:\/\//.test(landingUrl)) return landingUrl.replace(/\/$/, "");
    return typeof window === "undefined" ? "" : window.location.origin;
}
/** The post itself: the guardian, the number that matters, and the arcade's account; the page link rides along as the card. */
export function shareText(target: ShareTarget, standing: Pick<RankingStanding, "score" | "rank" | "entrants"> | SeasonStanding, locale: Locale): string {
    const name = guardianName(target.tokenId, locale), ko = locale === "ko";
    if (target.kind === "run") {
        const {score, rank, entrants} = standing as RankingStanding, game = GAME_NAMES[locale][target.game];
        return ko ? `내 전령 ${name}: ${game} ${points(score, "ko")}, 오늘 ${rank}위/${entrants}명! @mapae_io 오락실에서 전령을 뽑아 겨뤄요 #Mapae #GIWA`
            : `My guardian ${name}: ${game} ${points(score, "en")}, #${rank} of ${entrants} today on the @mapae_io arcade. #Mapae #GIWA`;
    }
    const {points: total, rank, entrants} = standing as SeasonStanding;
    return ko ? `내 전령 ${name}: 시즌 ${SEASON.id} ${points(total, "ko")}, ${rank}위/${entrants}명. @mapae_io 오락실 시즌 ${SEASON.id} 진행 중 #Mapae #GIWA`
        : `${name}: Season ${SEASON.id}, ${points(total, "en")}, #${rank} of ${entrants} on the @mapae_io arcade. #Mapae #GIWA`;
}
export function shareLinks(target: ShareTarget, text: string, locale: Locale): ShareLinks {
    const paths = sharePaths(target), page = `${shareOrigin()}${localizePath(paths.page, locale)}`;
    const download = target.kind === "run" ? `mapae-${target.tokenId}-${target.game}-${target.day}.png` : `mapae-${target.tokenId}-season-${SEASON.id}.png`;
    return {intent: `${X_INTENT}?text=${encodeURIComponent(text)}&url=${encodeURIComponent(page)}`, page, card: paths.card, download};
}
