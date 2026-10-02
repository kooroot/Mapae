import {expect, test} from "bun:test";
import {pages} from "./pages";
import {renderPage} from "./shell";

const all = pages(await Bun.file(new URL("../../docs/SUMMARY.md", import.meta.url)).text());

test("reading navigation preserves the current chapter across languages and links adjacent chapters", () => {
    for (const url of ["tech/03-error-model", "tech-english/03-error-model"]) {
        const page = all.find(p => p.url === url)!;
        const html = renderPage({page, all, body: "<h1>Errors</h1>", hasDiagram: false});
        const opposite = page.locale === "ko" ? "tech-english" : "tech";
        expect(html).toContain(`href="/${opposite}/03-error-model"`);
        const navigation = html.split('class="doc-pagination"')[1]!.split("</nav>")[0]!;
        const prefix = page.locale === "ko" ? "tech" : "tech-english";
        expect(navigation).toContain(`href="/${prefix}/02-payment-flows"`);
        expect(navigation).toContain(`href="/${prefix}/04-security"`);
        expect(navigation).not.toContain(`href="/${opposite}/`);
        expect(html).toContain(`href="/${url}" aria-current="page"`);
    }
});

test("navigation escapes document names and does not invent missing translations", () => {
    const page = {...all.find(p => p.url === "operations/mcp-guide")!, title: '<img src=x onerror="alert(1)">'};
    const html = renderPage({page, all: all.map(p => p.url === page.url ? page : p), body: "<p>Guide</p>", hasDiagram: false});
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('Read this page in English');
    expect(html).toContain('<details class="docs-nav">');
    expect(html).toContain('src="../../assets/navigation.js"');
});
