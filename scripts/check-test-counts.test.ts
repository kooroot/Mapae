/**
 * The parsers are pinned to output measured from the real tools, not to output invented to
 * match the regex. A parser that returns null where it should return a number turns this
 * gate off, and a gate that is off still prints a success line.
 */
import {describe, expect, test} from "bun:test";
import {
    SUITES,
    compareCounts,
    parseCollectedTotal,
    parseDocumentCounts,
    parseForgeList,
    type DocumentCounts,
} from "./check-test-counts.js";

/** Verbatim from `bun test -t zzzz-no-such-test-name-zzzz packages/… scripts`, bun 1.3.14. */
const BUN_OUTPUT =
    "bun test v1.3.14 (0d9b296a)\n\n" +
    'error: regex "zzzz-no-such-test-name-zzzz" matched 0 tests. ' +
    "Searched 20 files (skipping 256 tests) [208.00ms]\n";

/** Verbatim from `forge test --list --json`, trimmed to two contracts. */
const FORGE_OUTPUT =
    '{"test/DeployDelegationFramework.t.sol":{"DeployDelegationFrameworkTest":' +
    '["test_deploysExact38UnitCompositionAndStartsTwoStepOwnership","test_rejectsEntryPointWithoutCode",' +
    '"test_rejectsZeroOrSameFrameworkAdmin"]},"test/MockUSDC.t.sol":{"MockUSDCTest":' +
    '["a","b","c","d","e","f","g","h","i","j","k"]}}';

/** The English README's shape. The Korean one orders the breakdown label-after-number. */
const README_EN =
    "![Tests](https://img.shields.io/badge/tests-353%20TS%20%2B%2014%20Foundry-16A34A)\n" +
    "- Regression suite: **353 TypeScript tests (256 shared/delegation/seller/scripts + 3 MCP + 94 web)\n" +
    "  + 14 Foundry tests**, plus a chain-parameterised negative-path suite\n";

const README_KO =
    "![Tests](https://img.shields.io/badge/tests-353%20TS%20%2B%2014%20Foundry-16A34A)\n" +
    "- 회귀 검증: **353 TypeScript tests (shared/delegation/seller/scripts 256 + MCP 3 + 웹 94)\n" +
    "  + 14 Foundry tests**, 그리고 동일한 23개 caveat 케이스를\n";

const REAL = {parts: [256, 3, 94], total: 353, foundry: 14};

const stated = (overrides: Partial<DocumentCounts> = {}): DocumentCounts => ({
    badgeTs: 353,
    badgeFoundry: 14,
    total: 353,
    parts: [256, 3, 94],
    bodyFoundry: 14,
    ...overrides,
});

describe("parseCollectedTotal", () => {
    test("reads the collected total out of a filter that matched nothing", () => {
        expect(parseCollectedTotal(BUN_OUTPUT)).toBe(256);
    });

    test("output without the line is null, never zero", () => {
        // Zero would make every comparison below pass against an empty suite.
        expect(parseCollectedTotal("bun test v1.3.14\n\n 12 pass\n")).toBeNull();
        expect(parseCollectedTotal("")).toBeNull();
    });
});

describe("parseForgeList", () => {
    test("sums the tests across contracts", () => {
        expect(parseForgeList(FORGE_OUTPUT)).toBe(14);
    });

    test("malformed output is null", () => {
        expect(parseForgeList("Compiling 3 files...")).toBeNull();
        expect(parseForgeList('{"a.sol":{"C":"not-an-array"}}')).toBeNull();
    });
});

describe("parseDocumentCounts", () => {
    test("reads both README layouts", () => {
        for (const [name, text] of [["en", README_EN], ["ko", README_KO]] as const) {
            const parsed = parseDocumentCounts(text);
            expect(parsed, name).not.toBeNull();
            expect(parsed).toMatchObject({badgeTs: 353, badgeFoundry: 14, total: 353, bodyFoundry: 14});
            expect(parsed?.parts).toEqual([256, 3, 94]);
        }
    });

    test("a document stating no counts is null rather than zeroes", () => {
        expect(parseDocumentCounts("# Some other document\n")).toBeNull();
    });
});

describe("compareCounts", () => {
    test("counts that match reality pass", () => {
        expect(compareCounts("README.md", stated(), REAL)).toEqual([]);
    });

    test("a stale total is caught even when the document agrees with itself", () => {
        // This is the case the old internal-consistency check could not see: badge, total
        // and breakdown all say 341 and all three are wrong.
        const failures = compareCounts(
            "README.md",
            stated({badgeTs: 341, total: 341, parts: [244, 3, 94]}),
            REAL,
        );
        expect(failures.some((f) => f.includes("the suites collect 353"))).toBe(true);
        // The message names the first suite by its live label, whatever it is called today.
        expect(failures.some((f) => f.includes(SUITES[0].label))).toBe(true);
    });

    test("a badge that disagrees with the body is still caught", () => {
        const failures = compareCounts("README.md", stated({badgeTs: 275}), REAL);
        expect(failures.some((f) => f.includes("badge says 275 TS"))).toBe(true);
    });

    test("a breakdown that does not sum to its total is caught", () => {
        const failures = compareCounts("README.md", stated({parts: [200, 3, 94]}), REAL);
        expect(failures.some((f) => f.includes("breakdown sums to 297"))).toBe(true);
    });

    test("a Foundry count that drifted is caught", () => {
        const failures = compareCounts("README.md", stated({badgeFoundry: 11, bodyFoundry: 11}), REAL);
        expect(failures.some((f) => f.includes("forge lists 14"))).toBe(true);
    });

    test("without forge the Foundry numbers are not compared, and TS still is", () => {
        const withoutForge = {...REAL, foundry: null};
        expect(compareCounts("README.md", stated({badgeFoundry: 99, bodyFoundry: 99}), withoutForge))
            .toEqual([]);
        expect(compareCounts("README.md", stated({total: 341, badgeTs: 341}), withoutForge))
            .not.toEqual([]);
    });
});
