import {localizePath, type Locale} from "../lib/i18n";

/**
 * The arcade's places, each a real URL under `/arcade` (and `/ko/arcade`). Pure on purpose: the root route's head reads the
 * section from a pathname on the server, so this module carries no React.
 */
export const ARCADE_SECTIONS = ["lobby", "guardians", "outings", "journal", "wallet"] as const;
export type ArcadeSection = (typeof ARCADE_SECTIONS)[number];
/** A section that lives at `/arcade/<section>`; the lobby is the bare `/arcade`. */
export type ArcadeSubsection = Exclude<ArcadeSection, "lobby">;

export function isArcadeSubsection(segment: string): segment is ArcadeSubsection {
    return segment !== "lobby" && (ARCADE_SECTIONS as readonly string[]).includes(segment);
}

/** The section an optional `{-$section}` route param names; validation already happened in the route's `beforeLoad`. */
export function arcadeSectionFromParam(param: string | undefined): ArcadeSection {
    return param !== undefined && isArcadeSubsection(param) ? param : "lobby";
}

/** The section a pathname shows in either locale, or `null` when the path is not an arcade page. */
export function arcadeSectionFromPath(pathname: string): ArcadeSection | null {
    const match = /^\/arcade(?:\/([^/]+))?\/?$/.exec(localizePath(pathname, "en"));
    if (!match) return null;
    const segment = match[1];
    if (segment === undefined) return "lobby";
    return isArcadeSubsection(segment) ? segment : null;
}

export function arcadeSectionPath(section: ArcadeSection, locale: Locale): string {
    return localizePath(section === "lobby" ? "/arcade" : `/arcade/${section}`, locale);
}

/**
 * What each place is called, says in one line (menu and meta description alike) and offers as a way back from a game. The
 * return label is written whole per locale: Korean particles (로/으로) follow the noun and cannot be templated.
 */
export const SECTION_COPY: Record<Locale, Record<ArcadeSection, {label: string; description: string; back: string}>> = {
    ko: {
        lobby: {label: "오락실", description: "게임기를 골라 무료로 한 판, 또는 내 전령과 함께 놀아요.", back: "오락실로 돌아가기"},
        guardians: {label: "나의 전령단", description: "전령을 뽑고 타고난 재능을 살펴보고, 무료로 작전을 연습해요.", back: "전령단으로 돌아가기"},
        outings: {label: "외출", description: "오늘의 작전과 용돈을 정해 보내고, 외출 중인 전령을 지켜봐요.", back: "외출로 돌아가기"},
        journal: {label: "모험 기록", description: "전령의 성장과 다녀온 모험 결과를 모아 봐요.", back: "모험 기록으로 돌아가기"},
        wallet: {label: "지갑·승인", description: "연결한 지갑과 스마트 계정 잔액, 승인 기록과 회수를 한곳에서 봐요.", back: "지갑·승인으로 돌아가기"},
    },
    en: {
        lobby: {label: "Arcade", description: "Pick a cabinet and play a free round, or play with your own guardian.", back: "Back to the arcade"},
        guardians: {label: "My guardians", description: "Draw guardians, see their born talents and practice a strategy for free.", back: "Back to my guardians"},
        outings: {label: "Outings", description: "Set today’s plan and allowance, send your guardian out and follow the outing.", back: "Back to outings"},
        journal: {label: "Journal", description: "Your guardian’s growth and the results of every adventure.", back: "Back to the journal"},
        wallet: {label: "Wallet & approvals", description: "Your connected wallet, smart-account balance, approval records and revocation.", back: "Back to wallet & approvals"},
    },
};

/** A running outing's state as the dock and the menu badge name it. */
export const OUTING_STATUS: Record<Locale, Record<"queued" | "running" | "paused", string>> = {
    ko: {queued: "출발 대기", running: "외출 중", paused: "확인 필요"},
    en: {queued: "Ready to leave", running: "Out exploring", paused: "Needs attention"},
};

export function outingStatusLabel(status: string, locale: Locale): string | null {
    return Object.hasOwn(OUTING_STATUS[locale], status) ? OUTING_STATUS[locale][status as keyof (typeof OUTING_STATUS)["ko"]] : null;
}

/** Typed router options for a section, so `<Link>` and `navigate` keep back/forward, deep links and the locale prefix. */
export function arcadeSectionLink(section: ArcadeSection, locale: Locale, hash?: string) {
    const params = {section: section === "lobby" ? undefined : section};
    return {to: locale === "ko" ? "/ko/arcade/{-$section}" as const : "/arcade/{-$section}" as const, params, ...(hash ? {hash} : {})};
}
