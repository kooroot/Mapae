/**
 * Build the documentation site that replaced GitBook.
 *
 * The book was hosted on GitBook until 2026-08-10, on the paid tier, because a custom
 * domain is a paid feature there. That custom domain is what makes leaving cheap:
 * `gitbook.mapae.io` is ours, so the paths in bookmarks and in one filed submission form
 * survive a change of renderer. `pages.test.ts` holds that promise to the eighteen paths
 * GitBook actually served; the host itself now forwards to `docs.mapae.io`, which is what
 * `worker.ts` is for.
 *
 * Nothing here is a new source of truth. `docs/SUMMARY.md` decides what is published and
 * in what order; the chapters are still generated from `docs/tech-notes.md` by
 * `gitbook:build` and still gated byte-for-byte by `check:gitbook`. This step only turns
 * that markdown into HTML.
 *
 * Static output, no runtime. Every page is a file, so the Worker serves assets and runs
 * no code — the cheapest thing to operate and the hardest to break.
 */
import {cpSync, mkdirSync, readdirSync, rmSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {pages} from "./pages";
import {renderMarkdown} from "./render";
import {renderNotFound, renderPage} from "./shell";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const DOCS = join(REPO, "docs");
const OUT = join(HERE, "dist");

/**
 * Fonts and the mermaid bundle are copied out of `node_modules` rather than committed.
 * The lockfile pins them, `bun install` fetches them, and the repository stays free of a
 * 3.5 MB minified blob whose diffs nobody can read.
 */
const VENDORED: ReadonlyArray<{from: string; to: string}> = [
    {
        from: "mermaid/dist/mermaid.min.js",
        to: "assets/mermaid.min.js",
    },
    {
        from: "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css",
        to: "assets/fonts/pretendard.css",
    },
    {
        // The stylesheet above points at `./woff2-dynamic-subset/…`, so the directory has
        // to land beside it under that exact name or every `@font-face` resolves to a 404
        // and the page silently renders in a system font.
        from: "pretendard/dist/web/variable/woff2-dynamic-subset",
        to: "assets/fonts/woff2-dynamic-subset",
    },
    {
        from: "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
        to: "assets/fonts/plex-mono-regular.woff2",
    },
];

/** Brand marks and icons, taken from the web app so there is one set of files. */
const FROM_WEB: ReadonlyArray<string> = [
    "brand/emblem.png",
    "favicon.ico",
    "favicon.png",
];

function write(target: string, contents: string | Buffer): void {
    const path = join(OUT, target);
    mkdirSync(dirname(path), {recursive: true});
    Bun.write(path, contents);
}

/**
 * Every markdown file under `docs/`, published or not.
 *
 * A link's third destination depends on this (see `resolveDocLink`): a real but
 * unpublished document goes to GitHub, a path that is neither goes nowhere and stops the
 * build. Reading the directory rather than listing the files by hand is what keeps that
 * distinction honest as documents come and go.
 */
function markdownUnder(root: string): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".md")) found.add(relative(root, path));
        }
    };
    walk(root);
    return found;
}

async function main(): Promise<void> {
    rmSync(OUT, {recursive: true, force: true});
    mkdirSync(OUT, {recursive: true});

    const all = pages(await Bun.file(join(DOCS, "SUMMARY.md")).text());
    const repoDocs = markdownUnder(DOCS);

    let diagrams = 0;
    for (const page of all) {
        const markdown = await Bun.file(join(DOCS, page.source)).text();
        const {html, hasDiagram} = renderMarkdown(page, markdown, repoDocs);
        if (hasDiagram) diagrams += 1;
        // Directory-style output: `/tech/01-architecture` is a directory holding
        // `index.html`, which is what makes the extensionless URL resolve without a
        // rewrite rule — and what makes the eighteen paths identical to GitBook's.
        write(page.url === "" ? "index.html" : `${page.url}/index.html`,
            renderPage({page, all, body: html, hasDiagram}));
    }

    // `wrangler.jsonc` names this in `not_found_handling`, so it has to exist or an
    // unknown path falls back to a bare Cloudflare error page.
    write("404.html", renderNotFound(all));

    cpSync(join(HERE, "assets"), join(OUT, "assets"), {recursive: true});

    for (const {from, to} of VENDORED) {
        // `resolveSync` handles the files; a directory is not a module specifier, so it is
        // located from its package root instead.
        const source = from.endsWith("woff2-dynamic-subset")
            ? join(dirname(Bun.resolveSync(`${from.slice(0, from.lastIndexOf("/"))}/pretendardvariable-dynamic-subset.css`, HERE)), "woff2-dynamic-subset")
            : Bun.resolveSync(from, HERE);
        cpSync(source, join(OUT, to), {recursive: true});
    }
    for (const file of FROM_WEB) {
        cpSync(join(REPO, "apps/web/public", file), join(OUT, file));
    }

    write("_headers", HEADERS);
    write("robots.txt", `User-agent: *\nAllow: /\nSitemap: https://docs.mapae.io/sitemap.xml\n`);
    write("sitemap.xml", sitemap(all));

    console.log(
        `[docs] ${all.length} pages, ${diagrams} with diagrams → apps/docs/dist`,
    );
}

/**
 * Cloudflare reads this and sets the headers on every asset response.
 *
 * `script-src 'self'` is why mermaid is vendored rather than pulled from a CDN. Mermaid
 * writes the SVG's styling inline, so `style-src` has to allow that — the same exception
 * the product surfaces make, and the reason `object-src`/`frame-ancestors`/`base-uri` are
 * closed here rather than left to defaults.
 */
const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
`;

function sitemap(all: ReturnType<typeof pages>): string {
    const urls = all
        .map((p) => `  <url><loc>https://docs.mapae.io/${p.url}</loc></url>`)
        .join("\n");
    return `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

await main();
