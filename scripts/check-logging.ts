/**
 * Refuse to let a raw error reach a log sink.
 *
 * This repo's private GIWA endpoint authenticates with an API key in the URL *path*, so
 * the whole URL is a credential that does not look like one. viem embeds its transport
 * URL in every error message, which means `console.error(error.message)` is a credential
 * disclosure wherever that client is used. `redactForLog` reduces any URL to
 * `scheme://host` and caps the bearer-length hex; the rule is that errors reach a sink
 * only through it.
 *
 * That rule was enforced by hand. A 6-dimension audit found 17 escape paths and fixed
 * them one file at a time — and the sweep was scoped to `apps/delegation-lab` and
 * `apps/delegated-agent`, so `apps/agent/index.ts` kept the exact forbidden expression
 * and nobody noticed. It is harmless *today* only because that file builds its client
 * with `http()` and no URL. One line adding `GIWA_SEPOLIA_RPC_URL` there would turn a
 * documented-as-closed hole back into an open one, silently.
 *
 * A rule that new code keeps reintroducing is a rule that belongs in the gate.
 *
 * ── Why lexical, not an AST ──────────────────────────────────────────────────────────
 * The obvious implementation walks a TypeScript AST. This repo's `typescript` is 7.x,
 * the native port, whose npm package exposes `version` and nothing else to JS — no
 * `createSourceFile`, no `SyntaxKind`. Measured, not assumed. Pulling in a second parser
 * to lint one expression shape costs more than it returns, so this scans text instead —
 * after stripping comments, strings and regex literals, which is where the false
 * positives would otherwise all come from. That stripper is the risky part, so it is
 * exported and tested rather than trusted.
 *
 * ── Scope, stated rather than implied ────────────────────────────────────────────────
 * Only `console.*` arguments. That is where all 17 documented escapes lived, and it is
 * the sink whose output the author cannot see at review time. HTTP response bodies are
 * deliberately out of scope: `detail: {message: error.message}` is a real hazard too,
 * but catching it needs to know which objects become responses, and a checker with false
 * positives gets switched off — which is worse than a checker with a stated edge.
 */
import {readdirSync, statSync} from "node:fs";
import {join, relative} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const ROOTS = ["apps", "packages", "scripts"];

/** The sanctioned exits. An error reaching a sink through either of these is fine. */
const REDACTORS = ["redactForLog", "redactUrls"];

/**
 * Identifiers this check treats as holding an error.
 *
 * Deliberately a name list. Deciding "is this an Error" needs type information, and
 * would still say `unknown` for a catch binding — which is the exact shape every one of
 * the documented leaks had.
 */
const ERROR_NAME = "(?:e|err|error|cause|reason|failure|thrown)";

/**
 * Blank out comments, string bodies and regex literals, preserving length and newlines.
 *
 * Length preservation is what keeps reported line numbers honest. Regex literals are
 * stripped for a concrete reason: `redactUrls` in `packages/shared/src/errors.ts`
 * contains `/\bhttps?:\/\/[^\s"'<>)\]}]+/gi`, whose character class holds both a double
 * and a single quote. A stripper that ignores regexes reads that as the start of a
 * string and desynchronises for the rest of the file.
 */
export function stripNonCode(source: string): string {
    const out = source.split("");
    const blank = (from: number, to: number): void => {
        for (let i = from; i < to && i < out.length; i += 1) {
            if (out[i] !== "\n") out[i] = " ";
        }
    };
    // Tracks `${` depth inside template literals so interpolations stay code.
    const templateStack: number[] = [];
    let i = 0;
    /** Last significant code character — decides `/` as regex vs division. */
    let previous = "";

    while (i < source.length) {
        const char = source[i] ?? "";
        const next = source[i + 1] ?? "";

        if (char === "/" && next === "/") {
            let end = source.indexOf("\n", i);
            if (end === -1) end = source.length;
            blank(i, end);
            i = end;
            continue;
        }
        if (char === "/" && next === "*") {
            let end = source.indexOf("*/", i + 2);
            end = end === -1 ? source.length : end + 2;
            blank(i, end);
            i = end;
            continue;
        }
        if (char === '"' || char === "'") {
            let j = i + 1;
            while (j < source.length && source[j] !== char) {
                if (source[j] === "\\") j += 1;
                if (source[j] === "\n") break;
                j += 1;
            }
            blank(i + 1, j);
            i = j + 1;
            previous = char;
            continue;
        }
        if (char === "`") {
            templateStack.push(0);
            i += 1;
            previous = "`";
            // Body handled below by the template branch.
            let j = i;
            while (j < source.length) {
                if (source[j] === "\\") {
                    j += 2;
                    continue;
                }
                if (source[j] === "`") break;
                if (source[j] === "$" && source[j + 1] === "{") break;
                j += 1;
            }
            blank(i, j);
            i = j;
            if (source[i] === "`") {
                templateStack.pop();
                i += 1;
            } else if (source[i] === "$") {
                // Enter the interpolation as code; the closing `}` is matched below.
                i += 2;
            }
            continue;
        }
        if (char === "}" && templateStack.length > 0) {
            // Leaving an interpolation — resume template body scanning.
            i += 1;
            let j = i;
            while (j < source.length) {
                if (source[j] === "\\") {
                    j += 2;
                    continue;
                }
                if (source[j] === "`") break;
                if (source[j] === "$" && source[j + 1] === "{") break;
                j += 1;
            }
            blank(i, j);
            i = j;
            if (source[i] === "`") {
                templateStack.pop();
                i += 1;
            } else if (source[i] === "$") {
                i += 2;
            }
            continue;
        }
        if (char === "/" && /[(,=:[!&|?{};+\-*%<>~^]/.test(previous)) {
            let j = i + 1;
            let inClass = false;
            while (j < source.length) {
                const c = source[j];
                if (c === "\\") {
                    j += 2;
                    continue;
                }
                if (c === "[") inClass = true;
                else if (c === "]") inClass = false;
                else if (c === "/" && !inClass) break;
                else if (c === "\n") break;
                j += 1;
            }
            blank(i + 1, j);
            i = j + 1;
            previous = "/";
            continue;
        }
        if (!/\s/.test(char)) previous = char;
        i += 1;
    }
    return out.join("");
}

/** Blank out every `redactForLog(...)` / `redactUrls(...)` call span, braces balanced. */
function blankRedactorCalls(text: string): string {
    let result = text;
    for (const name of REDACTORS) {
        let from = 0;
        for (;;) {
            const start = result.indexOf(`${name}(`, from);
            if (start === -1) break;
            let depth = 0;
            let end = start + name.length;
            for (; end < result.length; end += 1) {
                if (result[end] === "(") depth += 1;
                else if (result[end] === ")") {
                    depth -= 1;
                    if (depth === 0) {
                        end += 1;
                        break;
                    }
                }
            }
            result =
                result.slice(0, start) +
                result.slice(start, end).replace(/[^\n]/g, " ") +
                result.slice(end);
            from = end;
        }
    }
    return result;
}

/**
 * The forbidden expression shapes.
 *
 * `.stack` carries no name guard on purpose: on a viem `BaseError` the stack *begins*
 * with the composed message, including `URL:` and `Request body:`, so it leaks strictly
 * more than `.message` — and it leaks past `redactForLog`, which collapses newlines and
 * caps at 300 characters.
 */
/**
 * An error reference, including a property chain and optional chaining.
 *
 * The `?.` alternative is not cosmetic. `console.error(error?.message)` is the same leak
 * as `console.error(error.message)` and reads as more careful, which is exactly why it
 * is the form a person writes while tidying up a catch block. A first draft of this
 * check missed it — found by probing shapes the tests did not cover, not by the tests.
 */
const ERROR_REF = `${ERROR_NAME}(?:\\??\\.[a-zA-Z_$][\\w$]*)*`;

const LEAKS: {pattern: RegExp; label: string}[] = [
    {pattern: new RegExp(`\\b${ERROR_NAME}\\??\\.message\\b`, "gi"), label: "error.message"},
    {pattern: /\??\.stack\b/g, label: ".stack"},
    {pattern: new RegExp(`\\bString\\(\\s*${ERROR_REF}\\s*\\)`, "gi"), label: "String(error)"},
    {
        pattern: new RegExp(`\\bJSON\\.stringify\\(\\s*${ERROR_REF}\\s*[,)]`, "gi"),
        label: "JSON.stringify(error)",
    },
];

export interface LogFinding {
    line: number;
    label: string;
    text: string;
}

/**
 * Find raw errors inside `console.*` arguments.
 *
 * Exported so the matcher is provable without the filesystem — a checker that runs in
 * the gate and has never been shown to fail is as much a liability as no checker.
 */
export function findLogLeaks(source: string): LogFinding[] {
    const code = stripNonCode(source);
    const findings: LogFinding[] = [];
    const call = /\bconsole\s*\.\s*[a-zA-Z]+\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = call.exec(code)) !== null) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let end = open;
        for (; end < code.length; end += 1) {
            if (code[end] === "(") depth += 1;
            else if (code[end] === ")") {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        const args = blankRedactorCalls(code.slice(open + 1, end));
        for (const {pattern, label} of LEAKS) {
            pattern.lastIndex = 0;
            let hit: RegExpExecArray | null;
            while ((hit = pattern.exec(args)) !== null) {
                const absolute = open + 1 + hit.index;
                const line = code.slice(0, absolute).split("\n").length;
                findings.push({
                    line,
                    label,
                    text: source
                        .split("\n")
                        [line - 1]?.trim()
                        .slice(0, 100) ?? "",
                });
            }
        }
        call.lastIndex = end;
    }
    return findings;
}

function sourceFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.tsx?$/.test(entry)) continue;
            // Tests are excluded: they build errors on purpose and never run anywhere
            // that holds the credential.
            if (/\.test\.tsx?$/.test(entry)) continue;
            files.push(path);
        }
    };
    for (const root of ROOTS) walk(join(REPO, root));
    return files;
}

if (import.meta.main) {
    const problems: string[] = [];
    for (const path of sourceFiles()) {
        for (const finding of findLogLeaks(await Bun.file(path).text())) {
            problems.push(
                `${relative(REPO, path)}:${finding.line}  ${finding.label} — ${finding.text}`,
            );
        }
    }
    if (problems.length > 0) {
        console.error(`[logging] ${problems.length} raw error(s) reaching a console sink:`);
        for (const problem of problems) console.error(`  ✗ ${problem}`);
        console.error("");
        console.error("  Wrap it: console.error(redactForLog(error))");
        console.error("  Why: viem puts the transport URL in every error, and the private");
        console.error("  GIWA endpoint carries its API key in the URL path.");
        process.exit(1);
    }
    console.log("[logging] no raw errors reach a console sink");
}
