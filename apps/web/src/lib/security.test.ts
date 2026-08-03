import {describe, expect, test} from "bun:test";
import {createContentSecurityPolicy, createSsrNonce} from "./security";

describe("document security policy", () => {
    test("creates a fresh request nonce on the server", () => {
        const first = createSsrNonce();
        const second = createSsrNonce();

        expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(first).not.toBe(second);
    });

    test("allows only the nonce-bearing bootstrap and required external telemetry", () => {
        const nonce = "0123456789abcdef0123456789abcdef";
        const policy = createContentSecurityPolicy(nonce);

        expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
        expect(policy).toContain("https://static.cloudflareinsights.com");
        expect(policy).toContain("https://cloudflareinsights.com");
        expect(policy).not.toContain("'unsafe-eval'");
        expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    });

    test("connect-src names the sponsor origin, and nothing wider", () => {
        // Without this entry the browser refuses the bootstrap request before it is sent,
        // so the onboarding flow fails with no network activity to debug. Pinning it here
        // means removing the line breaks a test rather than an onboarding session.
        const policy = createContentSecurityPolicy("0123456789abcdef0123456789abcdef");
        const connect = policy
            .split("; ")
            .find((directive) => directive.startsWith("connect-src"));

        expect(connect).toBeDefined();
        expect(connect).toContain("https://facilitator.mapae.io");
        // A wildcard would make every other entry in this list decorative.
        expect(connect).not.toContain("*");
        expect(connect).not.toContain("http://");
    });

    test("rejects values that could alter the response header", () => {
        expect(() =>
            createContentSecurityPolicy("bad'; script-src *"),
        ).toThrow("CSP nonce must be a 128-bit URL-safe value");
    });
});
