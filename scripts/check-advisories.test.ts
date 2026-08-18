/**
 * The two halves of the advisory gate that can be tested without a registry.
 *
 * `classifyAudit` carries the whole offline story: `bun audit` exits 1 both when it finds
 * something and when it cannot ask, so every case below is pinned against output measured
 * from bun 1.3.14 rather than assumed from the exit code.
 */
import {describe, expect, test} from "bun:test";
import {
    classifyAudit,
    compareFindings,
    type AcceptanceIdentity,
    type Finding,
} from "./check-advisories.js";

/** Verbatim stdout from `bun audit --json` in this repo on 2026-07-26. */
const REAL_REPORT =
    '{"@hono/node-server":[{"id":1124006,"url":"https://github.com/advisories/GHSA-frvp-7c67-39w9",' +
    '"title":"Node.js Adapter for Hono: Path traversal in `serve-static` on Windows via encoded ' +
    'backslash (`%5C`)","severity":"moderate","vulnerable_versions":"<2.0.5","cwe":["CWE-22"],' +
    '"cvss":{"score":5.9,"vectorString":"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N"}}]}';

const HONO: AcceptanceIdentity = {
    package: "@hono/node-server",
    url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
    vulnerableVersions: "<2.0.5",
};

const finding = (overrides: Partial<Finding> = {}): Finding => ({
    id: 1124006,
    url: HONO.url,
    title: "Path traversal in serve-static on Windows",
    severity: "moderate",
    vulnerable_versions: "<2.0.5",
    ...overrides,
});

describe("classifyAudit", () => {
    test("empty stdout is 'could not ask', not 'nothing to report'", () => {
        // Measured: with an unreachable registry bun prints nothing to stdout and exits 1.
        // Reading that as `{}` would mark every acceptance stale and fail the gate offline.
        expect(classifyAudit("")).toEqual({kind: "unavailable"});
        expect(classifyAudit("   \n ")).toEqual({kind: "unavailable"});
    });

    test("an empty object is a real report — the tree is clean", () => {
        expect(classifyAudit("{}")).toEqual({kind: "report", findings: {}});
    });

    test("the repository's actual finding parses", () => {
        const result = classifyAudit(REAL_REPORT);
        expect(result.kind).toBe("report");
        if (result.kind !== "report") throw new Error("unreachable");
        expect(result.findings["@hono/node-server"]?.[0]?.vulnerable_versions).toBe("<2.0.5");
    });

    test("output that is not a JSON object counts as unavailable", () => {
        expect(classifyAudit("error: audit request failed")).toEqual({kind: "unavailable"});
        expect(classifyAudit("[]")).toEqual({kind: "unavailable"});
        expect(classifyAudit("null")).toEqual({kind: "unavailable"});
    });
});

describe("compareFindings", () => {
    test("an accepted advisory at the accepted range passes", () => {
        expect(compareFindings({"@hono/node-server": [finding()]}, [HONO])).toEqual([]);
    });

    test("a clean tree with nothing accepted passes", () => {
        expect(compareFindings({}, [])).toEqual([]);
    });

    test("an unaccepted advisory fails", () => {
        // The accepted one is reported alongside it, so this isolates the unaccepted rule
        // instead of also tripping the stale-acceptance rule below.
        const failures = compareFindings(
            {
                "@hono/node-server": [finding()],
                lodash: [finding({url: "https://example.test/GHSA-x", id: 2})],
            },
            [HONO],
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("lodash");
        expect(failures[0]).toContain("unaccepted");
    });

    test("a second advisory in an accepted package is not covered by the first", () => {
        // The acceptance names one URL. Blanket-accepting a package would let a genuinely
        // exploitable advisory ride in on a judgement made about an unrelated one.
        const failures = compareFindings(
            {"@hono/node-server": [finding(), finding({url: "https://example.test/GHSA-other", id: 2})]},
            [HONO],
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("GHSA-other");
    });

    test("a widened advisory re-opens the decision", () => {
        const failures = compareFindings(
            {"@hono/node-server": [finding({vulnerable_versions: "<2.1.0"})]},
            [HONO],
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("<2.0.5");
        expect(failures[0]).toContain("<2.1.0");
    });

    test("an acceptance the audit no longer reports must be deleted", () => {
        const failures = compareFindings({}, [HONO]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("no longer reported");
    });
});
