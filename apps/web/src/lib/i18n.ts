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
