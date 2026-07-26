/**
 * The classifier, pinned to the three shapes Blockscout actually returned on 2026-07-26.
 *
 * The case that matters is the 200 with `is_verified: false`. Treating only a 404 as
 * "unverified" would have reported the one genuinely unverified Framework unit as
 * verified — the check would have run, printed a total, and been wrong.
 */
import {describe, expect, test} from "bun:test";
import {classifyContract} from "./verify-explorer.js";

/** Shape returned for a Framework unit whose source is published. */
const PARTIAL = {
    name: "ApprovalRevocationEnforcer",
    compiler_version: "v0.8.23+commit.f704f362",
    is_verified: true,
    is_partially_verified: true,
};

describe("classifyContract", () => {
    test("a partially verified unit is verified, and says so", () => {
        expect(classifyContract(200, PARTIAL)).toEqual({
            verification: "partial",
            detail: "ApprovalRevocationEnforcer v0.8.23+commit.f704f362",
        });
    });

    test("a fully verified unit is distinguished from a partial one", () => {
        expect(classifyContract(200, {...PARTIAL, is_partially_verified: false}).verification).toBe("full");
    });

    test("200 with is_verified false is unverified, not verified", () => {
        // Measured: SpecificActionERC20TransferBatchEnforcer answers 200 here, not 404.
        expect(classifyContract(200, {is_verified: false}).verification).toBe("unverified");
        expect(classifyContract(200, {}).verification).toBe("unverified");
    });

    test("404 is unverified", () => {
        expect(classifyContract(404, undefined).verification).toBe("unverified");
    });

    test("anything else is unknown rather than a guess in either direction", () => {
        expect(classifyContract(429, undefined).verification).toBe("unknown");
        expect(classifyContract(500, undefined).verification).toBe("unknown");
        expect(classifyContract(200, "not an object").verification).toBe("unknown");
    });
});
