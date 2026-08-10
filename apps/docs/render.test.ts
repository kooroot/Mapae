import {describe, expect, test} from "bun:test";
import type {DocPage} from "./pages";
import {escapeHtml, renderMarkdown, slugify} from "./render";

const REPO_DOCS = new Set(["README.md", "deployed-contracts.md"]);

const cover: DocPage = {
    url: "",
    source: "README.md",
    title: "Mapae one-pager",
    locale: "en",
};

describe("renderMarkdown", () => {
    test("rewrites a relative markdown link to its published URL", () => {
        const {html} = renderMarkdown(cover, "See [contracts](deployed-contracts.md).", REPO_DOCS);
        expect(html).toContain('href="/operations/deployed-contracts"');
        expect(html).not.toContain(".md");
    });

    test("an outbound link keeps its href and severs the opener", () => {
        const {html} = renderMarkdown(cover, "[repo](https://github.com/kooroot/Mapae)", REPO_DOCS);
        expect(html).toContain('href="https://github.com/kooroot/Mapae"');
        expect(html).toContain('rel="noreferrer noopener"');
    });

    test("a mermaid fence keeps its source for the browser to draw", () => {
        const {html, hasDiagram} = renderMarkdown(
            cover,
            "```mermaid\nsequenceDiagram\n  A->>B: pay\n```",
            REPO_DOCS,
        );
        expect(hasDiagram).toBe(true);
        expect(html).toContain('<pre class="mermaid">');
        expect(html).toContain("sequenceDiagram");
        // Not a code block: mermaid reads the element's text, so wrapping it in <code>
        // would leave the diagram undrawn and the source showing.
        expect(html).not.toContain("<code>sequenceDiagram");
    });

    test("an ordinary fence stays an escaped code block", () => {
        const {html, hasDiagram} = renderMarkdown(cover, "```bash\nbun run check\n```", REPO_DOCS);
        expect(hasDiagram).toBe(false);
        expect(html).toContain('<code class="language-bash">');
        expect(html).toContain("bun run check");
    });

    test("markup inside a fence is escaped, not executed", () => {
        const {html} = renderMarkdown(cover, "```text\n<script>alert(1)</script>\n```", REPO_DOCS);
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    test("headings carry a stable anchor", () => {
        const {html} = renderMarkdown(cover, "## Error model", REPO_DOCS);
        expect(html).toContain('id="error-model"');
        expect(html).toContain('href="#error-model"');
    });
});

describe("slugify", () => {
    test("keeps Korean rather than dropping it", () => {
        // Stripping non-ASCII would collapse every Korean heading in this book to the
        // same empty slug, so deep links would all point at the top of the page.
        expect(slugify("2. 결제 흐름")).toBe("2-결제-흐름");
        expect(slugify("1. 시스템 구성")).toBe("1-시스템-구성");
        expect(slugify("1. 시스템 구성")).not.toBe(slugify("2. 결제 흐름"));
    });

    test("lowercases and hyphenates Latin headings", () => {
        expect(slugify("Verified on-chain environment")).toBe("verified-on-chain-environment");
    });

    test("drops punctuation that would need escaping in a fragment", () => {
        expect(slugify("What is `x402`?")).toBe("what-is-x402");
    });
});

describe("escapeHtml", () => {
    test("closes the four characters that break out of text or an attribute", () => {
        expect(escapeHtml('<a href="x">&</a>')).toBe(
            "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
        );
    });
});
