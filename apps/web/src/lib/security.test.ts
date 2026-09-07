import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, test} from "bun:test";
import {
    DOCUMENT_SECURITY_HEADERS,
    createContentSecurityPolicy,
    createSsrNonce,
} from "./security";

const NONCE = "0123456789abcdef0123456789abcdef";
const TELEMETRY_SCRIPT = "https://static.cloudflareinsights.com";
const TELEMETRY_CONNECT = "https://cloudflareinsights.com";

/** The sources of one directive, so a test can say "exactly these" and not "contains". */
function sources(policy: string, directive: string): string[] {
    const found = policy.split("; ").find((entry) => entry.startsWith(`${directive} `));
    if (!found) throw new Error(`${directive} is missing from the policy`);
    return found.slice(directive.length + 1).split(" ");
}

/**
 * The `/*` block of Cloudflare's `_headers`, as the object it encodes. Only the block
 * that applies to every static asset is read — the cache rules further down are per
 * path and are not part of the document's header set.
 */
function readStaticAssetHeaders(): Record<string, string> {
    const lines = readFileSync(join(import.meta.dir, "../../public/_headers"), "utf8").split("\n");
    const start = lines.indexOf("/*");
    if (start === -1) throw new Error("public/_headers has no /* block");
    const headers: Record<string, string> = {};
    for (const line of lines.slice(start + 1)) {
        if (!/^\s/.test(line)) break;
        const separator = line.indexOf(":");
        headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return headers;
}

describe("document security policy", () => {
    test("creates a fresh request nonce on the server", () => {
        const first = createSsrNonce();
        const second = createSsrNonce();

        expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(first).not.toBe(second);
    });

    test("the Studio names no third-party script or connect origin at all", () => {
        // The page whose custody model is "the key never leaves this tab" cannot hand a
        // script-src entry to anyone: that is full-page code execution on the origin
        // that holds the agent key. It shipped with the landing's telemetry origin for
        // a beacon Cloudflare never injected there.
        const policy = createContentSecurityPolicy(NONCE, "app");

        expect(sources(policy, "script-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
        expect(sources(policy, "connect-src")).toEqual([
            "'self'",
            "https://sepolia-rpc.giwa.io",
            "https://facilitator.mapae.io",
        ]);
        expect(policy).not.toContain("cloudflareinsights");
        expect(policy).not.toContain("'unsafe-eval'");
    });

    test("the landing admits exactly the telemetry pair, and differs in nothing else", () => {
        const landing = createContentSecurityPolicy(NONCE, "landing");
        const app = createContentSecurityPolicy(NONCE, "app");

        expect(sources(landing, "script-src")).toEqual([
            "'self'",
            `'nonce-${NONCE}'`,
            TELEMETRY_SCRIPT,
        ]);
        expect(sources(landing, "connect-src")).toContain(TELEMETRY_CONNECT);
        expect(
            landing.replace(` ${TELEMETRY_SCRIPT}`, "").replace(` ${TELEMETRY_CONNECT}`, ""),
        ).toBe(app);
    });

    test("a combined build hosts the Studio, so it carries the Studio's policy", () => {
        expect(createContentSecurityPolicy(NONCE, "combined")).toBe(
            createContentSecurityPolicy(NONCE, "app"),
        );
    });

    test("connect-src names the sponsor origin, and nothing wider", () => {
        // Without this entry the browser refuses the bootstrap request before it is sent,
        // so the onboarding flow fails with no network activity to debug. Pinning it here
        // means removing the line breaks a test rather than an onboarding session.
        //
        // The same origin also carries the sponsored revocation endpoint (`/revoke` is a
        // path rule on the facilitator hostname, and CSP polices origins, not paths) — so
        // this single entry is load-bearing for the kill switch too, and removing it
        // breaks two flows, not one.
        for (const surface of ["app", "landing"] as const) {
            const connect = sources(createContentSecurityPolicy(NONCE, surface), "connect-src");

            expect(connect).toContain("https://facilitator.mapae.io");
            // A wildcard would make every other entry in this list decorative.
            expect(connect.join(" ")).not.toContain("*");
            expect(connect.join(" ")).not.toContain("http://");
            // Linked to from every receipt, fetched by nothing: `<a href>` is not connect-src.
            expect(connect).not.toContain("https://sepolia-explorer.giwa.io");
        }
    });

    test("style-src is the request nonce on both surfaces, with no unsafe-inline anywhere", () => {
        // A nonce-only style-src refuses every `style="…"` attribute and every `<style>`
        // without the nonce. Dev survives it because the root document renders a
        // `meta[property=csp-nonce]` whose IDL `nonce` Vite's client copies onto the
        // styles it injects; production never emits a `<style>` at all. No `-elem` or
        // `-attr` directive: one policy for the developer and the visitor alike.
        for (const surface of ["app", "landing"] as const) {
            const policy = createContentSecurityPolicy(NONCE, surface);

            expect(sources(policy, "style-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
            expect(policy).not.toContain("'unsafe-inline'");
            expect(policy).not.toContain("'unsafe-hashes'");
            expect(policy).not.toContain("style-src-elem");
            expect(policy).not.toContain("style-src-attr");
        }
    });

    test("rejects values that could alter the response header", () => {
        expect(() => createContentSecurityPolicy("bad'; script-src *", "app")).toThrow(
            "CSP nonce must be a 128-bit URL-safe value",
        );
    });
});

/** A line that would put styling in the document by a route the nonce cannot bless. */
const INLINE_STYLE_SOURCE = /\bstyle=\{|<style\b|dangerouslySetInnerHTML/;

/** Every component source under `src`, sorted so a failure names the same file each run. */
function readComponentSources(): Array<{path: string; lines: string[]}> {
    const root = join(import.meta.dir, "..");
    return [...new Bun.Glob("**/*.tsx").scanSync(root)]
        .sort()
        .map((path) => ({path, lines: readFileSync(join(root, path), "utf8").split("\n")}));
}

describe("what the nonce-only style-src depends on", () => {
    // The policy refuses every `style="…"` attribute and every un-nonced `<style>`, and
    // nothing at runtime checks that the tree renders none: a reintroduced attribute
    // fails no unit test and breaks the page only in a browser. These read the source
    // instead, so the first one back fails here.
    test("the pattern flags each shape the policy refuses", () => {
        expect(INLINE_STYLE_SOURCE.test('<i style={{width: "42%"}} />')).toBe(true);
        expect(INLINE_STYLE_SOURCE.test("<style>{css}</style>")).toBe(true);
        expect(INLINE_STYLE_SOURCE.test("<div dangerouslySetInnerHTML={{__html: h}} />")).toBe(
            true,
        );
        // A property write through the CSSOM is the sanctioned route and must stay clean.
        expect(INLINE_STYLE_SOURCE.test("fill.style.width = `${usedPercent}%`;")).toBe(false);
    });

    test("no component renders a style attribute, a style element or raw HTML", () => {
        const sources = readComponentSources();
        expect(sources.map((source) => source.path)).toContain("routes/__root.tsx");

        const offenders = sources.flatMap(({path, lines}) =>
            lines.flatMap((line, index) =>
                INLINE_STYLE_SOURCE.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [],
            ),
        );
        expect(offenders).toEqual([]);
    });

    test("the root document renders the nonce-bearing meta ahead of HeadContent", () => {
        // Vite's dev client copies the `nonce` IDL property of the first
        // `meta[property=csp-nonce]` onto the styles it injects, and TanStack's own meta
        // carries the value in `content` alone — so this line, and its position, is what
        // keeps every dev page styled under the shipped policy.
        const root = readFileSync(join(import.meta.dir, "../routes/__root.tsx"), "utf8");
        const meta = root.indexOf('<meta property="csp-nonce" content={nonce} nonce={nonce} />');
        const head = root.indexOf("<HeadContent />");

        expect(meta).toBeGreaterThan(-1);
        expect(head).toBeGreaterThan(-1);
        expect(meta).toBeLessThan(head);
    });
});

describe("document security headers", () => {
    test("pins HTTPS for a year across subdomains, without preload", () => {
        // Both hosts answered without this header in the live check, so a first visit
        // over http:// was a plain redirect an on-path attacker could hold. Preload is
        // deliberately absent: it is irreversible on the browsers' side.
        expect(DOCUMENT_SECURITY_HEADERS["Strict-Transport-Security"]).toBe(
            "max-age=31536000; includeSubDomains",
        );
    });

    test("the static-asset block of public/_headers is the same set", () => {
        // `_headers` never sees the Worker's document response and the root route never
        // sees a static asset, so the set is written twice. This is what stops the copies
        // drifting apart silently.
        expect(readStaticAssetHeaders()).toEqual({...DOCUMENT_SECURITY_HEADERS});
    });
});
