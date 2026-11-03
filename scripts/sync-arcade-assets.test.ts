/**
 * The asset sync against a fake asset repository built in a temporary directory: no
 * network, no real art, and the real `apps/web/public/arcade` is never touched.
 */
import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative} from "node:path";
import {ASSET_REPO_NAME, candidatePaths, syncArcadeAssets} from "./sync-arcade-assets.js";

const FILES: Record<string, string> = {
    "arcade/lobby-scene.webp": "lobby",
    "arcade/wardrobe/fit.json": '{"fit":true}',
    "arcade/guardians/a/b.png": "deep",
};

let root: string;
let assets: string;
let target: string;

function write(path: string, body: string) {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, body);
}

function sums(files: Record<string, string>): string {
    return Object.entries(files)
        .map(([path, body]) => `${createHash("sha256").update(body).digest("hex")}  ${path}`)
        .join("\n") + "\n";
}

/** Every file under `dir` with its size, sorted: the "byte-identical listing" of the ticket. */
function listing(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, {recursive: true, withFileTypes: true})
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const path = join(entry.parentPath, entry.name);
            return `${relative(dir, path)} ${statSync(path).size}`;
        })
        .sort();
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sync-arcade-"));
    assets = join(root, ASSET_REPO_NAME);
    for (const [path, body] of Object.entries(FILES)) write(join(assets, path), body);
    write(join(assets, "SHA256SUMS"), sums(FILES));
    write(join(assets, ".git/HEAD"), "ref: refs/heads/main\n");
    write(join(assets, ".git/refs/heads/main"), `${"a".repeat(40)}\n`);
    write(join(assets, "arcade/.git/config"), "nested");
    write(join(assets, "previews/guardian-fit/x.png"), "preview");
    write(join(assets, "arcade/previews/y.png"), "preview");
    target = join(root, "web/public/arcade");
});

afterEach(() => rmSync(root, {recursive: true, force: true}));

describe("syncArcadeAssets", () => {
    test("(a) copies exactly the arcade/ files, nothing from .git or previews", () => {
        const result = syncArcadeAssets([assets], target);
        expect(result.code).toBe(0);
        expect(listing(target)).toEqual(["guardians/a/b.png 4", "lobby-scene.webp 5", "wardrobe/fit.json 12"]);
        expect(result.lines.join("\n")).toContain("copied 3 files");
        expect(result.lines.join("\n")).toContain("a".repeat(40));
    });

    test("(b) a tampered file exits non-zero, names it, and copies nothing", () => {
        write(join(assets, "arcade/wardrobe/fit.json"), '{"fit":false}');
        const result = syncArcadeAssets([assets], target);
        expect(result.code).not.toBe(0);
        expect(result.lines.join("\n")).toContain("digest mismatch: arcade/wardrobe/fit.json");
        expect(existsSync(target)).toBe(false);
    });

    test("(c) a missing listed file exits non-zero, names it, and copies nothing", () => {
        rmSync(join(assets, "arcade/lobby-scene.webp"));
        const result = syncArcadeAssets([assets], target);
        expect(result.code).not.toBe(0);
        expect(result.lines.join("\n")).toContain("missing: arcade/lobby-scene.webp");
        expect(existsSync(target)).toBe(false);
    });

    test("(d) with no asset directory the exit is non-zero and every tried path is named", () => {
        const tried = [join(root, "nope-env"), join(root, "nope-common"), join(root, "nope-root")];
        const result = syncArcadeAssets(tried, target);
        expect(result.code).not.toBe(0);
        const out = result.lines.join("\n");
        for (const path of tried) expect(out).toContain(path);
        expect(out).toContain("git clone https://github.com/kooroot/Mapae-arcade-asset.git");
    });

    test("(e) $MAPAE_ARCADE_ASSET_DIR is tried before the sibling lookups", () => {
        const other = join(root, "elsewhere");
        write(join(other, "arcade/only-here.webp"), "env");
        write(join(other, "SHA256SUMS"), sums({"arcade/only-here.webp": "env"}));
        const worktree = join(root, "Mapae/.claude/worktrees/t-X");
        const candidates = candidatePaths({env: other, gitCommonDir: join(root, "Mapae/.git"), repoRoot: worktree});
        expect(candidates).toEqual([other, join(root, ASSET_REPO_NAME), join(root, "Mapae/.claude/worktrees", ASSET_REPO_NAME)]);
        expect(syncArcadeAssets(candidates, target).code).toBe(0);
        expect(listing(target)).toEqual(["only-here.webp 3"]);
    });

    test("(e') without the variable a linked worktree finds the repo beside the main checkout", () => {
        const worktree = join(root, "Mapae/.claude/worktrees/t-X");
        const candidates = candidatePaths({env: undefined, gitCommonDir: "../../../.git", repoRoot: worktree});
        expect(candidates[0]).toBe(assets);
        expect(syncArcadeAssets(candidates, target).code).toBe(0);
    });

    test("(f) a second run over the same target is idempotent", () => {
        expect(syncArcadeAssets([assets], target).code).toBe(0);
        const first = listing(target);
        expect(syncArcadeAssets([assets], target).code).toBe(0);
        expect(listing(target)).toEqual(first);
    });
});
