import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {privateKeyToAccount} from "viem/accounts";
import {
    FACILITATOR_SIGNER,
    FIXTURE_KEY,
    PERMISSION_CONTEXT,
    STATUS,
    fixtureEnv,
    nodeSession,
    rpcKey,
    toolBody,
} from "./fixtures/framework-chain.js";

/**
 * The server as the Claude Desktop extension will run it: one bundled file under `node`.
 *
 * `smoke.test.ts` spawns `index.ts` under Bun, which hides two things a Node host does
 * not give for free — the `Bun.*` globals and Bun's automatic `.env` load. Here the
 * bundle is built the way the extension will ship it and driven over stdio by hand, so
 * every byte on stdout is seen: a stray log line would corrupt a real client's stream.
 *
 * No network: the RPC and the facilitator are local fakes on loopback. The fake RPC
 * replays `fixtures/framework-chain.rpc.json` — the answers a local replay of the GIWA
 * Framework deployment gave the shipped bundle (`fixtures/record-framework-chain.ts`) —
 * so the audited bytecode verifier runs unmodified and passes.
 */
const HERE = new URL(".", import.meta.url).pathname;
const RECORDING = JSON.parse(readFileSync(join(HERE, "fixtures/framework-chain.rpc.json"), "utf8")) as Record<
    string,
    unknown
>;

let outDir: string;
let rpcServer: ReturnType<typeof Bun.serve>;
let facilitator: ReturnType<typeof Bun.serve>;
const rpcMethods: string[] = [];
const rpcMisses: string[] = [];
/** When set, every eth_getCode answers this instead of the recording. */
let codeOverride: string | undefined;

const BUNDLE = () => join(outDir, "mapae-agent-mcp.js");

function rpcAnswer(call: {id: unknown; method: string; params?: unknown[]}): unknown {
    rpcMethods.push(call.method);
    if (codeOverride !== undefined && call.method === "eth_getCode") {
        return {jsonrpc: "2.0", id: call.id, result: codeOverride};
    }
    const key = rpcKey(call.method, call.params);
    if (key in RECORDING) return {jsonrpc: "2.0", id: call.id, result: RECORDING[key]};
    rpcMisses.push(key);
    return {jsonrpc: "2.0", id: call.id, error: {code: -32601, message: "fake rpc: not in the recording"}};
}

function urls(): {GIWA_SEPOLIA_RPC_URL: string; FACILITATOR_URL: string} {
    return {GIWA_SEPOLIA_RPC_URL: rpcServer.url.toString(), FACILITATOR_URL: facilitator.url.toString()};
}

beforeAll(async () => {
    outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mapae-node-bundle-"));
    rpcServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const body = (await request.json()) as
                | {id: unknown; method: string; params?: unknown[]}
                | {id: unknown; method: string; params?: unknown[]}[];
            return Response.json(Array.isArray(body) ? body.map(rpcAnswer) : rpcAnswer(body));
        },
    });
    facilitator = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            if (new URL(request.url).pathname !== "/supported") return new Response(null, {status: 404});
            return Response.json({signers: {"eip155:91342": [FACILITATOR_SIGNER]}});
        },
    });
    const proc = Bun.spawn(["bun", "build", "./index.ts", "--target=node", "--outfile", BUNDLE()], {
        cwd: HERE,
        stdout: "ignore",
        stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`bundle failed: ${stderr}`);
}, 60_000);

afterAll(() => {
    rpcServer?.stop(true);
    facilitator?.stop(true);
    if (outDir) rmSync(outDir, {recursive: true, force: true});
});

describe("the Node bundle", () => {
    test("contains no Bun API", () => {
        const text = readFileSync(BUNDLE(), "utf8");
        expect(text.match(/Bun\./g) ?? []).toHaveLength(0);
    });

    test("answers initialize and lists both tools under node", async () => {
        const {responses} = await nodeSession(BUNDLE(), {}, [{method: "tools/list"}]);
        expect((responses[0]!.result as {serverInfo: {name: string}}).serverInfo.name).toBe("mapae-agent");
        const names = (responses[1]!.result as {tools: {name: string}[]}).tools.map((tool) => tool.name);
        expect(names).toContain("mapae_pay_for_resource");
        expect(names).toContain("mapae_status");
    }, 30_000);

    test("an empty env reports RUNTIME_UNAVAILABLE, stays up, and writes only JSON-RPC", async () => {
        const {responses, stdoutLines, alive} = await nodeSession(BUNDLE(), {}, [STATUS, STATUS]);
        for (const response of responses.slice(1)) {
            const body = toolBody(response);
            expect(body.ok).toBe(false);
            expect(body.code).toBe("RUNTIME_UNAVAILABLE");
        }
        expect(alive).toBe(true);
        for (const line of stdoutLines) {
            expect((JSON.parse(line) as {jsonrpc?: string}).jsonrpc).toBe("2.0");
        }
    }, 30_000);

    test("with a fixture key and inline permission, the shipped bundle bootstraps and reports the fixture's address", async () => {
        rpcMethods.length = 0;
        rpcMisses.length = 0;
        codeOverride = undefined;
        const {responses, stdoutLines, alive} = await nodeSession(BUNDLE(), fixtureEnv(urls()), [STATUS]);
        const body = toolBody(responses[1]!);
        expect(body.code).toBeUndefined();
        expect(body.ok).toBe(true);
        expect(body.sessionKey).toBe(privateKeyToAccount(FIXTURE_KEY).address);
        expect(body.trustedFacilitators).toEqual([FACILITATOR_SIGNER]);
        expect(alive).toBe(true);
        // The real verifier ran: it fetched the Framework's runtime code from the fake chain.
        expect(rpcMethods).toContain("eth_getCode");
        expect(rpcMisses).toEqual([]);
        for (const line of stdoutLines) {
            expect((JSON.parse(line) as {jsonrpc?: string}).jsonrpc).toBe("2.0");
        }
        // The bearer permission never leaves in a tool result.
        expect(stdoutLines.join("\n")).not.toContain(PERMISSION_CONTEXT);
    }, 30_000);

    test("the same boot is refused when the chain's bytecode is not the pinned composition", async () => {
        // Control for the test above: the verifier is live, not skipped.
        codeOverride = "0x6000";
        try {
            const {responses} = await nodeSession(BUNDLE(), fixtureEnv(urls()), [STATUS]);
            const body = toolBody(responses[1]!);
            expect(body.code).toBe("RUNTIME_UNAVAILABLE");
            expect(String(body.detail)).toContain("runtime code does not match the pinned composition");
        } finally {
            codeOverride = undefined;
        }
    }, 30_000);
});
