/**
 * The stdio-only invariant, tested in both directions.
 *
 * `judgeStdioOnly` is separated from the bundling so the verdicts can be pinned without
 * paying ~200 ms of `bun build` per case. The two measurements that actually touch the
 * filesystem get one test each, because a judge that reads its inputs correctly proves
 * nothing if the inputs are wrong.
 */
import {describe, expect, test} from "bun:test";
import {countAdapterReferences, judgeStdioOnly} from "./check-mcp-stdio.js";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

describe("judgeStdioOnly", () => {
    test("a control that imports the transport and an entry point that does not passes", () => {
        expect(judgeStdioOnly(3, 0)).toBeNull();
    });

    test("a control that could not be built proves nothing about the entry point", () => {
        // The dangerous shape: the entry point measures 0, which looks like success, but
        // the instrument was never shown to work. Fail-open in the one place that must not.
        expect(judgeStdioOnly(null, 0)).toContain("control bundle could not be built");
    });

    test("a control that finds nothing means the detector is broken, not the tree clean", () => {
        const verdict = judgeStdioOnly(0, 0);
        expect(verdict).toContain("detector is broken");
    });

    test("an entry point that could not be built is unknown, never zero", () => {
        expect(judgeStdioOnly(3, null)).toContain("could not be bundled");
    });

    test("an entry point that reaches the transport fails and says how far", () => {
        const verdict = judgeStdioOnly(3, 7);
        expect(verdict).toContain("7");
        expect(verdict).toContain("stdio");
    });
});

describe("the reachability detector", () => {
    /**
     * A zero from the real entry point means nothing unless the same measurement is
     * non-zero for a bundle that genuinely imports the transport. Both directions run
     * here so the claim stays measured even if the gate's own control branch is removed.
     */
    test("finds the adapter when it is imported, and not when it is not", async () => {
        expect(
            await countAdapterReferences(`${REPO}/apps/agent-mcp/http-transport-control.ts`),
        ).toBeGreaterThan(0);
        expect(await countAdapterReferences(`${REPO}/apps/agent-mcp/index.ts`)).toBe(0);
    });

    test("an unbuildable entry point reports null rather than zero", async () => {
        expect(await countAdapterReferences(`${REPO}/apps/agent-mcp/does-not-exist.ts`)).toBeNull();
    });
});
