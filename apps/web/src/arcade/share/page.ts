import {guardianName, guardianTraits} from "@mapae/arcade/guardians";
import type {RankedCard, SeasonCard} from "@mapae/arcade/ranking";
import {SEASON} from "@mapae/arcade/season";
import {localizePath, type Locale} from "../../lib/i18n";
import {GAME_NAMES} from "../game-names";
import {GUARDIAN_STORIES} from "../guardian";
import {points, seasonDate} from "../ranking/format";

export const FOLLOW_URL = "https://x.com/intent/follow?screen_name=mapae_io";
export type ShareTarget = {kind: "run"; tokenId: string; game: RankedCard["game"]; day: string} | {kind: "season"; tokenId: string};

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]!);
/** The paths a target lives at: its page (per locale) and its card. */
export function sharePaths(target: ShareTarget): {page: string; card: string} {
    const tail = target.kind === "run" ? `g/${target.tokenId}/${target.game}/${target.day}` : `s/${target.tokenId}`;
    return {page: `/share/${tail}`, card: `/api/arcade/share/${tail}/card.png`};
}

/** What the page and the crawlers say about a card, in the reader's language. */
export function shareCopy(card: RankedCard | SeasonCard, locale: Locale): {title: string; description: string; alt: string} {
    const ko = locale === "ko", name = guardianName(card.tokenId, locale), story = GUARDIAN_STORIES[guardianTraits(card.seed).zodiac][locale];
    const tail = ko ? `${story}. GIWA Sepolia 테스트넷 오락실, @mapae_io` : `${story}. The GIWA Sepolia testnet arcade, @mapae_io`;
    if ("game" in card) {
        const game = GAME_NAMES[locale][card.game], when = card.final ? seasonDate(card.day, locale) : null;
        const place = ko ? `${when ?? "오늘"} ${card.rank}위/${card.entrants}명` : `#${card.rank} of ${card.entrants} ${when ? `on ${when}` : "today"}`;
        const season = card.season ? ko ? `시즌 ${SEASON.id} ${points(card.season.points, "ko")} ${card.season.rank}위` : `Season ${SEASON.id} ${points(card.season.points, "en")}, #${card.season.rank}` : null;
        return {title: `${name} · ${game} ${points(card.score, locale)} · Mapae Arcade`, description: [place, season, tail].filter(Boolean).join(" · "),
            alt: ko ? `${name}의 ${game} 카드: ${points(card.score, "ko")}, ${place}` : `${name}'s ${game} card: ${points(card.score, "en")}, ${place}`};
    }
    const {season, status} = card, run = ko ? `${season.days}일 참가 · 연속 ${season.streak}일` : `${season.days} ${season.days === 1 ? "day" : "days"} · ${season.streak}-day run`;
    const place = ko ? `시즌 ${status.id} ${season.rank}위/${season.entrants}명` : `Season ${status.id} #${season.rank} of ${season.entrants}`;
    return {title: `${name} · ${ko ? `시즌 ${status.id}` : `Season ${status.id}`} ${points(season.points, locale)} · Mapae Arcade`, description: [place, run, tail].join(" · "),
        alt: ko ? `${name}의 시즌 ${status.id} 카드: ${points(season.points, "ko")}, ${place}` : `${name}'s Season ${status.id} card: ${points(season.points, "en")}, ${place}`};
}

const meta = (attr: "name" | "property", key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
const CTA = {
    ko: {open: "아케이드 열기", follow: "@mapae_io 팔로우", other: "English", fine: "GIWA Sepolia 테스트넷 · 실제 돈이 오가지 않아요"},
    en: {open: "Open the arcade", follow: "Follow @mapae_io", other: "한국어", fine: "GIWA Sepolia testnet · no real money moves"},
};
function shell(locale: Locale, head: string, body: string): string {
    return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0e0c0a">${head}<link rel="stylesheet" href="/share.css"></head><body><main class="share">${body}</main></body></html>`;
}
/**
 * The landing page a shared link opens: the card as the og:image for X and the chat apps, the same card and copy for a
 * reader without a wallet, and two doors — the arcade and the account. No script, no inline style, nothing but the card's own data.
 */
export function sharePage(target: ShareTarget, card: RankedCard | SeasonCard, locale: Locale, base: string): string {
    const {page, card: cardPath} = sharePaths(target), copy = shareCopy(card, locale), here = `${base}${localizePath(page, locale)}`, cta = CTA[locale];
    const head = [
        `<title>${escapeHtml(copy.title)}</title>`, meta("name", "description", copy.description), meta("name", "robots", "noindex, follow"),
        meta("property", "og:title", copy.title), meta("property", "og:description", copy.description), meta("property", "og:type", "website"), meta("property", "og:site_name", "Mapae Arcade"),
        meta("property", "og:url", here), meta("property", "og:image", `${base}${cardPath}`), meta("property", "og:image:type", "image/png"),
        meta("property", "og:image:width", "1200"), meta("property", "og:image:height", "630"), meta("property", "og:image:alt", copy.alt),
        meta("name", "twitter:card", "summary_large_image"), meta("name", "twitter:site", "@mapae_io"), meta("name", "twitter:title", copy.title),
        meta("name", "twitter:description", copy.description), meta("name", "twitter:image", `${base}${cardPath}`), meta("name", "twitter:image:alt", copy.alt),
        `<link rel="canonical" href="${escapeHtml(here)}">`, `<link rel="alternate" hreflang="en" href="${escapeHtml(`${base}${page}`)}">`,
        `<link rel="alternate" hreflang="ko" href="${escapeHtml(`${base}${localizePath(page, "ko")}`)}">`, `<link rel="alternate" hreflang="x-default" href="${escapeHtml(`${base}${page}`)}">`,
    ].join("");
    const body = `<p class="share-brand">Mapae Arcade</p><img class="share-card" src="${escapeHtml(cardPath)}" width="1200" height="630" alt="${escapeHtml(copy.alt)}">` +
        `<h1>${escapeHtml(copy.title.replace(/ · Mapae Arcade$/, ""))}</h1><p class="share-desc">${escapeHtml(copy.description)}</p>` +
        `<p class="share-actions"><a class="share-button" href="${escapeHtml(localizePath("/arcade", locale))}">${cta.open}</a><a class="share-button share-follow" href="${FOLLOW_URL}" rel="noopener noreferrer">${cta.follow}</a></p>` +
        `<p class="share-fine">${cta.fine} · <a href="${escapeHtml(localizePath(page, locale === "ko" ? "en" : "ko"))}" hreflang="${locale === "ko" ? "en" : "ko"}">${cta.other}</a></p>`;
    return shell(locale, head, body);
}
/** The page for a card that is not there (404) or cannot be drawn right now (503). */
export function shareFallbackPage(status: 404 | 503, locale: Locale): string {
    const ko = locale === "ko", cta = CTA[locale];
    const title = status === 404 ? ko ? "이 카드는 없어요" : "No such card" : ko ? "잠시 뒤 다시 열어 주세요" : "Try again in a moment";
    const text = status === 404 ? ko ? "주소가 틀렸거나, 그날 그 전령의 기록이 없어요." : "The link is off, or that guardian has no record for that day."
        : ko ? "카드를 그리는 서버가 잠시 쉬고 있어요. 곧 돌아와요." : "The card server is resting for a moment. It will be back shortly.";
    return shell(locale, `<title>${escapeHtml(title)} · Mapae Arcade</title><meta name="robots" content="noindex">`,
        `<p class="share-brand">Mapae Arcade</p><h1>${escapeHtml(title)}</h1><p class="share-desc">${escapeHtml(text)}</p><p class="share-actions"><a class="share-button" href="${escapeHtml(localizePath("/arcade", locale))}">${cta.open}</a></p>`);
}
