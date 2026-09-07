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

    test("style-src keeps unsafe-inline, and no element directive narrows it", () => {
        // `bun run dev` injects each CSS import as a nonce-less `<style>` — Vite reads the
        // csp-nonce meta's `nonce` attribute, TanStack writes its `content` — so a nonce
        // on style-src-elem blanks every dev page while production passes. The policy
        // developers work under has to be the one that ships.
        const policy = createContentSecurityPolicy(NONCE, "app");

        expect(sources(policy, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
        expect(policy).not.toContain("style-src-elem");
        expect(policy).not.toContain("style-src-attr");
    });

    test("rejects values that could alter the response header", () => {
        expect(() => createContentSecurityPolicy("bad'; script-src *", "app")).toThrow(
            "CSP nonce must be a 128-bit URL-safe value",
        );
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
