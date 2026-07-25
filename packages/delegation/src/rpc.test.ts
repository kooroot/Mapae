import {describe, expect, test} from "bun:test";
import {isRateLimitError} from "./rpc.js";

/**
 * This predicate decides whether a failure is retried or surfaced. A false positive
 * is not harmless: it sends a real error through the whole backoff ladder — roughly
 * a minute — before the caller learns anything, which is the opposite of what the
 * transport promises.
 */
describe("isRateLimitError", () => {
    test("recognises what the GIWA public RPC actually sends", () => {
        // A JSON-RPC error body, not an HTTP 429 — viem's own retry never sees it.
        expect(isRateLimitError(new Error("over rate limit"))).toBe(true);
        expect(isRateLimitError(new Error("rate-limited, slow down"))).toBe(true);
    });

    test("recognises the HTTP shapes viem produces", () => {
        expect(isRateLimitError(new Error("HTTP request failed.\nStatus: 429\nURL: …"))).toBe(true);
        expect(isRateLimitError(new Error("Request failed with status code 429"))).toBe(true);
        expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
    });

    test("finds the signal in details and in a nested cause", () => {
        const withDetails = Object.assign(new Error("RPC failed"), {details: "over rate limit"});
        expect(isRateLimitError(withDetails)).toBe(true);
        expect(
            isRateLimitError(new Error("outer", {cause: new Error("inner: too many requests")})),
        ).toBe(true);
    });

    test("a bare 429 inside a number or hash is not a rate limit", () => {
        // Each of these is a real failure that must surface immediately.
        expect(
            isRateLimitError(new Error("insufficient funds: have 429000000000000000 want 5")),
        ).toBe(false);
        expect(isRateLimitError(new Error("query returned no results for block 4291"))).toBe(false);
        expect(isRateLimitError(new Error("execution reverted for tx 0xdead429beef"))).toBe(false);
    });

    test("a caveat rejection is never retried", () => {
        // Retrying this would delay the demo's own headline evidence by a minute.
        expect(
            isRateLimitError(
                new Error("ERC20PeriodTransferEnforcer:transfer-amount-exceeded"),
            ),
        ).toBe(false);
        expect(isRateLimitError(new Error("TimestampEnforcer:expired-delegation"))).toBe(false);
    });

    test("stops walking a cause cycle instead of hanging", () => {
        const a = new Error("a");
        const b = new Error("b", {cause: a});
        (a as {cause?: unknown}).cause = b;
        expect(isRateLimitError(a)).toBe(false);
    });

    test("survives a non-Error", () => {
        expect(isRateLimitError("over rate limit")).toBe(false); // only Errors are walked
        expect(isRateLimitError(undefined)).toBe(false);
    });
});
