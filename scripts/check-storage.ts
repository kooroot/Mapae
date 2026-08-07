/**
 * Keep browser-storage writes to one reviewed module.
 *
 * The web app persists the Studio grant list, and the invariant that makes that
 * acceptable is narrow: the permission context may be stored, the agent session private
 * key may not. `grant-store.ts` holds that line with an explicit allowlist projection, and
 * `grant-store.test.ts` asserts a known private key never reaches the serialized document.
 *
 * That protects the store. It protects nothing else. A second `localStorage.setItem`
 * added anywhere in the app inherits none of it — no allowlist, no test, no review — and
 * would be a new place for a secret to land on disk with no gate noticing.
 *
 * This is the same gap `check:logging` exists to close, and for the same measured reason:
 * remembering did not work. That sweep was scoped to two directories and a forbidden
 * expression survived in a third. So the rule is mechanical rather than remembered — one
 * sanctioned module, everything else refused.
 *
 * **Writes only.** A read cannot leak what was never put there, and `removeItem` is the
 * mitigation rather than the risk, so both are allowed everywhere. `document.cookie`
 * assignment counts as a write: it is storage by another name, and it additionally ships
 * its value to the server on every request.
 *
 * Lexical, not AST-based, for the same reason as `check:logging`: `typescript` here is the
 * 7.x native port, whose npm package exposes `version` to JS and nothing else. The
 * comment/string stripper is shared with that checker rather than written twice.
 */
import {readdirSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {stripNonCode} from "./check-logging";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Only the web app runs in a browser; the services have no storage to write to. */
const ROOT = "apps/web/src";

/**
 * The one module allowed to write. Named as a path rather than a basename so a copy
 * elsewhere in the tree does not inherit the allowance by having the same file name.
 */
export const STORE_MODULE = "apps/web/src/lib/grant-store.ts";

/**
 * `locale.tsx` writes the locale cookie, and that predates this rule and is deliberate:
 * two bytes, no secret, and it must be readable during server render — the reasoning is
 * in that file's own header. Listed explicitly rather than exempting cookies as a class,
 * because a cookie is the one store that also travels to the server.
 */
const COOKIE_EXCEPTIONS = ["apps/web/src/lib/locale.tsx"];

interface StorageApi {
    api: string;
    /** Matches a *write* through this API. Reads and removals are deliberately absent. */
    pattern: RegExp;
}

const WRITES: StorageApi[] = [
    {
        api: "localStorage",
        pattern: /(?:\bwindow\s*\.\s*)?\blocalStorage\s*\.\s*(?:setItem|clear)\s*\(/g,
    },
    {
        api: "sessionStorage",
        pattern: /(?:\bwindow\s*\.\s*)?\bsessionStorage\s*\.\s*(?:setItem|clear)\s*\(/g,
    },
    // Any use of indexedDB is a write path: `open` is how a database is created, and the
    // object stores behind it are not visible to a lexical scan.
    {api: "indexedDB", pattern: /(?:\bwindow\s*\.\s*)?\bindexedDB\s*\.\s*\w+\s*\(/g},
    {api: "document.cookie", pattern: /\bdocument\s*\.\s*cookie\s*(?:\+)?=[^=]/g},
];

export interface StorageFinding {
    api: string;
    line: number;
    text: string;
}

export function findStorageWrites(source: string): StorageFinding[] {
    const code = stripNonCode(source);
    const findings: StorageFinding[] = [];
    for (const {api, pattern} of WRITES) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(code)) !== null) {
            findings.push({
                api,
                line: code.slice(0, match.index).split("\n").length,
                text: match[0].trim(),
            });
        }
    }
    return findings.sort((a, b) => a.line - b.line);
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
            if (/\.test\.tsx?$/.test(entry)) continue;
            files.push(path);
        }
    };
    walk(join(REPO, ROOT));
    return files;
}

if (import.meta.main) {
    const problems: string[] = [];
    for (const path of sourceFiles()) {
        const rel = relative(REPO, path);
        if (rel === STORE_MODULE) continue;
        for (const finding of findStorageWrites(await Bun.file(path).text())) {
            if (finding.api === "document.cookie" && COOKIE_EXCEPTIONS.includes(rel)) continue;
            problems.push(`${rel}:${finding.line}  ${finding.api} — ${finding.text}`);
        }
    }
    if (problems.length > 0) {
        console.error(`[storage] ${problems.length} browser-storage write(s) outside the store:`);
        for (const problem of problems) console.error(`  ✗ ${problem}`);
        console.error("");
        console.error(`  Route it through ${STORE_MODULE}, or state why it belongs here.`);
        console.error("  Why: that module's projection is an allowlist that omits the agent");
        console.error("  session private key, and a test pins it. A write elsewhere inherits");
        console.error("  neither, and browser storage is unencrypted and survives restart.");
        process.exit(1);
    }
    console.log(`[storage] browser-storage writes stay inside ${STORE_MODULE}`);
}
