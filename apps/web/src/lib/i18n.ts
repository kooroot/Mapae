/**
 * The language layer, pure half.
 *
 * English is the *base*, not a translation: every string ships with an `en` entry, and
 * the parser collapses anything unexpected to `"en"`. Korean is the toggle. The split
 * between this file and `locale.tsx` is deliberate — this half has no React and no
 * TanStack imports, so `bun test` exercises the cookie contract without dragging the
 * SSR runtime into a unit test.
 *
 * The cookie value is attacker-controlled input like any other header, which is why
 * `parseLocale` is a closed set rather than a passthrough: an unvalidated value would
 * flow into `<html lang>` and every dictionary lookup.
 */

export type Locale = "en" | "ko";

export const LOCALE_COOKIE = "mapae-locale";

export const LOCALES: readonly Locale[] = ["en", "ko"] as const;

export function parseLocale(value: unknown): Locale {
    return value === "ko" || value === "en" ? value : "en";
}

/**
 * Parse a raw `Cookie` header. Client code passes `document.cookie`; the server half
 * prefers the framework's own `getCookie`, but falls back to this on the raw header so
 * both sides agree byte-for-byte on what a cookie means.
 */
export function readLocaleFromCookieString(cookieString: string | undefined): Locale {
    if (!cookieString) return "en";
    for (const pair of cookieString.split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        if (pair.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
        return parseLocale(pair.slice(eq + 1).trim());
    }
    return "en";
}

/** Select one locale's entry from a bilingual copy object. */
export function pick<T>(locale: Locale, copy: {readonly en: T; readonly ko: T}): T {
    return copy[locale];
}

/**
 * Korean lives under a path prefix, English at the root.
 *
 * The cookie alone could never do this job, and the three things it loses are all
 * things a URL is for. A cookie locale is invisible in a link, so forwarding
 * `mapae.io` to a Korean reader hands them English. A crawler carries no cookie, so
 * only ever indexes the English page — the Korean copy does not exist as far as search
 * is concerned. And a response that varies by cookie cannot be shared-cached at the
 * edge, while `/ko` is a distinct object that can.
 *
 * The cookie stays, demoted to a memory: it decides only what an *unprefixed* path
 * renders, so a returning reader still lands in their language. Route files under
 * `src/routes/ko/` mirror this constant.
 */
export const LOCALE_PATH_PREFIX = "/ko";

/**
 * The locale a URL path names, or `undefined` when it names none.
 *
 * `undefined` rather than `"en"` is the whole contract: the caller has to be able to
 * tell "this path says English" from "this path says nothing", because only the second
 * may fall through to the cookie. Collapsing them would make every bare `/` visit
 * English and silently discard the reader's setting.
 */
export function readLocaleFromPath(pathname: string): Locale | undefined {
    return pathname === LOCALE_PATH_PREFIX ||
        pathname.startsWith(`${LOCALE_PATH_PREFIX}/`)
        ? "ko"
        : undefined;
}

/** The same page under `locale` — what the language switch links to. */
export function localizePath(pathname: string, locale: Locale): string {
    // Matched as a whole segment, never as a raw prefix: `/korea` shares the first three
    // characters with the Korean prefix and has nothing to do with it.
    const base =
        pathname === LOCALE_PATH_PREFIX
            ? "/"
            : pathname.startsWith(`${LOCALE_PATH_PREFIX}/`)
              ? pathname.slice(LOCALE_PATH_PREFIX.length) || "/"
              : pathname || "/";
    if (locale === "en") return base;
    return base === "/" ? LOCALE_PATH_PREFIX : `${LOCALE_PATH_PREFIX}${base}`;
}
