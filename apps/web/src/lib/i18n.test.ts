import {describe, expect, test} from "bun:test";
import {
    LOCALE_COOKIE,
    LOCALE_PATH_PREFIX,
    localizePath,
    parseLocale,
    pick,
    readLocaleFromCookieString,
    readLocaleFromPath,
} from "./i18n";

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

/**
 * The path is the *authority* on locale and the cookie is only a memory, so the
 * distinction this reader has to keep is between "the path says English" and "the path
 * says nothing" — only the second may fall through to the cookie. It returns `undefined`
 * rather than `"en"` for that reason.
 */
describe("readLocaleFromPath", () => {
    test("the prefix, with or without a trailing path, names Korean", () => {
        expect(readLocaleFromPath("/ko")).toBe("ko");
        expect(readLocaleFromPath("/ko/")).toBe("ko");
        expect(readLocaleFromPath("/ko/app")).toBe("ko");
    });

    test("an unprefixed path names no locale — the cookie still gets a say", () => {
        expect(readLocaleFromPath("/")).toBeUndefined();
        expect(readLocaleFromPath("/app")).toBeUndefined();
        expect(readLocaleFromPath("")).toBeUndefined();
    });

    test("the prefix must be a whole segment", () => {
        // `/korea` starts with the same three characters and is not Korean. Matching on
        // the raw prefix would hand every such route to the wrong dictionary.
        expect(readLocaleFromPath("/korea")).toBeUndefined();
        expect(readLocaleFromPath("/kotlin/guide")).toBeUndefined();
    });

    test("paths are case-sensitive, so the uppercase form names nothing", () => {
        expect(readLocaleFromPath("/KO")).toBeUndefined();
    });
});

describe("localizePath", () => {
    test("adds the prefix for Korean", () => {
        expect(localizePath("/", "ko")).toBe("/ko");
        expect(localizePath("/app", "ko")).toBe("/ko/app");
    });

    test("strips the prefix for English", () => {
        expect(localizePath("/ko", "en")).toBe("/");
        expect(localizePath("/ko/", "en")).toBe("/");
        expect(localizePath("/ko/app", "en")).toBe("/app");
    });

    test("is idempotent — switching to the locale a path already names is a no-op", () => {
        expect(localizePath("/ko/app", "ko")).toBe("/ko/app");
        expect(localizePath("/app", "en")).toBe("/app");
    });

    test("a path that merely starts with the prefix letters is not stripped", () => {
        expect(localizePath("/korea", "en")).toBe("/korea");
        expect(localizePath("/korea", "ko")).toBe("/ko/korea");
    });

    test("the prefix constant is the one the routes are named after", () => {
        // Route files live at `src/routes/ko/`; if this constant moves, they must move
        // with it, and a silent drift would 404 every Korean URL.
        expect(LOCALE_PATH_PREFIX).toBe("/ko");
    });
});
