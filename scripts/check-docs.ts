/**
 * Hold the documentation to the same standard as the code: every claim it makes about
 * this repository must still be true.
 *
 * The roadmap says the README *is* the submission. That makes doc rot a correctness bug,
 * not tidiness — and this repo has already paid for all three of the classes below.
 * A commit had to go back and clean dead links; a `bun run` command sat in a doc with no
 * matching `package.json` entry for weeks (`verify-forge-addresses.ts`, which is how a
 * condition worded "re-run this" quietly stopped being re-run); and an address that
 * appears in no deployment artifact sends a reader to the wrong contract on an explorer.
 * Stated test counts were checked here too and are now `check-test-counts.ts`'s job.
 *
 * Deliberately static and fast — it runs inside `bun run check`, so it must not need a
 * network, a key, or a node. What it cannot check (whether a number is *interesting*,
 * whether prose is honest) it does not pretend to.
 */
import {readdirSync, statSync} from "node:fs";
import {join, dirname, resolve, relative} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The generated GitBook chapters are listed by reading their directory rather than by
 * name: `build-gitbook.ts` derives one file per section of tech-notes.md, and a chapter
 * it starts deriving tomorrow must enter this net without anyone remembering to add it
 * here — a published page nothing checks is the silent-skip failure the comment below
 * warns about. An absent directory is left to `check:gitbook`, which reports every
 * missing chapter by name instead of crashing this gate with a raw ENOENT.
 */
function listGeneratedChapters(): string[] {
    const list = (dir: string): string[] => {
        try {
            return readdirSync(join(REPO, dir))
                .filter((entry) => entry.endsWith(".md"))
                .map((entry) => `${dir}/${entry}`);
        } catch {
            return [];
        }
    };
    return [...list("docs/tech"), ...list("docs/tech/en")];
}

const DOCS = [
    "README.md",
    "README.ko.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/tech-notes.md",
    "docs/tech-notes.en.md",
    "docs/deployed-contracts.md",
    "docs/mcp-guide.md",
    "docs/seller-guide.md",
    "docs/revocation-runbook.md",
    "docs/giwa-demo-runbook.md",
    "docs/infra-map.md",
    "docs/README.md",
    "docs/README.ko.md",
    "docs/SUMMARY.md",
    ...listGeneratedChapters(),
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
    // Deployed at runtime by the bootstrap service, not by a Forge script, so no
    // deployment artifact will ever carry it. Verified live: code present, 3 mUSDC,
    // ERC-1271 answered 0x1626ba7e for the pre-deployment signature (2026-08-04).
    ["0x15286fe9a48d52504607beaaa021b29194353301", "first sponsored-onboarding account"],
    // Operational EOAs, not contracts — no deployment artifact will ever carry them.
    // Both verified against the live services on 2026-08-04: the signer is what
    // facilitator.mapae.io/health reports, the sponsor is what funded the first
    // sponsored onboarding above.
    ["0x5ea109edc7e89b6a752032aa2b6f1092e081e7ec", "facilitator settlement signer (EOA)"],
    ["0x11e188f7e5beea0bde3016d0dccb2b91226c3211", "bootstrap sponsor (EOA)"],
    ["0x226b24364e573162fa68fb0752748b5ee6312822", "revocation submitter relayer (EOA)"],
    ["0x3306ec395aefa0c0d78d10fcfb45c4390a8edb33", "revocation sponsor (EOA)"],
]);

// Test counts used to be checked here, against the document's own other numbers — badge
// against total against breakdown. That caught the failure it was written for (the body
// went 275 → 316 → 325 while the badge stayed at 275) and missed the larger one: all three
// agree with each other the moment someone edits them together, and none of them was ever
// compared to a suite. They now live in `check-test-counts.ts`, which counts for real.
// Kept out of this file because that check spawns bun and forge, and this one promises to
// stay static, instant and offline.

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

        // ── 2b. every document referenced in a code span exists ───────────────────────
        // Markdown links are checked above. A path written as a code span is not a link and
        // was not checked by anything — which is how `docs/mapae-master.md` sat in the
        // opening paragraph of both agent-facing files pointing at a file that does not
        // exist. That sentence is the one telling an agent what to read before touching
        // anything, so following it correctly led nowhere. (The plan lives beside the
        // repository, in a sibling `mapae-internal-docs/`, deliberately outside the public
        // tree.)
        //
        // Scoped to `*.md` paths containing `docs/`. That set is small, always tracked and
        // has no gitignored members, so the rule cannot produce the false positives that
        // would get it switched off — the same reason the cd-tracking checker was abandoned.
        // A general "every path in a code span exists" rule would flag `apps/*/.env`, which
        // is absent by design.
        for (const match of code.matchAll(/`([A-Za-z0-9_./-]*docs\/[A-Za-z0-9_.-]+\.md)`/g)) {
            const target = match[1];
            if (!target) continue;
            try {
                statSync(resolve(REPO, target));
            } catch {
                fail(doc, `\`${target}\` is referenced but no such file exists`);
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
        `[docs] ${checked} documents — commands, links, document references and addresses check out${note}`,
    );
}

await main();
