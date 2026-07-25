import {describe, expect, test} from "bun:test";
import {resolveResourceTarget} from "./agent-runtime.js";

const seller = new URL("http://127.0.0.1:3101");

/**
 * The MCP tool takes a resource path from whatever is driving the agent, which in
 * D5 is a model. A path that resolves to another origin would send `X-PAYMENT` —
 * a bearer authorization — somewhere the operator never configured, so this is a
 * security boundary rather than input tidying.
 */
describe("resolveResourceTarget", () => {
    test("keeps an ordinary absolute path on the seller origin", () => {
        const target = resolveResourceTarget(seller, "/delegated/deliverable/inv-001");
        expect(target.toString()).toBe("http://127.0.0.1:3101/delegated/deliverable/inv-001");
    });

    test("preserves a query string", () => {
        expect(resolveResourceTarget(seller, "/a?b=c").toString()).toBe(
            "http://127.0.0.1:3101/a?b=c",
        );
    });

    test("refuses a protocol-relative path that would change host", () => {
        // new URL("//evil.example", seller) silently yields http://evil.example.
        expect(() => resolveResourceTarget(seller, "//evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses an absolute URL to another origin", () => {
        expect(() => resolveResourceTarget(seller, "http://evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "https://127.0.0.1:3101/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a backslash, which some parsers fold into a slash", () => {
        expect(() => resolveResourceTarget(seller, "/\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "\\\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a relative path that has no anchor on the origin", () => {
        expect(() => resolveResourceTarget(seller, "deliverable/inv-001")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("traversal cannot climb out of the origin", () => {
        // Path traversal normalises within the origin, so it stays safe — asserted
        // so a future change that swaps the origin check for a prefix check fails.
        expect(resolveResourceTarget(seller, "/../../etc/passwd").origin).toBe(seller.origin);
    });

    test("a port change is a different origin", () => {
        expect(() => resolveResourceTarget(seller, "//127.0.0.1:9999/x")).toThrow(
            "absolute path on the seller origin",
        );
    });
});
