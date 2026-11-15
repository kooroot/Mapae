/**
 * Copy the Arcade art from the sibling Mapae-arcade-asset repository into
 * `apps/web/public/arcade/`, after verifying every digest in its `SHA256SUMS`.
 *
 * The art is gitignored but is a build input (`guardian-layers.ts` imports
 * `public/arcade/wardrobe/fit.json`) and several suites read it, so a fresh worktree cannot
 * run `test:web`, `check:counts` or `build:web` without it. CI copies it from a pinned
 * commit; this does the same for a local checkout.
 *
 * The asset repository is looked for in this order: `$MAPAE_ARCADE_ASSET_DIR`; beside the
 * main checkout, found through `git rev-parse --git-common-dir`, because a linked worktree
 * under `.claude/worktrees/` has a different `../` from the checkout the README assumes;
 * then `../Mapae-arcade-asset` beside this repository root.
 *
 * Digests are computed in-process, and nothing is copied unless every listed file is
 * present and matches. `.git` and `previews/` are never copied.
 *
 * Usage: `bun scripts/sync-arcade-assets.ts`
 */
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, isAbsolute, join, normalize, resolve, sep} from "node:path";

export const ASSET_REPO_NAME = "Mapae-arcade-asset";

/** The clone command from apps/web/README.md, printed when no asset repository is found. */
export const CLONE_COMMAND =
    "test -d ../Mapae-arcade-asset/.git || git clone https://github.com/kooroot/Mapae-arcade-asset.git ../Mapae-arcade-asset";

/** Directory names never copied, at any depth. */
const SKIPPED_DIRS = new Set([".git", "previews"]);

export type Candidates = {
    env: string | undefined;
    gitCommonDir: string | undefined;
    repoRoot: string;
};

/** Every path to try, in resolution order, without duplicates. */
export function candidatePaths({env, gitCommonDir, repoRoot}: Candidates): string[] {
    const paths: string[] = [];
    if (env !== undefined && env !== "") paths.push(resolve(env));
    if (gitCommonDir !== undefined) {
        paths.push(resolve(dirname(resolve(repoRoot, gitCommonDir)), "..", ASSET_REPO_NAME));
    }
    paths.push(resolve(repoRoot, "..", ASSET_REPO_NAME));
    return [...new Set(paths)];
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

export type SumEntry = {digest: string; path: string};

/** Parse `sha256sum`/`shasum -a 256` output; paths must stay inside the asset repository. */
export function parseSums(text: string): SumEntry[] {
    const entries: SumEntry[] = [];
    for (const [index, raw] of text.split("\n").entries()) {
        const line = raw.trimEnd();
        if (line === "") continue;
        const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
        if (match === null) throw new Error(`SHA256SUMS line ${index + 1} is not "<sha256>  <path>"`);
        const path = match[2]!;
        const normalized = normalize(path);
        if (isAbsolute(path) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
            throw new Error(`SHA256SUMS line ${index + 1} points outside the asset repository: ${path}`);
        }
        entries.push({digest: match[1]!.toLowerCase(), path});
    }
    return entries;
}

function sha256(path: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(path));
    return hasher.digest("hex");
}

/** HEAD of the asset repository read from its .git files, or undefined when not readable. */
export function readHead(assetDir: string): string | undefined {
    try {
        const gitDir = join(assetDir, ".git");
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(head)) return head;
        const ref = /^ref: (.+)$/.exec(head)?.[1];
        if (ref === undefined) return undefined;
        const loose = join(gitDir, ref);
        if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
        const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
        for (const line of packed.split("\n")) {
            const [sha, name] = line.split(" ");
            if (name === ref && sha !== undefined) return sha;
        }
    } catch {
        // Not a git checkout (a tarball, a CI copy): the HEAD line is simply omitted.
    }
    return undefined;
}

function copyTree(from: string, to: string): number {
    mkdirSync(to, {recursive: true});
    let copied = 0;
    for (const entry of readdirSync(from, {withFileTypes: true})) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) {
            if (SKIPPED_DIRS.has(entry.name)) continue;
            copied += copyTree(source, target);
        } else if (entry.isFile()) {
            copyFileSync(source, target);
            copied += 1;
        }
    }
    return copied;
}

export type SyncResult = {code: number; lines: string[]};

/** Find, verify and copy. Returns the exit code and the lines to print; never exits itself. */
export function syncArcadeAssets(candidates: string[], target: string): SyncResult {
    const assetDir = candidates.find(isDirectory);
    if (assetDir === undefined) {
        return {
            code: 1,
            lines: [
                `${ASSET_REPO_NAME} not found. Tried:`,
                ...candidates.map((path) => `  ${path}`),
                "Clone it beside the main checkout, or set MAPAE_ARCADE_ASSET_DIR:",
                `  ${CLONE_COMMAND}`,
            ],
        };
    }

    const sumsPath = join(assetDir, "SHA256SUMS");
    if (!existsSync(sumsPath)) return {code: 1, lines: [`${sumsPath} is missing; nothing copied`]};
    let entries: SumEntry[];
    try {
        entries = parseSums(readFileSync(sumsPath, "utf8"));
    } catch (error) {
        return {code: 1, lines: [`${(error as Error).message}; nothing copied`]};
    }
    if (entries.length === 0) return {code: 1, lines: [`${sumsPath} lists no files; nothing copied`]};

    const failures: string[] = [];
    for (const {digest, path} of entries) {
        const file = join(assetDir, path);
        if (!existsSync(file) || !statSync(file).isFile()) failures.push(`missing: ${path}`);
        else if (sha256(file) !== digest) failures.push(`digest mismatch: ${path}`);
    }
    if (failures.length > 0) {
        return {code: 1, lines: [`SHA256SUMS verification failed in ${assetDir}:`, ...failures.map((f) => `  ${f}`), "nothing copied"]};
    }

    const source = join(assetDir, "arcade");
    if (!isDirectory(source)) return {code: 1, lines: [`${source} is not a directory; nothing copied`]};
    const copied = copyTree(source, target);
    const head = readHead(assetDir);
    return {
        code: 0,
        lines: [
            `verified ${entries.length} files from ${assetDir}${head === undefined ? "" : ` at ${head}`}`,
            `copied ${copied} files into ${target}`,
        ],
    };
}

if (import.meta.main) {
    const repoRoot = resolve(import.meta.dir, "..");
    const git = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {cwd: repoRoot, stdout: "pipe", stderr: "ignore"});
    const gitCommonDir = git.exitCode === 0 ? git.stdout.toString().trim() || undefined : undefined;
    const candidates = candidatePaths({env: process.env.MAPAE_ARCADE_ASSET_DIR, gitCommonDir, repoRoot});
    const {code, lines} = syncArcadeAssets(candidates, join(repoRoot, "apps/web/public/arcade"));
    (code === 0 ? console.log : console.error)(lines.join("\n"));
    process.exit(code);
}
