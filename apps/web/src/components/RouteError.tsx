import {useRouter, type ErrorComponentProps} from "@tanstack/react-router";
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";

const COPY: Record<Locale, {title: string; body: string; retry: string}> = {
    en: {
        title: "Something went wrong.",
        body: "This page could not be drawn. Try again, and reload the page if that does not help.",
        retry: "Try again",
    },
    ko: {
        title: "문제가 생겼습니다.",
        body: "이 페이지를 그리지 못했습니다. 다시 시도하고, 그래도 안 되면 페이지를 새로고침해 주세요.",
        retry: "다시 시도",
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
 * The message is shown as it is: a render failure has no vocabulary of its own to map
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
                {error.message ? <code className="route-error-detail">{error.message}</code> : null}
                <button type="button" className="btn" onClick={() => router.invalidate()}>
                    <span>{t.retry}</span>
                </button>
            </div>
        </main>
    );
}
