/**
 * Hold the public copy to the roadmap's 문구 규칙, mechanically.
 *
 * The rail settles a testnet token nobody can cash out, and the Phase 3 roadmap
 * (private archive, `docs/roadmap-phase3.md` §문구 규칙) says how every public surface
 * has to talk about that: the asset is "테스트넷 USDC(tUSDC)", never the bare ticker;
 * the on-chain symbol `mUSDC` is named once, where a symbol is shown, and nowhere else;
 * "매출·수익·구독" appear only inside a "하지 않" negation; and no sentence implies a
 * mainnet or real money coming in. Those rules were applied by hand through W1 — the
 * Studio still said `mUSDC` beside every amount and the README diagram minted an
 * "mUSDC float" — which is the finding `check:logging` and `check:storage` were built
 * on: a rule that is remembered is a rule that drifts.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────────────────
 * Exactly the roadmap's: `apps/web/src` (landing and Studio copy), the two READMEs, the
 * MCP guide and the seller guide. The roadmap, the landscape table, the 외부 사실 and the
 * legal questionnaire are out — they have to state facts about other people's products.
 * Test files under `apps/web/src` are out too: a test that proves the faucet never says
 * the bare ticker has to be allowed to spell it.
 *
 * ── Why comments and identifiers count ────────────────────────────────────────────────
 * Lexical, like its two siblings, and for the same measured reason (`typescript` 7.x
 * exposes no parser to JS). Unlike them it strips nothing: copy lives in string
 * literals, so blanking strings would blind the check, and a comment that says
 * "3 mUSDC available" is the sentence the next edit pastes into the UI. Rewording a
 * comment is cheaper than an AST that knows which strings a visitor reads.
 *
 * ── The allowed form the roadmap's pattern forgot ─────────────────────────────────────
 * The roadmap's own pattern — `\bUSDC\b` minus `tUSDC|MockUSDC|USDC(거래소)` — flags the
 * roadmap's own prescribed phrase "테스트넷 USDC(tUSDC)". A checker that fails the rule's
 * canonical sentence gets switched off, so `USDC(tUSDC)` — that exact spelling, no
 * space — is allowed alongside `USDC(거래소)`. `tUSDC`, `MockUSDC`, `mUSDC` and
 * `MOCK_USDC` never match `\bUSDC\b` to begin with: a letter or `_` on the left is not a
 * word boundary. Only the parenthesised forms need subtracting.
 *
 * ── A manual gate ─────────────────────────────────────────────────────────────────────
 * `bun run check:copy`, deliberately not part of `bun run check`. The roadmap keeps the
 * copy rules out of the repo gate and lists this check as M3.2/M3.8 evidence instead,
 * because the rules are about sentences, and a sentence-level gate on every push would
 * block a hotfix over a comment. Run it before anything that ships words.
 */
import {readdirSync, statSync} from "node:fs";
import {join, relative} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Directories walked for `*.ts` / `*.tsx`, test files excluded. */
export const SCOPE_ROOTS = ["apps/web/src"] as const;

/** Prose files checked whole. */
export const SCOPE_FILES = [
    "README.md",
    "README.ko.md",
    "docs/mcp-guide.md",
    "docs/seller-guide.md",
] as const;

export function isScopedSource(fileName: string): boolean {
    return /\.tsx?$/.test(fileName) && !/\.test\.tsx?$/.test(fileName);
}

export interface CopyRule {
    readonly name: string;
    readonly violates: (line: string) => boolean;
}

/**
 * The two parenthesised spellings a bare `USDC` may carry: the exchange asset the roadmap
 * says must always be written this way, and the roadmap's own spelled-out introduction.
 */
const PARENTHESISED_ALLOWED = /USDC\((?:거래소|tUSDC)\)/g;

export const RULES: readonly CopyRule[] = [
    {
        name: "bare USDC",
        violates: (line) => /\bUSDC\b/.test(line.replace(PARENTHESISED_ALLOWED, "")),
    },
    {
        name: "mUSDC outside a symbol line",
        violates: (line) => line.includes("mUSDC") && !/symbol|심볼/.test(line),
    },
    {
        name: "매출·수익·구독 in the affirmative",
        violates: (line) => /매출|수익|구독/.test(line) && !line.includes("하지 않"),
    },
    {
        name: "mainnet or real money implied",
        violates: (line) => /메인넷에서|실제 돈을 받|mainnet-ready/.test(line),
    },
];

export interface CopyFinding {
    line: number;
    rule: string;
    text: string;
}

const EXCERPT_POINTS = 120;

/** Trimmed and capped by code point, so a cap can never split an emoji or a Hangul pair. */
function excerpt(line: string): string {
    const points = Array.from(line.trim());
    return points.length <= EXCERPT_POINTS
        ? points.join("")
        : `${points.slice(0, EXCERPT_POINTS).join("")}…`;
}

/**
 * Every line that breaks a rule, with the rule and the line. Exported so each rule is
 * provable on a fixture without the filesystem — a checker that has never been shown to
 * fail proves nothing when it passes.
 */
export function findCopyViolations(source: string): CopyFinding[] {
    const findings: CopyFinding[] = [];
    source.split("\n").forEach((raw, index) => {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        for (const rule of RULES) {
            if (rule.violates(line)) {
                findings.push({line: index + 1, rule: rule.name, text: excerpt(line)});
            }
        }
    });
    return findings;
}

export function formatFinding(path: string, finding: CopyFinding): string {
    return `${path}:${finding.line}: ${finding.rule} — ${finding.text}`;
}

/** The scoped files, repo-relative and sorted, so a run's file count is reproducible. */
export function scopedFiles(repo: string = REPO): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (isScopedSource(entry)) files.push(relative(repo, path));
        }
    };
    for (const root of SCOPE_ROOTS) walk(join(repo, root));
    files.push(...SCOPE_FILES);
    return files.sort();
}

if (import.meta.main) {
    const files = scopedFiles();
    const problems: string[] = [];
    for (const path of files) {
        for (const finding of findCopyViolations(await Bun.file(join(REPO, path)).text())) {
            problems.push(formatFinding(path, finding));
        }
    }
    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error(`copy rules: ${problems.length} violation(s) in ${files.length} files`);
        process.exit(1);
    }
    console.log(`copy rules: 0 violations in ${files.length} files`);
}
