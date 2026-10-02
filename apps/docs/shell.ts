import type {DocPage} from "./pages";
import {escapeHtml} from "./render";

const SITE_URL = "https://docs.mapae.io";
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
        `<p>이 주소에는 문서가 없습니다. 상단 목차에서 문서를 찾거나, ` +
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
    const ko = page.locale === "ko";
    const siblings = all.filter(item => item.locale === page.locale);
    const index = siblings.findIndex(item => item.url === page.url);
    const previous = index > 0 ? siblings[index - 1] : undefined;
    const next = index >= 0 ? siblings[index + 1] : undefined;
    const counterpartSource = page.source === "README.md" ? "README.ko.md" : page.source === "README.ko.md" ? "README.md" : page.source.startsWith("tech/en/") ? page.source.replace("tech/en/", "tech/") : page.source.startsWith("tech/") ? page.source.replace("tech/", "tech/en/") : undefined;
    const counterpart = all.find(item => item.source === counterpartSource);
    const localeLink = counterpart ? `<a href="/${counterpart.url}" lang="${counterpart.locale}" aria-label="${ko ? 'Read this page in English' : '이 문서 한국어로 읽기'}">${ko ? "English" : "한국어"}</a>` : "";
    const pageLink = (item: DocPage | undefined, label: string) => item ? `<a href="/${item.url}"><small>${label}</small><strong>${escapeHtml(item.title)}</strong></a>` : "<span></span>";
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
<a class="skip" href="#content">${ko ? "본문으로 바로 가기" : "Skip to content"}</a>
<header class="top">
  <a class="brand" href="${LANDING_URL}${ko ? "/ko" : ""}">
    <img src="${root}brand/emblem.png" alt="" width="26" height="30">
    <span>Mapae</span>
    <em>docs</em>
  </a>
  <nav class="top-links">
    <a href="${LANDING_URL}${ko ? "/ko" : ""}">mapae.io</a>
    <a href="https://app.mapae.io${ko ? "/ko" : ""}">Studio</a>
    ${localeLink}
    <a href="${GITHUB_URL}" target="_blank" rel="noreferrer noopener">GitHub</a>
  </nav>
</header>
<div class="frame">
  <details class="docs-nav"><summary>${ko ? "목차 · 문서 검색" : "Contents · Search"}<span aria-hidden="true">＋</span></summary>
  <nav class="side" aria-label="${ko ? "문서 목차" : "Contents"}">
    <label class="docs-search-label" for="docs-search">${ko ? "문서 검색" : "Search documentation"}</label>
    <input id="docs-search" type="search" placeholder="${ko ? "오류, 결제, 설정…" : "Errors, payments, settings…"}" autocomplete="off" aria-controls="docs-search-results">
    <p id="docs-search-status" role="status"></p><ul id="docs-search-results"></ul>
    <div id="docs-contents">${sidebar(all, page)}</div>
  </nav></details>
  <main id="content" class="doc">
<div class="doc-location">${escapeHtml(page.section ?? (ko ? "시작하기" : "Getting started"))} · ${escapeHtml(page.title)}</div>
${body}
<nav class="doc-pagination" aria-label="${ko ? "앞뒤 문서" : "Previous and next pages"}">${pageLink(previous, ko ? "← 이전" : "← Previous")}${pageLink(next, ko ? "다음 →" : "Next →")}</nav>
  </main>
</div>
<footer class="foot">
  <p>GIWA Sepolia · eip155:91342 · 테스트넷 자산으로만 동작합니다.</p>
</footer>
<script type="module" src="${root}assets/navigation.js"></script>
${diagramScript}
</body>
</html>
`;
}
