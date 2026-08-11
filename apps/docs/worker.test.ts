import {describe, expect, test} from "bun:test";
import {CANONICAL_HOST, redirectTarget} from "./worker";

describe("redirectTarget", () => {
    test("the old host moves to the new one and keeps the path", () => {
        // The load-bearing half. A redirect that dropped the path would send every deep
        // link — including the one filed in the submission form — to the cover page.
        expect(redirectTarget("https://gitbook.mapae.io/tech/02-payment-flows")).toBe(
            "https://docs.mapae.io/tech/02-payment-flows",
        );
        expect(redirectTarget("https://gitbook.mapae.io/operations/mcp-guide")).toBe(
            "https://docs.mapae.io/operations/mcp-guide",
        );
    });

    test("the root of the old host still lands on the cover", () => {
        expect(redirectTarget("https://gitbook.mapae.io/")).toBe("https://docs.mapae.io/");
    });

    test("query and fragment survive", () => {
        expect(redirectTarget("https://gitbook.mapae.io/readme.ko?from=form#evidence")).toBe(
            "https://docs.mapae.io/readme.ko?from=form#evidence",
        );
    });

    test("an HTTP request lands on HTTPS in one hop, not two", () => {
        expect(redirectTarget("http://gitbook.mapae.io/tech/04-security")).toBe(
            "https://docs.mapae.io/tech/04-security",
        );
    });

    test("the canonical host is never redirected to itself", () => {
        // Not decoration: without this branch a misrouted Worker answers every request with
        // a redirect to the address that produced it, and the site is unreachable rather
        // than merely misconfigured.
        expect(redirectTarget("https://docs.mapae.io/tech/01-architecture")).toBeUndefined();
        expect(redirectTarget("https://docs.mapae.io/")).toBeUndefined();
    });

    test("the destination is the docs host", () => {
        expect(CANONICAL_HOST).toBe("docs.mapae.io");
    });
});
