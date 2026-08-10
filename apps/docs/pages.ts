/**
 * The published URL of every documentation page — frozen, not derived.
 *
 * These paths were live on GitBook before this site replaced it, and one of them is the
 * answer to a submission form. A reader who bookmarked a chapter, or a judge following a
 * link that was filed months ago, has to land on the same page. So the map is data here
 * rather than a function of the file tree, because the file tree does not actually
 * determine it: GitBook slugged sections from `SUMMARY.md` headings, so `tech/en/` became
 * `/tech-english/` and the four top-level operations documents gained an `/operations/`
 * prefix that exists nowhere on disk. Any rule reconstructing that from paths would be a
 * guess, and a wrong guess is a dead link nobody notices until someone follows it.
 *
 * `SUMMARY.md` stays the source of truth for *structure* — order, titles, sections, which
 * documents are published at all. This map only answers "and where does that one live".
 * `pages()` refuses a `SUMMARY.md` entry with no URL here, so publishing a new document
 * is a deliberate URL decision rather than a slug that appears by accident.
 */

export type DocLocale = "en" | "ko";

/** Source path relative to `docs/` → published URL path, without a leading slash. */
export const URL_FOR_SOURCE: Readonly<Record<string, string>> = {
    "README.md": "",
    "README.ko.md": "readme.ko",

    "tech/en/01-architecture.md": "tech-english/01-architecture",
    "tech/en/02-payment-flows.md": "tech-english/02-payment-flows",
    "tech/en/03-error-model.md": "tech-english/03-error-model",
    "tech/en/04-security.md": "tech-english/04-security",
    "tech/en/05-onchain-environment.md": "tech-english/05-onchain-environment",
    "tech/en/06-roadmap.md": "tech-english/06-roadmap",

    "tech/01-architecture.md": "tech/01-architecture",
    "tech/02-payment-flows.md": "tech/02-payment-flows",
    "tech/03-error-model.md": "tech/03-error-model",
    "tech/04-security.md": "tech/04-security",
    "tech/05-onchain-environment.md": "tech/05-onchain-environment",
    "tech/06-roadmap.md": "tech/06-roadmap",

    "deployed-contracts.md": "operations/deployed-contracts",
    "mcp-guide.md": "operations/mcp-guide",
    "giwa-demo-runbook.md": "operations/giwa-demo-runbook",
    "revocation-runbook.md": "operations/revocation-runbook",
};

/**
 * Which language a page is written in.
 *
 * It decides `<html lang>`, and under `ko` that is not decoration: it picks the glyph for
 * the codepoints Korean shares with Chinese and Japanese, and it drives `word-break:
 * keep-all`, the difference between Korean lines that break between words and Korean lines
 * that break mid-word. The English tech chapters are the only ones whose language differs
 * from the book's Korean default, so they are listed rather than inferred.
 */
const ENGLISH_SOURCES = new Set([
    "README.md",
    "tech/en/01-architecture.md",
    "tech/en/02-payment-flows.md",
    "tech/en/03-error-model.md",
    "tech/en/04-security.md",
    "tech/en/05-onchain-environment.md",
    "tech/en/06-roadmap.md",
]);

export function localeForSource(source: string): DocLocale {
    return ENGLISH_SOURCES.has(source) ? "en" : "ko";
}

export interface DocPage {
    /** Published path with no leading or trailing slash; `""` is the book's root. */
    url: string;
    /** Source path relative to `docs/`. */
    source: string;
    /** Sidebar and `<title>` label, from `SUMMARY.md`. */
    title: string;
    /** The `##` group it sits under, or `undefined` for the two cover pages. */
    section?: string;
    locale: DocLocale;
}

/**
 * Read `SUMMARY.md` into the ordered page list.
 *
 * Deliberately a parser over the same file GitBook read, rather than a second list to
 * maintain: the table of contents and the site would otherwise be two truths, and the
 * first edit that lands in only one of them publishes a book whose sidebar disagrees with
 * itself — the same failure shape the chapter generator exists to prevent.
 */
export function pages(summaryMarkdown: string): DocPage[] {
    const found: DocPage[] = [];
    let section: string | undefined;

    for (const line of summaryMarkdown.split("\n")) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading?.[1]) {
            section = heading[1];
            continue;
        }
        const entry = /^\s*[*-]\s+\[(.+?)\]\((.+?)\)\s*$/.exec(line);
        if (!entry) continue;

        const [, title, source] = entry;
        if (!title || !source) continue;

        const url = URL_FOR_SOURCE[source];
        if (url === undefined) {
            throw new Error(
                `docs/SUMMARY.md publishes ${source}, which has no entry in URL_FOR_SOURCE. ` +
                    `Add one: publishing a page is a URL decision, and a derived slug would ` +
                    `be a guess.`,
            );
        }
        found.push({url, source, title, section, locale: localeForSource(source)});
    }
    return found;
}
