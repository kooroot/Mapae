import {useRouter, type ErrorComponentProps} from "@tanstack/react-router";
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";

const COPY: Record<Locale, {title: string; body: string; retry: string; detail: string}> = {
    en: {
        title: "Something went wrong.",
        body: "Please try loading this page again.",
        retry: "Try again",
        detail: "Error details",
    },
    ko: {
        title: "문제가 생겼습니다.",
        body: "페이지를 불러오지 못했습니다. 다시 시도해 주세요.",
        retry: "다시 시도",
        detail: "오류 상세",
    },
};

/**
 * What a route renders in place of the page when it throws, on both surfaces.
 *
 * The router names this as its `defaultErrorComponent` because TanStack's own fallback
 * styles itself through `style` attributes, and the document's `style-src` blesses no
 * attribute: the moment a page failed, the one component meant to say so would render
 * with its styling refused. This one is classes on the shared tokens — it sits on the
 * document ground, outside `.studio-shell`, so paper and ink are the right surface for
 * either product.
 *
 * Retry is `router.invalidate()`, not the boundary's `reset`: invalidating re-runs the
 * matched loaders and, because the match boundary keys on `loadedAt`, clears the caught
 * error with them. `reset` alone re-renders the same failed match, which throws again.
 *
 * The message is kept in an optional disclosure: a render failure has no vocabulary to map
 * it to, and the sentence is what a bug report needs. Rendered inside the root shell,
 * so `useLocale` reads the document's language.
 */
export function RouteError({error}: ErrorComponentProps) {
    const {locale} = useLocale();
    const router = useRouter();
    const t = COPY[locale];
    return (
        <main className="route-error">
            <div className="wrap">
                <h1>{t.title}</h1>
                <p>{t.body}</p>
                {error.message ? <details><summary>{t.detail}</summary><code className="route-error-detail">{error.message}</code></details> : null}
                <button type="button" className="btn" onClick={() => router.invalidate()}>
                    <span>{t.retry}</span>
                </button>
            </div>
        </main>
    );
}
