import {Marked} from "marked";
import {isRelativeDocLink, resolveDocLink} from "./links";
import type {DocPage} from "./pages";

/**
 * Markdown to HTML, plus the two things this book needs that a plain renderer does not do.
 *
 * Links get rewritten to published URLs (see `links.ts`). Mermaid fences are passed
 * through as `<pre class="mermaid">` holding their *source*, rather than being escaped
 * into a code block: mermaid draws them in the browser from exactly that text, so the
 * diagram keeps one representation from the repository to the page — nobody maintains a
 * committed SVG that can drift from the markdown beside it.
 */
export function renderMarkdown(
    page: DocPage,
    markdown: string,
    /** Every markdown file under `docs/` — decides published URL vs GitHub fallback. */
    repoDocs: ReadonlySet<string>,
): {html: string; hasDiagram: boolean} {
    let hasDiagram = false;

    const marked = new Marked({
        gfm: true,
        // No `mangle`/`headerIds` guesswork: heading anchors come from the renderer below
        // so they are stable across releases of the library.
        renderer: {
            code({text, lang}) {
                if (lang === "mermaid") {
                    hasDiagram = true;
                    return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
                }
                const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
                return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
            },
            link({href, title, tokens}) {
                const text = this.parser.parseInline(tokens);
                const target = isRelativeDocLink(href)
                    ? resolveDocLink(page.source, href, repoDocs)
                    : href;
                const attrs = [`href="${escapeHtml(target)}"`];
                if (title) attrs.push(`title="${escapeHtml(title)}"`);
                // Only outbound links leave the site, and those open in a new tab with the
                // opener severed — `noopener` is the security half, not a formality.
                if (/^https?:/i.test(target)) {
                    attrs.push('target="_blank"', 'rel="noreferrer noopener"');
                }
                return `<a ${attrs.join(" ")}>${text}</a>`;
            },
            heading({tokens, depth}) {
                const text = this.parser.parseInline(tokens);
                const id = slugify(stripTags(text));
                // The anchor is the heading itself, so a reader can copy a deep link from
                // any section without the page growing a column of link glyphs.
                return `<h${depth} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}">${text}</a></h${depth}>\n`;
            },
        },
    });

    return {html: marked.parse(markdown) as string, hasDiagram};
}

/**
 * A heading's anchor.
 *
 * Korean is kept rather than transliterated or dropped — most headings in this book are
 * Korean, and stripping non-ASCII would collapse "1. 시스템 구성" and "2. 결제 흐름" to the
 * same empty slug, which is worse than a percent-encoded URL that at least works.
 */
export function slugify(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s+/g, "-");
}

function stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, "");
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
