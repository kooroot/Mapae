import {describe, expect, test} from "bun:test";
import {LOCALE_COOKIE, parseLocale, pick, readLocaleFromCookieString} from "./i18n";

/**
 * The locale is an *input* — it arrives from a cookie any client can set to anything —
 * so the parser's contract is the security-relevant part: every value outside the closed
 * {"en","ko"} set collapses to the English base, silently. A thrown error here would let
 * a malformed cookie take down SSR for that visitor.
 */

describe("parseLocale", () => {
    test("the two supported locales pass through", () => {
        expect(parseLocale("en")).toBe("en");
        expect(parseLocale("ko")).toBe("ko");
    });

    test("anything else collapses to the English base", () => {
        expect(parseLocale(undefined)).toBe("en");
        expect(parseLocale("")).toBe("en");
        expect(parseLocale("jp")).toBe("en");
        expect(parseLocale("KO")).toBe("en");
        expect(parseLocale("ko; path=/")).toBe("en");
    });
});

describe("readLocaleFromCookieString", () => {
    test("a missing or empty cookie header means English", () => {
        expect(readLocaleFromCookieString(undefined)).toBe("en");
        expect(readLocaleFromCookieString("")).toBe("en");
    });

    test("finds the locale among other cookies, whitespace included", () => {
        expect(
            readLocaleFromCookieString(`theme=dark; ${LOCALE_COOKIE}=ko; _ga=GA1.1`),
        ).toBe("ko");
        expect(readLocaleFromCookieString(` ${LOCALE_COOKIE}=en `)).toBe("en");
    });

    test("a cookie whose name merely ends with ours does not match", () => {
        expect(readLocaleFromCookieString(`x-${LOCALE_COOKIE}=ko`)).toBe("en");
    });

    test("a garbage value in our cookie collapses to English", () => {
        expect(readLocaleFromCookieString(`${LOCALE_COOKIE}=de`)).toBe("en");
    });
});

describe("pick", () => {
    test("returns the entry for the locale", () => {
        const copy = {en: "Open Studio", ko: "Studio 열기"};
        expect(pick("en", copy)).toBe("Open Studio");
        expect(pick("ko", copy)).toBe("Studio 열기");
    });
});
