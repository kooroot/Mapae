/**
 * Hold the documentation to the same standard as the code: every claim it makes about
 * this repository must still be true.
 *
 * The roadmap says the README *is* the submission. That makes doc rot a correctness bug,
 * not tidiness — and this repo has already paid for all three of the classes below.
 * A commit had to go back and clean dead links; a `bun run` command sat in a doc with no
 * matching `package.json` entry for weeks (`verify-forge-addresses.ts`, which is how a
 * condition worded "re-run this" quietly stopped being re-run); and the stated test count
 * drifted every time a suite grew.
 *
 * Deliberately static and fast — it runs inside `bun run check`, so it must not need a
 * network, a key, or a node. What it cannot check (whether a number is *interesting*,
 * whether prose is honest) it does not pretend to.
 */
import {readdirSync, statSync} from "node:fs";
import {join, dirname, resolve, relative} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const DOCS = [
    "README.md",
    "README.ko.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/tech-notes.md",
    "docs/deployed-contracts.md",
    "docs/revocation-runbook.md",
    "docs/giwa-demo-runbook.md",
];

/**
 * Documents this check reads when they are present and does not require.
 *
 * Both are gitignored on purpose — `ced4db6` kept the agent-facing notes out of the public
 * tree — so a clone does not have them. Reading them unconditionally made `bun run check`
 * crash with a raw `ENOENT` on **every fresh clone** while passing in the working tree
 * that has them, which is the one place it was ever run. The README opens by telling a
 * reader to run that command; it was the first thing they would see fail.
 *
 * Missing files are announced rather than silently skipped. A silent skip is how a
 * renamed document stops being checked without anyone noticing — the same failure as a
 * documented command with no `package.json` entry, which this script exists to catch.
 * Anything not listed here is required, and its absence is still a failure.
 */
const LOCAL_ONLY = new Set(["AGENTS.md", "CLAUDE.md"]);

const failures: string[] = [];
const fail = (doc: string, message: string) => failures.push(`${doc}: ${message}`);

async function loadScripts(): Promise<Map<string, string[]>> {
    /** script name → the manifests that define it */
    const byName = new Map<string, string[]>();
    const manifests: string[] = ["package.json"];
    for (const group of ["apps", "packages"]) {
        for (const entry of readdirSync(join(REPO, group))) {
            const path = `${group}/${entry}/package.json`;
            try {
                statSync(join(REPO, path));
                manifests.push(path);
            } catch {
                /* directory without a manifest */
            }
        }
    }
    for (const path of manifests) {
        const parsed = (await Bun.file(join(REPO, path)).json()) as {
            scripts?: Record<string, string>;
        };
        for (const name of Object.keys(parsed.scripts ?? {})) {
            byName.set(name, [...(byName.get(name) ?? []), path]);
        }
    }
    return byName;
}

async function loadMakeTargets(): Promise<Set<string>> {
    const makefile = await Bun.file(join(REPO, "contracts/Makefile")).text();
    const targets = new Set<string>();
    for (const line of makefile.split("\n")) {
        const match = /^([a-zA-Z][\w:-]*)\s*:(?!=)/.exec(line);
        if (match?.[1]) targets.add(match[1]);
    }
    return targets;
}

/**
 * Every address this repository treats as canonical.
 *
 * The deployment artifacts are the source of truth for the Framework, and
 * `packages/shared/src/token.ts` is the source of truth for MockUSDC — which is *not* in
 * any artifact. That gap is the first thing this check found, and it matters beyond the
 * check: `docs/deployed-contracts.md` opens by saying every address there comes from an
 * artifact, and for MockUSDC that has never been true. Reading both sources is honest;
 * allowlisting MockUSDC would have hidden it.
 */
async function loadCanonicalAddresses(): Promise<Set<string>> {
    const addresses = new Set<string>();
    const add = (value: string) => addresses.add(value.toLowerCase());
    const walk = (value: unknown): void => {
        if (typeof value === "string") {
            if (/^0x[0-9a-fA-F]{40}$/.test(value)) add(value);
        } else if (Array.isArray(value)) {
            for (const item of value) walk(item);
        } else if (value && typeof value === "object") {
            for (const item of Object.values(value)) walk(item);
        }
    };
    for (const entry of readdirSync(join(REPO, "deployments"))) {
        if (!entry.endsWith(".json")) continue;
        walk(await Bun.file(join(REPO, "deployments", entry)).json());
    }
    for (const source of ["packages/shared/src/token.ts", "packages/shared/src/chain.ts"]) {
        const text = await Bun.file(join(REPO, source)).text();
        for (const match of text.matchAll(ADDRESS)) add(match[0]);
    }
    return addresses;
}

/**
 * An address, and not the first 40 hex digits of something longer.
 *
 * Without the boundaries this matches inside every 32-byte transaction hash in the docs
 * and reports a dozen "unknown addresses" that are prefixes of hashes we do have. That was
 * not hypothetical — it was this check's first run.
 */
const ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * Commands are only read out of code spans and fenced blocks.
 *
 * Scanning prose finds "make it legible" and "make a second copy" and demands Makefile
 * targets for them; it also truncates `bun run index.ts` to `bun run index`. A reader only
 * ever *runs* what is in a code context, so that is the only place worth checking.
 */
function codeFragments(text: string): string[] {
    const fragments: string[] = [];
    for (const match of text.matchAll(/```[\s\S]*?```/g)) fragments.push(match[0]);
    for (const match of text.matchAll(/`[^`\n]+`/g)) fragments.push(match[0]);
    return fragments;
}

/**
 * Addresses that are legitimately not ours.
 *
 * Kept as an explicit list rather than a pattern: an allowlist that matches by shape
 * would also swallow a real address someone fat-fingered, which is the whole failure this
 * check exists to catch.
 */
const FOREIGN_ADDRESSES = new Map<string, string>([
    // Well-known Anvil dev keys. Documented precisely because they must NOT be used
    // against a GIWA fork — both carry an EIP-7702 sweeper designator on GIWA.
    ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "anvil dev account #0 (documented trap)"],
    ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "anvil dev account #1 (documented trap)"],
    // Placeholders in `.env.example`-style snippets.
    ["0x1111111111111111111111111111111111111111", "placeholder"],
    ["0x6666666666666666666666666666666666666666", "placeholder"],
]);

/**
 * The README states its test totals three times: a badge, a total, and a breakdown.
 * Make them agree with each other.
 *
 * This cannot know whether the number is *right* — that needs the suite to run, and this
 * check has to stay offline. It can know when the same document contradicts itself, which
 * is the failure that actually happened: the body was updated from 275 to 316 to 325 while
 * the badge stayed at 275 through all of it. Every reader sees the badge first.
 *
 * The breakdown exists because `bun run check` prints four separate numbers; a total that
 * does not equal the sum of its parts is a total nobody can reconcile with the command.
 */
function checkTestCounts(doc: string, text: string): void {
    const badge = /tests-(\d+)%20TS%20%2B%20(\d+)%20Foundry/.exec(text);
    const body = /\*\*(\d+) TypeScript tests \(([^)]*)\)/.exec(text);
    if (!badge || !body) {
        // Only the two READMEs carry these; everything else legitimately has neither.
        if (badge || body) fail(doc, "test counts: badge and body must both be present");
        return;
    }
    const total = Number(body[1]);
    const parts = [...(body[2] ?? "").matchAll(/\d+/g)].map((match) => Number(match[0]));
    const sum = parts.reduce((accumulator, part) => accumulator + part, 0);
    if (Number(badge[1]) !== total) {
        fail(doc, `test counts: badge says ${badge[1]} TS, body says ${total}`);
    }
    if (sum !== total) {
        fail(doc, `test counts: breakdown sums to ${sum}, total says ${total}`);
    }
    const foundry = /\+ (\d+) Foundry tests/.exec(text);
    if (foundry && Number(badge[2]) !== Number(foundry[1])) {
        fail(doc, `test counts: badge says ${badge[2]} Foundry, body says ${foundry[1]}`);
    }
}

async function main(): Promise<void> {
    const scripts = await loadScripts();
    const makeTargets = await loadMakeTargets();
    const canonical = await loadCanonicalAddresses();

    const skipped: string[] = [];
    let checked = 0;
    for (const doc of DOCS) {
        const path = join(REPO, doc);
        const file = Bun.file(path);
        if (!(await file.exists())) {
            if (LOCAL_ONLY.has(doc)) {
                skipped.push(doc);
                continue;
            }
            fail(doc, "is required but does not exist");
            continue;
        }
        checked += 1;
        const text = await file.text();

        // ── 0. the document does not contradict itself about its own test counts ──────
        checkTestCounts(doc, text);

        // ── 1. every documented command exists ────────────────────────────────────────
        // `(?![\w.:-])` keeps `bun run index.ts` from being read as a script named `index`.
        const code = codeFragments(text).join("\n");
        for (const match of code.matchAll(/\bbun run ([a-z][a-z0-9:-]*)(?![\w.:-])/g)) {
            const name = match[1];
            if (name && !scripts.has(name)) {
                fail(doc, `\`bun run ${name}\` is documented but no package.json defines it`);
            }
        }
        for (const match of code.matchAll(/\bmake ([a-z][a-z0-9:-]*)(?![\w.:-])/g)) {
            const name = match[1];
            if (name && !makeTargets.has(name)) {
                fail(doc, `\`make ${name}\` is documented but contracts/Makefile has no such target`);
            }
        }

        // ── 2. every relative link resolves ───────────────────────────────────────────
        // Anchors and absolute URLs are out of scope: one needs a heading parser and the
        // other needs the network, and this check has to stay offline and instant.
        for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
            const target = match[1];
            if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
            const [file] = target.split("#");
            if (!file) continue;
            const resolved = resolve(dirname(path), file);
            try {
                statSync(resolved);
            } catch {
                fail(doc, `link to \`${target}\` does not resolve (${relative(REPO, resolved)})`);
            }
        }

        // ── 3. every address is one we actually deployed ──────────────────────────────
        // A wrong address is the one doc error that sends someone to the wrong contract on
        // an explorer and lets them conclude something false about what is deployed.
        for (const match of text.matchAll(ADDRESS)) {
            const address = match[0].toLowerCase();
            if (canonical.has(address) || FOREIGN_ADDRESSES.has(address)) continue;
            fail(
                doc,
                `address ${match[0]} appears in no deployment artifact — either it is wrong, ` +
                    "or it belongs in FOREIGN_ADDRESSES with a reason",
            );
        }
    }

    if (failures.length > 0) {
        console.error(`[docs] ${failures.length} problem(s):`);
        for (const failure of failures) console.error(`  ✗ ${failure}`);
        process.exit(1);
    }
    const note = skipped.length > 0 ? ` (${skipped.join(", ")} absent — local-only)` : "";
    console.log(
        `[docs] ${checked} documents — commands, links, addresses and test counts check out${note}`,
    );
}

await main();
