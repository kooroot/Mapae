/**
 * Hold the README's stated test counts to the number of tests that actually exist.
 *
 * `check-docs.ts` was written partly because "the stated test count drifted every time a
 * suite grew", but the check it grew only compared the documents to *themselves* — badge
 * against body against the breakdown sum. All three drift together the moment someone
 * updates one number by hand, and none of them is measured against a suite. That hole was
 * not theoretical: adding twelve tests took the real count from 341 to 353 while the gate
 * stayed green and printed "test counts check out".
 *
 * Counting is done by bun and forge rather than by a regex over source, because a regex has
 * to guess at `describe.each`, generated cases and skipped tests, and a count that is wrong
 * in a new way is worse than one that is merely stale. `bun test -t <pattern that matches
 * nothing>` collects every file and reports "skipping N tests" without executing a single
 * body — about 200 ms per suite. `forge test --list --json` compiles but does not run.
 *
 * Kept out of `check-docs.ts` on purpose: that script promises to stay static, instant and
 * offline, and this one spawns bun three times and forge once. Two gates, two promises.
 */
import {join} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * A test name no test has. bun reports the collected total when a `-t` filter matches
 * nothing, which is how the count is obtained without running anything.
 */
const MATCHES_NOTHING = "zzzz-no-such-test-name-zzzz";

/**
 * The TypeScript suites, in the order the README breaks them down. They mirror `test:ts`,
 * `test:mcp`, `test:web` and `test:docs` in package.json; the app-scoped ones run from
 * their own directory because `@mapae/*` resolves through each package's own node_modules
 * and not from the repository root.
 */
const SUITES = [
    {label: "shared/delegation/scripts", cwd: REPO, args: ["packages/shared/src", "packages/delegation/src", "scripts"]},
    {label: "MCP", cwd: join(REPO, "apps/agent-mcp"), args: []},
    {label: "web", cwd: join(REPO, "apps/web"), args: []},
    {label: "docs", cwd: join(REPO, "apps/docs"), args: []},
] as const;

const DOCS = ["README.md", "README.ko.md"];

export interface DocumentCounts {
    badgeTs: number;
    badgeFoundry: number;
    total: number;
    parts: number[];
    bodyFoundry: number | null;
}

/** Extract every count a README states about its own test suites. */
export function parseDocumentCounts(text: string): DocumentCounts | null {
    const badge = /tests-(\d+)%20TS%20%2B%20(\d+)%20Foundry/.exec(text);
    const body = /\*\*(\d+) TypeScript tests \(([^)]*)\)/.exec(text);
    if (!badge || !body) return null;
    const foundry = /\+ (\d+) Foundry tests/.exec(text);
    return {
        badgeTs: Number(badge[1]),
        badgeFoundry: Number(badge[2]),
        total: Number(body[1]),
        parts: [...(body[2] ?? "").matchAll(/\d+/g)].map((match) => Number(match[0])),
        bodyFoundry: foundry ? Number(foundry[1]) : null,
    };
}

/**
 * Read the collected total out of `bun test -t <no match>`. Returns null when the line is
 * absent, which must be treated as a failure rather than a zero — an unreadable count is
 * the one answer that would let every comparison below pass vacuously.
 */
export function parseCollectedTotal(output: string): number | null {
    const match = /skipping (\d+) tests/.exec(output);
    return match?.[1] === undefined ? null : Number(match[1]);
}

/** Count the tests forge would run, from `forge test --list --json`. */
export function parseForgeList(json: string): number | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json.trim());
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    let total = 0;
    for (const contracts of Object.values(parsed as Record<string, unknown>)) {
        if (!contracts || typeof contracts !== "object") return null;
        for (const tests of Object.values(contracts as Record<string, unknown>)) {
            if (!Array.isArray(tests)) return null;
            total += tests.length;
        }
    }
    return total;
}

export function compareCounts(
    doc: string,
    stated: DocumentCounts,
    actual: {parts: number[]; total: number; foundry: number | null},
): string[] {
    const failures: string[] = [];
    const say = (message: string) => failures.push(`${doc}: ${message}`);

    if (stated.badgeTs !== stated.total) {
        say(`badge says ${stated.badgeTs} TS, body says ${stated.total}`);
    }
    const sum = stated.parts.reduce((accumulator, part) => accumulator + part, 0);
    if (sum !== stated.total) {
        say(`breakdown sums to ${sum}, total says ${stated.total}`);
    }
    if (stated.total !== actual.total) {
        say(`says ${stated.total} TypeScript tests, the suites collect ${actual.total}`);
    }
    if (stated.parts.length !== actual.parts.length) {
        say(`breakdown lists ${stated.parts.length} suites, there are ${actual.parts.length}`);
    } else {
        stated.parts.forEach((part, index) => {
            const real = actual.parts[index];
            if (part !== real) {
                say(`breakdown says ${part} for ${SUITES[index]?.label ?? `suite ${index}`}, it collects ${real}`);
            }
        });
    }

    if (stated.bodyFoundry !== null && stated.badgeFoundry !== stated.bodyFoundry) {
        say(`badge says ${stated.badgeFoundry} Foundry, body says ${stated.bodyFoundry}`);
    }
    if (actual.foundry !== null) {
        if (stated.badgeFoundry !== actual.foundry) {
            say(`badge says ${stated.badgeFoundry} Foundry tests, forge lists ${actual.foundry}`);
        }
        if (stated.bodyFoundry !== null && stated.bodyFoundry !== actual.foundry) {
            say(`body says ${stated.bodyFoundry} Foundry tests, forge lists ${actual.foundry}`);
        }
    }

    return failures;
}

async function collect(cwd: string, args: string[]): Promise<number | null> {
    const proc = Bun.spawn(["bun", "test", "-t", MATCHES_NOTHING, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    // bun exits non-zero because the filter matched nothing; that is the expected path here,
    // so the count comes from the output rather than the status.
    const output =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    return parseCollectedTotal(output);
}

async function collectForge(): Promise<number | null> {
    try {
        const proc = Bun.spawn(["forge", "test", "--list", "--json"], {
            cwd: join(REPO, "contracts"),
            stdout: "pipe",
            stderr: "ignore",
        });
        const output = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return null;
        // `--list` prints a banner line before the JSON when the project needs compiling.
        const start = output.indexOf("{");
        return start === -1 ? null : parseForgeList(output.slice(start));
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const failures: string[] = [];

    const parts: number[] = [];
    for (const suite of SUITES) {
        const count = await collect(suite.cwd, [...suite.args]);
        if (count === null) {
            failures.push(
                `${suite.label}: could not read a test count from bun — the suite may be broken, ` +
                    "or bun's output format changed and this check is no longer measuring anything",
            );
            continue;
        }
        parts.push(count);
    }

    // Without every suite there is no total to compare, and comparing a partial one would
    // report a mismatch against a number nobody wrote down.
    if (failures.length === 0) {
        const total = parts.reduce((accumulator, part) => accumulator + part, 0);
        const foundry = await collectForge();

        for (const doc of DOCS) {
            const text = await Bun.file(join(REPO, doc)).text();
            const stated = parseDocumentCounts(text);
            if (!stated) {
                failures.push(`${doc}: states no test counts — the badge or the body line is gone`);
                continue;
            }
            failures.push(...compareCounts(doc, stated, {parts, total, foundry}));
        }

        if (failures.length === 0) {
            const note = foundry === null ? " (forge unavailable — Foundry count not compared)" : "";
            console.log(
                `[counts] ${DOCS.length} documents state ${total} TypeScript` +
                    `${foundry === null ? "" : ` + ${foundry} Foundry`} tests, and that is how many there are${note}`,
            );
            return;
        }
    }

    console.error("[counts] stated test counts do not match reality:\n");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error("");
    process.exit(1);
}

if (import.meta.main) await main();
