/**
 * `bun run build:mcpb`: pack `apps/agent-mcp` as a Claude Desktop extension.
 *
 * Offline by construction — no `bunx`, no registry fetch. The server is the single-file
 * Node bundle ENG-4 proved (`bun build ./index.ts --target=node --outfile`, the same
 * invocation `scripts/check-mcp-stdio.ts` counts), staged beside the two deployment
 * artifacts the runtime reads at boot and this directory's `manifest.json`, then zipped
 * with the system `zip` (a `.mcpb` is a zip). The official validator is an Operator step
 * (`docs/holdco/engineering/ENG-5.md`), not a dependency of this script.
 */
import {copyFileSync, mkdirSync, rmSync, statSync} from "node:fs";
import {dirname, join, resolve} from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
export const AGENT_MCP = join(HERE, "..");
const REPO = join(AGENT_MCP, "../..");
export const DIST = join(HERE, "dist");
export const STAGE = join(DIST, "mapae");
export const ARCHIVE = join(DIST, "mapae.mcpb");

/** Every file the archive holds, relative to its root. Nothing else is staged. */
export const ARCHIVE_FILES = [
    "manifest.json",
    "server/index.js",
    "deployments/giwa-sepolia.framework.json",
    "deployments/giwa-sepolia.framework-manifest.json",
] as const;

/** The Node bundle build, run with cwd `apps/agent-mcp`; identical to check-mcp-stdio's. */
export function nodeBuildCommand(outfile: string): string[] {
    return ["bun", "build", "./index.ts", "--target=node", "--outfile", outfile];
}

async function run(argv: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(argv, {cwd, stdout: "ignore", stderr: "pipe"});
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed: ${stderr}`);
}

/** Build, stage and zip; returns the staging directory and the archive path. */
export async function pack(): Promise<{stage: string; archive: string; bytes: number}> {
    rmSync(DIST, {recursive: true, force: true});
    mkdirSync(join(STAGE, "server"), {recursive: true});
    mkdirSync(join(STAGE, "deployments"), {recursive: true});
    await run(nodeBuildCommand(join(STAGE, "server/index.js")), AGENT_MCP);
    copyFileSync(join(HERE, "manifest.json"), join(STAGE, "manifest.json"));
    for (const file of ARCHIVE_FILES.filter((path) => path.startsWith("deployments/"))) {
        copyFileSync(join(REPO, file), join(STAGE, file));
    }
    // -X: no extra file attributes; -D: no directory entries, so the listing is the files.
    await run(["zip", "-q", "-X", "-D", ARCHIVE, ...ARCHIVE_FILES], STAGE);
    return {stage: STAGE, archive: ARCHIVE, bytes: statSync(ARCHIVE).size};
}

if (import.meta.main) {
    const {archive, bytes} = await pack();
    console.log(`[mcpb] ${archive} (${bytes} bytes)`);
    const flag = process.argv.indexOf("--copy-to");
    if (flag !== -1) {
        const target = process.argv[flag + 1];
        if (!target) throw new Error("--copy-to needs a path");
        const copy = resolve(process.cwd(), target);
        mkdirSync(dirname(copy), {recursive: true});
        copyFileSync(archive, copy);
        console.log(`[mcpb] copied to ${copy}`);
    }
}
