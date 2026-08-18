/**
 * Hold the MCP server to the stdio transport.
 *
 * `apps/agent-mcp` speaks stdio and starts no HTTP server. That is a design property, not
 * an accident: the streamable-HTTP transport in `@modelcontextprotocol/sdk` drags in a
 * Node HTTP adapter and, with it, a listening socket in a process that is otherwise
 * driven entirely over a pipe by its parent. Nothing in the code says so out loud, and an
 * `import` is one line.
 *
 * This gate lived inside `scripts/check-advisories.ts` until 2026-08-18, as the proof
 * attached to an accepted `@hono/node-server` advisory. That advisory was later revised
 * upstream — the fix turned out to have been backported to 1.19.15, which the lockfile
 * already had — so the acceptance was deleted. The measurement outlived its occasion: it
 * is worth keeping whether or not the adapter currently has a CVE, because the next one
 * will arrive against a tree nobody re-measured in between.
 *
 * The instrument is measured before it is trusted. A detector that always returned zero —
 * a renamed package, a bundler that minifies the string away, a silently failing build —
 * would pass while proving nothing, which is a fail-open in a check whose entire output is
 * an absence. So the control runs first and must find what the real entry point must not:
 * `apps/agent-mcp/http-transport-control.ts` imports the HTTP transport on purpose.
 * Measured at the time of writing, 3 references for the control and 0 across the real
 * entry point's 974 modules.
 */
import {basename, dirname} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Count references to the HTTP adapter in an entry point's transitive closure.
 * Returns null when the bundle could not be built — imports that cannot be read support
 * no claim either way.
 */
export async function countAdapterReferences(entrypoint: string): Promise<number | null> {
    // Bundled from the directory that owns the entry point rather than from wherever this
    // script was invoked. `@mapae/*` and the MCP SDK resolve through each package's own
    // node_modules, and the in-process `Bun.build` takes its resolution root from the
    // caller: the identical call succeeded under `bun run` from the repo root and failed
    // under `bun test` with "Could not resolve: @mapae/shared". A detector whose answer
    // depends on who is asking is worthless here, because the answer it gives when it
    // cannot resolve is indistinguishable from "not imported" unless null is handled — and
    // that is the fail-open this whole file exists to prevent. Spawning with an explicit
    // cwd removes the question; ~100 ms is a fair price.
    try {
        const proc = Bun.spawn(["bun", "build", `./${basename(entrypoint)}`, "--target=node"], {
            cwd: dirname(entrypoint),
            stdout: "pipe",
            stderr: "ignore",
        });
        const bundle = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return null;
        return (bundle.match(/hono/gi) ?? []).length;
    } catch {
        // A missing directory makes the spawn itself throw, which must read the same as a
        // failed build: unknown, never zero.
        return null;
    }
}

/** Returns null while the invariant holds, or a sentence saying how it broke. */
export function judgeStdioOnly(control: number | null, actual: number | null): string | null {
    if (control === null) {
        return "the control bundle could not be built, so a zero from apps/agent-mcp proves nothing";
    }
    if (control === 0) {
        return (
            "apps/agent-mcp/http-transport-control.ts imports the HTTP transport, yet no reference " +
            "to @hono/node-server appears in its bundle — the detector is broken, not the tree clean"
        );
    }
    if (actual === null) {
        return "apps/agent-mcp/index.ts could not be bundled, so its imports cannot be read";
    }
    if (actual === 0) return null;
    return (
        `apps/agent-mcp/index.ts now reaches the HTTP adapter (${actual} references in its ` +
        "bundle) — the MCP server is no longer stdio-only. If that is intended, this gate is " +
        "the wrong shape and should be replaced rather than relaxed"
    );
}

async function main(): Promise<void> {
    const control = await countAdapterReferences(`${REPO}/apps/agent-mcp/http-transport-control.ts`);
    const actual = await countAdapterReferences(`${REPO}/apps/agent-mcp/index.ts`);
    const broke = judgeStdioOnly(control, actual);

    if (broke) {
        console.error(`[mcp-stdio] ${broke}`);
        process.exit(1);
    }

    console.log(
        `[mcp-stdio] the MCP server reaches no HTTP adapter (control ${control}, entry point 0)`,
    );
}

if (import.meta.main) await main();
