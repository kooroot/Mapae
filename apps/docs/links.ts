import {URL_FOR_SOURCE} from "./pages";

const GITHUB_DOCS = "https://github.com/kooroot/Mapae/blob/main/docs";

/**
 * Rewrite the repository's relative `.md` links into published URLs.
 *
 * The documents link to each other the way files do — `../mcp-guide.md` from a chapter,
 * `tech/03-error-model.md` from a cover page — because they are also read in the
 * repository and on GitHub, where those are the links that work. Published, none of them
 * do: the destination is a URL whose shape the file tree does not determine (see
 * `URL_FOR_SOURCE`), and `.md` is not a page.
 *
 * Resolution is relative to the *linking* file's directory, which is why this takes the
 * source path rather than working on the text alone.
 *
 * Three destinations, and the middle one is the interesting one. A published document
 * becomes its site URL. A document that exists in `docs/` but is **not** in `SUMMARY.md`
 * becomes its GitHub source URL — `revocation-runbook.md` links to `tech-notes.md` that
 * way, and GitBook resolved it to GitHub too, so this preserves what readers get rather
 * than inventing a policy. Anything else throws: a link to a file that is not in the
 * repository at all is a typo, and the build is the last cheap place to catch it.
 */
export function resolveDocLink(
    fromSource: string,
    href: string,
    repoDocs: ReadonlySet<string>,
): string {
    const [path, ...fragment] = href.split("#");
    const target = normalize(dirname(fromSource), path ?? "");
    const suffix = fragment.length > 0 ? `#${fragment.join("#")}` : "";

    const url = URL_FOR_SOURCE[target];
    if (url !== undefined) return `/${url}${suffix}`;
    if (repoDocs.has(target)) return `${GITHUB_DOCS}/${target}${suffix}`;

    throw new Error(
        `${fromSource} links to ${href}, which resolves to docs/${target} — a file that ` +
            `does not exist. Fix the link, or make it absolute.`,
    );
}

/** True for the links this rewrites: repository-relative, and pointing at markdown. */
export function isRelativeDocLink(href: string): boolean {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // http:, mailto:, …
    if (href.startsWith("//") || href.startsWith("/") || href.startsWith("#")) return false;
    return /\.md(#|$)/.test(href);
}

function dirname(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
}

/** Collapse `.` and `..` against a base directory, both relative to `docs/`. */
function normalize(base: string, path: string): string {
    const segments = base === "" ? [] : base.split("/");
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join("/");
}
