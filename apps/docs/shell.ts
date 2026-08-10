import type {DocPage} from "./pages";
import {escapeHtml} from "./render";

const SITE_URL = "https://gitbook.mapae.io";
const LANDING_URL = "https://mapae.io";
const GITHUB_URL = "https://github.com/kooroot/Mapae";

/** `/tech/01-architecture` → `../../` — how many levels a page sits below the root. */
function relativeRoot(url: string): string {
    const depth = url === "" ? 0 : url.split("/").length;
    return depth === 0 ? "./" : "../".repeat(depth);
}

/**
 * The sidebar, grouped exactly as `SUMMARY.md` groups it.
 *
 * The current page is marked with `aria-current="page"` rather than only a colour, so the
 * position is available to a screen reader and not just to an eye.
 */
function sidebar(all: DocPage[], current: DocPage): string {
    const out: string[] = [];
    let section: string | undefined;
    let open = false;

    for (const page of all) {
        if (page.section !== section) {
            if (open) out.push("</ul>");
            section = page.section;
            if (section) out.push(`<h2>${escapeHtml(section)}</h2>`);
            out.push("<ul>");
            open = true;
        }
        const here = page.url === current.url;
        out.push(
            `<li><a href="/${page.url}"${here ? ' aria-current="page"' : ""}` +
                `${page.locale !== current.locale ? ` lang="${page.locale}"` : ""}>` +
                `${escapeHtml(page.title)}</a></li>`,
        );
    }
    if (open) out.push("</ul>");
    return out.join("\n");
}

/**
 * The 404, which is the one page a migration is most likely to need.
 *
 * It offers the contents rather than an apology: if a URL did move despite the pinned map,
 * a reader who lands here can still see every page and find theirs, which is what they
 * came for. Built from the same shell, so it is not a second design to maintain.
 */
export function renderNotFound(all: DocPage[]): string {
    const body =
        `<h1>페이지를 찾을 수 없습니다</h1>\n` +
        `<p lang="en">This page does not exist. The full contents are in the sidebar, and ` +
        `the <a href="/">one-pager</a> is the place to start.</p>\n` +
        `<p>이 주소에는 문서가 없습니다. 전체 목차는 왼쪽에 있고, ` +
        `<a href="/">원페이저</a>에서 시작하면 됩니다.</p>\n`;
    return renderPage({
        page: {url: "404", source: "", title: "404", locale: "ko"},
        all,
        body,
        hasDiagram: false,
    });
}

export function renderPage(params: {
    page: DocPage;
    all: DocPage[];
    body: string;
    hasDiagram: boolean;
}): string {
    const {page, all, body, hasDiagram} = params;
    const root = relativeRoot(page.url);
    const canonical = `${SITE_URL}/${page.url}`;
    const title = page.url === "" ? "Mapae — 기술 문서" : `${page.title} · Mapae`;

    // Loaded only where a diagram exists. It is a 3.5 MB bundle for one sequence diagram,
    // so the sixteen pages without one must not pay for it — and it is served from this
    // origin rather than a CDN because the policy below is `script-src 'self'`.
    const diagramScript = hasDiagram
        ? `<script type="module" src="${root}assets/mermaid.min.js"></script>\n` +
          `<script type="module" src="${root}assets/diagrams.js"></script>`
        : "";

    return `<!DOCTYPE html>
<html lang="${page.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="${root}favicon.ico" sizes="any">
<link rel="icon" href="${root}favicon.png" type="image/png" sizes="192x192">
<link rel="stylesheet" href="${root}assets/docs.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <a class="brand" href="${LANDING_URL}">
    <img src="${root}brand/emblem.png" alt="" width="26" height="30">
    <span>Mapae</span>
    <em>docs</em>
  </a>
  <nav class="top-links">
    <a href="${LANDING_URL}">mapae.io</a>
    <a href="https://app.mapae.io">Studio</a>
    <a href="${GITHUB_URL}" target="_blank" rel="noreferrer noopener">GitHub</a>
  </nav>
</header>
<div class="frame">
  <nav class="side" aria-label="Contents">
${sidebar(all, page)}
  </nav>
  <main id="content" class="doc">
${body}
  </main>
</div>
<footer class="foot">
  <p>GIWA Sepolia · eip155:91342 · 테스트넷 자산으로만 동작합니다.</p>
</footer>
${diagramScript}
</body>
</html>
`;
}
