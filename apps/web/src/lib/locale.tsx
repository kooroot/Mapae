import {useRouterState} from "@tanstack/react-router";
import {createIsomorphicFn} from "@tanstack/react-start";
import {getCookie, getRequestUrl} from "@tanstack/react-start/server";
import {createContext, useContext, useMemo, type ReactNode} from "react";
import {
    LOCALE_COOKIE,
    localizePath,
    parseLocale,
    readLocaleFromCookieString,
    readLocaleFromPath,
    type Locale,
} from "./i18n";

/**
 * The language layer, runtime half.
 *
 * The locale must be known *during* server render — `<html lang>` and every visible
 * string depend on it — and must resolve to the same value when the client hydrates,
 * or React reports a mismatch and repaints. Both inputs this reads satisfy that: the
 * request path and the cookie are visible synchronously on both sides.
 *
 * **The path wins, the cookie only remembers.** `/ko` is Korean no matter what any
 * cookie says, which is what makes a Korean URL forwardable, indexable, and cacheable
 * (see `LOCALE_PATH_PREFIX`). The cookie decides only what an *unprefixed* path
 * renders, so a returning reader still lands in their language at the bare domain —
 * and a crawler, which carries no cookie, always sees the English base at `/` and the
 * Korean copy at `/ko`. Those are the two URLs `hreflang` declares.
 *
 * Deliberately not persisted in localStorage: the server cannot see localStorage, so
 * a returning Korean reader would get an English SSR paint and a Korean repaint —
 * the exact flash this design exists to avoid.
 */
export const resolveLocale = createIsomorphicFn()
    .server(
        (): Locale =>
            readLocaleFromPath(getRequestUrl().pathname) ??
            parseLocale(getCookie(LOCALE_COOKIE)),
    )
    .client(
        (): Locale =>
            readLocaleFromPath(window.location.pathname) ??
            readLocaleFromCookieString(document.cookie),
    );

const LocaleContext = createContext<{locale: Locale} | null>(null);

export function LocaleProvider({initial, children}: {initial: Locale; children: ReactNode}) {
    // No setter, and that is the design: language is a property of the URL now, so it
    // changes by navigating rather than by mutating state. A setter would let a caller
    // put the rendered language out of step with the address bar.
    const value = useMemo(() => ({locale: initial}), [initial]);
    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): {locale: Locale} {
    const context = useContext(LocaleContext);
    if (!context) throw new Error("useLocale must be used inside LocaleProvider");
    return context;
}

function GlobeMark() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
            focusable="false"
        >
            <circle cx="12" cy="12" r="9.25" />
            <path d="M2.75 12h18.5" />
            <path d="M12 2.75c2.4 2.5 3.6 5.58 3.6 9.25s-1.2 6.75-3.6 9.25c-2.4-2.5-3.6-5.58-3.6-9.25S9.6 5.25 12 2.75Z" />
        </svg>
    );
}

/**
 * The language switch: one control naming the language it switches *to*.
 *
 * It used to show both locales with the inactive one at 45% opacity, which asks the
 * reader to work out which of two dim labels is the current state — and at that opacity
 * on the obsidian surfaces the inactive label was barely legible. Naming only the
 * destination removes the question rather than restyling it: there is no inactive state
 * left to dim, so the whole control can carry full contrast.
 *
 * A plain link doing a **full navigation**, not a client-side one. The locale is
 * resolved from the path during SSR, so a document load is what regenerates
 * `<html lang>`, every `head()` tag, and the canonical/hreflang set together. A
 * client-side transition would move the address bar and leave the rendered language
 * behind until reload. Switching language is a once-a-session act; a document load is
 * the cheap and correct mechanism for it.
 */
export function LocaleSwitch({className}: {className?: string}) {
    const {locale} = useLocale();
    const pathname = useRouterState({select: (state) => state.location.pathname});
    const target: Locale = locale === "en" ? "ko" : "en";
    return (
        <a
            className={`lang-switch ${className ?? ""}`}
            href={localizePath(pathname, target)}
            hrefLang={target}
            // The accessible name opens with the visible label rather than replacing it.
            // "KO" alone does not say a language switch is on offer, so the name has to
            // state the action — but a name that omits the word on screen breaks the
            // control for anyone driving the page by voice, who says what they can see.
            aria-label={target === "ko" ? "KO — 한국어로 전환" : "EN — Switch to English"}
            onClick={() => {
                // Written before the navigation the browser is about to make, so the
                // choice survives a later visit to an unprefixed URL. Synchronous, so it
                // lands regardless. One year, Lax, path-wide. `Secure` is omitted on
                // purpose: local dev serves plain HTTP on loopback, and a Secure cookie
                // there would silently never stick.
                document.cookie = `${LOCALE_COOKIE}=${target}; path=/; max-age=31536000; samesite=lax`;
            }}
        >
            <GlobeMark />
            {/* Two-letter codes rather than endonyms. `한국어` beside `EN` made the two
                states different *kinds* of label — a word in one direction, an abbreviation
                in the other — so the control changed width and weight on every switch. No
                `lang` here: the string is a Latin-script ISO code, not Korean text, and
                marking it `ko` would hand a screen reader two letters to pronounce as
                Korean. The destination's language is already declared by `hreflang`. */}
            <span>{target === "ko" ? "KO" : "EN"}</span>
        </a>
    );
}
