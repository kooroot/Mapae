import {createIsomorphicFn} from "@tanstack/react-start";
import {getCookie} from "@tanstack/react-start/server";
import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from "react";
import {LOCALE_COOKIE, parseLocale, readLocaleFromCookieString, type Locale} from "./i18n";

/**
 * The language layer, runtime half.
 *
 * The locale must be known *during* server render — `<html lang>` and every visible
 * string depend on it — and must resolve to the same value when the client hydrates,
 * or React reports a mismatch and repaints. A cookie is the only store both sides can
 * read synchronously, so the toggle writes a cookie and this resolver reads it:
 * server through the framework's request storage, client through `document.cookie`.
 * First visit has no cookie and renders the English base on both sides.
 *
 * Deliberately not persisted in localStorage: the server cannot see localStorage, so
 * a returning Korean reader would get an English SSR paint and a Korean repaint —
 * the exact flash this design exists to avoid.
 */
export const resolveLocale = createIsomorphicFn()
    .server((): Locale => parseLocale(getCookie(LOCALE_COOKIE)))
    .client((): Locale => readLocaleFromCookieString(document.cookie));

const LocaleContext = createContext<{
    locale: Locale;
    setLocale: (next: Locale) => void;
} | null>(null);

export function LocaleProvider({initial, children}: {initial: Locale; children: ReactNode}) {
    const [locale, setLocaleState] = useState<Locale>(initial);

    const setLocale = useCallback((next: Locale) => {
        setLocaleState(next);
        // One year, Lax, path-wide. `Secure` is omitted on purpose: local dev serves
        // plain HTTP on loopback, and a Secure cookie there would silently never stick.
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }, []);

    const value = useMemo(() => ({locale, setLocale}), [locale, setLocale]);
    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): {locale: Locale; setLocale: (next: Locale) => void} {
    const context = useContext(LocaleContext);
    if (!context) throw new Error("useLocale must be used inside LocaleProvider");
    return context;
}

/**
 * The language setting. One control, text only, styled from existing tokens through
 * `currentColor` so it sits on paper and obsidian alike — the port's rule is that
 * language is the only thing that changes, so the switch itself must not read as a
 * new design element.
 */
export function LocaleSwitch({className}: {className?: string}) {
    const {locale, setLocale} = useLocale();
    return (
        <div
            className={`lang-switch ${className ?? ""}`}
            role="group"
            aria-label="Language / 언어"
        >
            <button
                type="button"
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en")}
            >
                EN
            </button>
            <span aria-hidden="true">·</span>
            <button
                type="button"
                lang="ko"
                aria-pressed={locale === "ko"}
                onClick={() => setLocale("ko")}
            >
                한국어
            </button>
        </div>
    );
}
