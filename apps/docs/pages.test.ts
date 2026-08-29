import {describe, expect, test} from "bun:test";
import {localeForSource, pages, URL_FOR_SOURCE} from "./pages";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const summary = await Bun.file(`${REPO}/docs/SUMMARY.md`).text();

/**
 * The URL set GitBook served at `gitbook.mapae.io`, read from its own `sitemap-pages.xml`
 * on 2026-08-09, the day before this site replaced it.
 *
 * This is the migration's actual contract. Everything else here — styling, sidebar, the
 * renderer — can change freely; these eighteen strings cannot, because they are what
 * existing bookmarks and one filed submission link resolve to. A test rather than a
 * comment because a comment cannot fail.
 */
const LIVE_GITBOOK_URLS = [
    "",
    "readme.ko",
    "tech-english/01-architecture",
    "tech-english/02-payment-flows",
    "tech-english/03-error-model",
    "tech-english/04-security",
    "tech-english/05-onchain-environment",
    "tech-english/06-roadmap",
    "tech/01-architecture",
    "tech/02-payment-flows",
    "tech/03-error-model",
    "tech/04-security",
    "tech/05-onchain-environment",
    "tech/06-roadmap",
    "operations/deployed-contracts",
    "operations/mcp-guide",
    "operations/giwa-demo-runbook",
    "operations/revocation-runbook",
];

/**
 * Pages published after the migration. Listed apart so the GitBook set above stays the
 * untouched contract it is, and so adding a page is a deliberate edit here rather than a
 * silent widening of what "served" means.
 */
const ADDED_SINCE_GITBOOK = [
    // 2026-08-29 — the @mapae/seller guide.
    "operations/seller-guide",
];

describe("published URLs", () => {
    test("every URL GitBook served is still served, plus the pages added since, and no others", () => {
        expect(new Set(Object.values(URL_FOR_SOURCE))).toEqual(
            new Set([...LIVE_GITBOOK_URLS, ...ADDED_SINCE_GITBOOK]),
        );
    });

    test("SUMMARY.md and the URL map cover exactly the same documents", () => {
        // Drift in either direction is a finding: a mapped page missing from SUMMARY is
        // unreachable, and a SUMMARY page missing from the map throws at build time.
        expect(new Set(pages(summary).map((p) => p.source))).toEqual(
            new Set(Object.keys(URL_FOR_SOURCE)),
        );
    });

    test("no URL carries a leading or trailing slash", () => {
        // The renderer joins these onto `dist/` and onto hrefs; a stray slash silently
        // produces `//tech/…`, which is a protocol-relative URL, not a path.
        for (const url of Object.values(URL_FOR_SOURCE)) {
            expect(url).toBe(url.replace(/^\/+|\/+$/g, ""));
        }
    });
});

describe("pages", () => {
    test("reads order, titles and sections from SUMMARY.md", () => {
        const found = pages(summary);
        expect(found).toHaveLength(19);
        expect(found[0]).toMatchObject({url: "", title: "Mapae one-pager", locale: "en"});
        expect(found[1]).toMatchObject({url: "readme.ko", locale: "ko"});
        expect(found[2]).toMatchObject({
            url: "tech-english/01-architecture",
            section: "Tech (English)",
            locale: "en",
        });
    });

    test("refuses a published document with no pinned URL", () => {
        // The failure that matters: adding a line to SUMMARY.md must not mint a URL by
        // accident. It stops the build instead.
        expect(() => pages("* [New page](new-page.md)")).toThrow(/URL_FOR_SOURCE/);
    });

    test("ignores prose and headings that are not entries", () => {
        expect(pages("# Summary\n\nsome text\n")).toEqual([]);
    });
});

describe("localeForSource", () => {
    test("the English cover and the English chapters are English", () => {
        expect(localeForSource("README.md")).toBe("en");
        expect(localeForSource("tech/en/03-error-model.md")).toBe("en");
    });

    test("everything else is Korean", () => {
        expect(localeForSource("README.ko.md")).toBe("ko");
        expect(localeForSource("tech/03-error-model.md")).toBe("ko");
        expect(localeForSource("deployed-contracts.md")).toBe("ko");
    });
});
