import {describe, expect, test} from "bun:test";
import {createContentSecurityPolicy, createSsrNonce} from "./security";

const NONCE = "0123456789abcdef0123456789abcdef";
const TELEMETRY_SCRIPT = "https://static.cloudflareinsights.com";
const TELEMETRY_CONNECT = "https://cloudflareinsights.com";

/** The sources of one directive, so a test can say "exactly these" and not "contains". */
function sources(policy: string, directive: string): string[] {
    const found = policy.split("; ").find((entry) => entry.startsWith(`${directive} `));
    if (!found) throw new Error(`${directive} is missing from the policy`);
    return found.slice(directive.length + 1).split(" ");
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

    test("stylesheet elements need the nonce; style attributes keep unsafe-inline", () => {
        // The production document emits one nonce-stamped `<link>` and no `<style>`, so
        // the element directive can be as tight as script-src. The attribute directive
        // cannot: React's `style="…"` props have no nonce. The plain style-src stays as
        // the fallback for browsers that predate the split.
        const policy = createContentSecurityPolicy(NONCE, "app");

        expect(sources(policy, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
        expect(sources(policy, "style-src-elem")).toEqual(["'self'", `'nonce-${NONCE}'`]);
        expect(sources(policy, "style-src-attr")).toEqual(["'unsafe-inline'"]);
    });

    test("rejects values that could alter the response header", () => {
        expect(() => createContentSecurityPolicy("bad'; script-src *", "app")).toThrow(
            "CSP nonce must be a 128-bit URL-safe value",
        );
    });
});
