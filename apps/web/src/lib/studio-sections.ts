import type {Locale} from "./i18n";

/** The three screens of one grant, in the order the Studio sidebar lists them. */
export type DetailSection = "overview" | "activity" | "security";

/**
 * What each grant screen is called and says, per locale.
 *
 * Apart from the Studio's own copy because the tab label is quoted outside it: the
 * revoke gate's account-missing note sends a person to the ‘Authority’ tab, and a note
 * that spells the label itself drifts the moment the tab is renamed. `revoke.ts` builds
 * that sentence from `label` here, so the two cannot disagree. The eyebrow and the icon
 * stay in the Studio — they are chrome, and English in both locales.
 */
export const STUDIO_SECTIONS: Record<
    Locale,
    Record<DetailSection, {label: string; title: string; description: string}>
> = {
    en: {
        overview: {
            label: "Authority",
            title: "Delegated authority",
            description: "Reads what the chain allows right now.",
        },
        activity: {
            label: "Activity",
            title: "Settlement history",
            description: "Reads enforcer events — no separate ledger.",
        },
        security: {
            label: "Revoke",
            title: "Revocation and security",
            description: "The path that ends this permission, and its current readiness.",
        },
    },
    ko: {
        overview: {
            label: "권한",
            title: "위임된 권한",
            description: "체인이 지금 허용하는 범위를 읽습니다.",
        },
        activity: {
            label: "활동",
            title: "정산 기록",
            description: "별도 원장 없이 enforcer 이벤트를 조회합니다.",
        },
        security: {
            label: "회수",
            title: "회수와 보안",
            description: "권한을 끝내는 경로와 현재 준비 상태를 확인합니다.",
        },
    },
};
