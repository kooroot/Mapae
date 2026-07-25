/**
 * Hold every accepted dependency advisory to the reason it was accepted.
 *
 * `bun audit` reports vulnerabilities in the tree. Some of them cannot be closed by any
 * semver-compatible update, and the honest response is to accept them with a stated
 * reason rather than force an incompatible version. The problem is the reason. "We never
 * reach that code" is true the day it is written and false the moment someone adds an
 * import, and prose does not notice. So each acceptance below carries a `prove` function
 * that re-measures its own claim on every run.
 *
 * Two directions of failure, both deliberate:
 *   - a finding with no acceptance     → a new advisory cannot hide behind an accepted one
 *   - an acceptance whose proof fails  → the reason we accepted it stopped being true
 *
 * A third, quieter one: an acceptance whose advisory is no longer reported also fails, so
 * the list cannot silently accumulate permissions nobody needs.
 *
 * Unlike the other gate scripts this one wants the network. It degrades instead of
 * failing, and the three states are distinguishable rather than assumed — measured
 * against bun 1.3.14:
 *
 *   | situation                  | exit | stdout            |
 *   |----------------------------|------|-------------------|
 *   | vulnerabilities found      |  1   | `{"pkg":[…]}`     |
 *   | tree is clean              |  0   | `{}`              |
 *   | registry unreachable       |  1   | *empty*           |
 *
 * The exit code alone cannot tell "found something" from "could not ask" — both are 1.
 * stdout can, which is why the classification below reads stdout and ignores the status.
 * When the registry is unreachable the comparison is skipped and said out loud, but the
 * proofs still run: they are local, and it is the proofs that rot.
 */
import {basename, dirname} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

export interface Finding {
    id: number;
    url: string;
    title: string;
    severity: string;
    vulnerable_versions: string;
}

export interface AcceptanceIdentity {
    package: string;
    /** The one advisory this entry covers. A second advisory in the same package is not covered. */
    url: string;
    /**
     * Pinned deliberately. If the advisory is later widened — a new affected range, a
     * different fix version — the acceptance no longer describes what was reviewed, and
     * inheriting an old judgement across a changed advisory is exactly the mistake this
     * file exists to prevent.
     */
    vulnerableVersions: string;
}

interface Acceptance extends AcceptanceIdentity {
    why: string;
    /** Returns null while the claim still holds, or a sentence saying how it broke. */
    prove: () => Promise<string | null>;
}

/**
 * Count references to the vulnerable adapter in an entry point's transitive closure.
 * Returns null when the bundle could not be built — imports that cannot be read support
 * no claim either way.
 */
export async function countAdapterReferences(entrypoint: string): Promise<number | null> {
    // Bundled from the directory that owns the entry point rather than from wherever this
    // script was invoked. `@mapae/*` and the MCP SDK resolve through each package's own
    // node_modules, and the in-process `Bun.build` takes its resolution root from the
    // caller: the identical call succeeded under `bun run` from the repo root and failed
    // under `bun test` with "Could not resolve: @mapae/shared". A detector whose answer
    // depends on who is asking is worthless here, because the answer it gives when it
    // cannot resolve is indistinguishable from "not imported" unless null is handled — and
    // that is the fail-open this whole file exists to prevent. Spawning with an explicit
    // cwd removes the question; ~100 ms is a fair price.
    try {
        const proc = Bun.spawn(["bun", "build", `./${basename(entrypoint)}`, "--target=node"], {
            cwd: dirname(entrypoint),
            stdout: "pipe",
            stderr: "ignore",
        });
        const bundle = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return null;
        return (bundle.match(/hono/gi) ?? []).length;
    } catch {
        // A missing directory makes the spawn itself throw, which must read the same as a
        // failed build: unknown, never zero.
        return null;
    }
}

/**
 * The advisory is a path traversal in `serve-static`, which lives in the Node HTTP adapter
 * that `@modelcontextprotocol/sdk` pulls in for its *streamable HTTP* transport. Our MCP
 * server speaks stdio and starts no HTTP server, so that adapter never enters the bundle.
 *
 * The claim is measured rather than asserted, and the instrument is measured too. A
 * detector that always returned zero — a renamed package, a bundler that minifies the
 * string away, a silently failing build — would pass this check while proving nothing,
 * which is a fail-open in the one place that must not have one. So the control runs first
 * and must find what the real entry point must not: `apps/agent-mcp/advisory-control.ts`
 * imports the HTTP transport on purpose. Measured at the time of writing, 3 references for
 * the control and 0 across the real entry point's 974 modules.
 */
async function proveMcpStaysStdioOnly(): Promise<string | null> {
    const control = await countAdapterReferences(`${REPO}/apps/agent-mcp/advisory-control.ts`);
    if (control === null) {
        return "the control bundle could not be built, so a zero from apps/agent-mcp proves nothing";
    }
    if (control === 0) {
        return (
            "apps/agent-mcp/advisory-control.ts imports the HTTP transport, yet no reference to " +
            "@hono/node-server appears in its bundle — the detector is broken, not the dependency"
        );
    }

    const actual = await countAdapterReferences(`${REPO}/apps/agent-mcp/index.ts`);
    if (actual === null) {
        return "apps/agent-mcp/index.ts could not be bundled, so its imports cannot be read";
    }
    if (actual === 0) return null;
    return (
        `apps/agent-mcp/index.ts now reaches @hono/node-server (${actual} references in its ` +
        "bundle) — the HTTP transport is no longer unused, so this advisory is no longer unreachable"
    );
}

const ACCEPTED: Acceptance[] = [
    {
        package: "@hono/node-server",
        url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
        vulnerableVersions: "<2.0.5",
        why:
            "Windows-only path traversal in serve-static, reachable only through the MCP SDK's " +
            "streamable-HTTP transport, which we do not use. No compatible update exists: " +
            "@modelcontextprotocol/sdk@1.29.0 is the latest published release and declares " +
            "^1.19.9, while 1.19.15 is the highest 1.x ever published — the fix landed in 2.0.5. " +
            "An overrides entry would install a major the SDK never tested against in order to " +
            "patch code the bundle proves we never load.",
        prove: proveMcpStaysStdioOnly,
    },
];

export type AuditReport =
    | {kind: "unavailable"}
    | {kind: "report"; findings: Record<string, Finding[]>};

/**
 * Classify by stdout, never by exit status — `bun audit` exits 1 both when it finds
 * something and when it cannot reach the registry, so the status cannot separate a real
 * report from a failed run. Empty stdout is the only signal that the question went
 * unanswered, and treating it as `{}` would read "could not ask" as "nothing to report".
 */
export function classifyAudit(stdout: string): AuditReport {
    const trimmed = stdout.trim();
    if (trimmed === "") return {kind: "unavailable"};
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return {kind: "unavailable"};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {kind: "unavailable"};
    }
    return {kind: "report", findings: parsed as Record<string, Finding[]>};
}

export function compareFindings(
    findings: Record<string, Finding[]>,
    accepted: AcceptanceIdentity[],
): string[] {
    const failures: string[] = [];
    const matched = new Set<string>();

    for (const [pkg, entries] of Object.entries(findings)) {
        for (const finding of entries ?? []) {
            const acceptance = accepted.find((a) => a.package === pkg && a.url === finding.url);
            if (!acceptance) {
                failures.push(
                    `${pkg}: unaccepted ${finding.severity} advisory — ${finding.title}\n` +
                        `      ${finding.url}\n` +
                        "      Fix it, or add an acceptance with a proof to scripts/check-advisories.ts",
                );
                continue;
            }
            matched.add(`${acceptance.package}|${acceptance.url}`);
            if (acceptance.vulnerableVersions !== finding.vulnerable_versions) {
                failures.push(
                    `${pkg}: the advisory changed since it was accepted — ` +
                        `accepted "${acceptance.vulnerableVersions}", now "${finding.vulnerable_versions}"\n` +
                        "      Re-review it; do not carry the old judgement across a changed advisory",
                );
            }
        }
    }

    for (const acceptance of accepted) {
        if (matched.has(`${acceptance.package}|${acceptance.url}`)) continue;
        failures.push(
            `${acceptance.package}: accepted advisory is no longer reported — ${acceptance.url}\n` +
                "      Delete the acceptance; an unused exception outlives the reason for it",
        );
    }

    return failures;
}

async function runAudit(): Promise<AuditReport> {
    const proc = Bun.spawn(["bun", "audit", "--json"], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return classifyAudit(stdout);
}

async function main(): Promise<void> {
    const failures: string[] = [];

    // Proofs first, and unconditionally. They are the part that goes stale in our tree
    // rather than in the registry, and they do not need the network.
    for (const acceptance of ACCEPTED) {
        const broke = await acceptance.prove();
        if (broke) failures.push(`${acceptance.package}: ${broke}`);
    }

    const audit = await runAudit();
    if (audit.kind === "report") {
        failures.push(...compareFindings(audit.findings, ACCEPTED));
    }

    if (failures.length > 0) {
        console.error("[advisories] dependency advisories need attention:\n");
        for (const failure of failures) console.error(`  ✗ ${failure}`);
        console.error("");
        process.exit(1);
    }

    const note =
        audit.kind === "unavailable"
            ? " (registry unreachable — proofs ran, findings not compared)"
            : "";
    const count = ACCEPTED.length;
    console.log(
        `[advisories] no unaccepted advisories; ${count} accepted ${count === 1 ? "one" : "ones"} ` +
            `still ${count === 1 ? "matches its" : "match their"} stated reason${note}`,
    );
}

if (import.meta.main) await main();
