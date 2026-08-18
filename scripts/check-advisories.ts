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
 * Empty, and that is the passing state. Every entry here is a vulnerability we decided to
 * live with; the list is meant to stay short and to shrink whenever a fix arrives.
 *
 * It held one entry until 2026-08-18 — a path traversal in `@hono/node-server` reachable
 * only through the MCP SDK's streamable-HTTP transport, which we do not use. The advisory
 * was later revised: the fix had been backported to 1.19.15, the version the lockfile
 * already resolved, so there was nothing left to accept. The proof that entry carried now
 * stands on its own as `scripts/check-mcp-stdio.ts`, because the reason it was written —
 * this server must not grow an HTTP listener — never depended on the advisory.
 */
const ACCEPTED: Acceptance[] = [];

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
    const accepted =
        count === 0
            ? "nothing accepted"
            : `${count} accepted ${count === 1 ? "one" : "ones"} still ` +
              `${count === 1 ? "matches its" : "match their"} stated reason`;
    console.log(`[advisories] no unaccepted advisories; ${accepted}${note}`);
}

if (import.meta.main) await main();
