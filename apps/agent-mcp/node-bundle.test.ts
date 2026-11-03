import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {privateKeyToAccount} from "viem/accounts";

/**
 * The server as the Claude Desktop extension will run it: one bundled file under `node`.
 *
 * `smoke.test.ts` spawns `index.ts` under Bun, which hides two things a Node host does
 * not give for free — the `Bun.*` globals and Bun's automatic `.env` load. Here the
 * bundle is built the way the extension will ship it and driven over stdio by hand, so
 * every byte on stdout is seen: a stray log line would corrupt a real client's stream.
 *
 * No network: the RPC and the facilitator are local fakes on loopback.
 */
const HERE = new URL(".", import.meta.url).pathname;
const REPO = join(HERE, "../..");
const FIXTURE_KEY = `0x${"11".repeat(32)}` as const;
const FRAMEWORK_ADMIN = "0x00A7b901abb908ecafEC72973906424c4fDdc100";
/**
 * `encodeDelegations` of one root link, delegate = FIXTURE_KEY's address, no caveats,
 * salt 1, empty signature. Pre-encoded so this test needs no dependency agent-mcp lacks;
 * the bundle decodes it with the smart-accounts kit, which is part of what is proven.
 */
const PERMISSION_CONTEXT =
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000002000000000000000000000000000000000000002ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const FACILITATOR_SIGNER = "0x3000000000000000000000000000000000000003";

let outDir: string;
let rpcServer: ReturnType<typeof Bun.serve>;
let facilitator: ReturnType<typeof Bun.serve>;
const rpcMethods: string[] = [];

async function bundle(entry: string, outfile: string): Promise<void> {
    const proc = Bun.spawn(["bun", "build", entry, "--target=node", "--outfile", outfile], {
        cwd: HERE,
        stdout: "ignore",
        stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`bundle ${entry} failed: ${stderr}`);
}

function rpcAnswer(call: {id: unknown; method: string}): unknown {
    rpcMethods.push(call.method);
    const result: Record<string, string> = {
        eth_chainId: "0x164ce", // 91342, GIWA Sepolia
        eth_blockNumber: "0x2000000",
        // Deliberately not the Framework's bytecode: the shipped verifier must refuse it.
        eth_getCode: "0x6000",
    };
    if (call.method in result) return {jsonrpc: "2.0", id: call.id, result: result[call.method]};
    return {jsonrpc: "2.0", id: call.id, error: {code: -32601, message: "fake rpc: unsupported"}};
}

beforeAll(async () => {
    outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mapae-node-bundle-"));
    rpcServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const body = (await request.json()) as {id: unknown; method: string} | {id: unknown; method: string}[];
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
    await Promise.all([
        bundle("./index.ts", join(outDir, "mapae-agent-mcp.js")),
        bundle("./node-bootstrap-harness.ts", join(outDir, "harness.js")),
    ]);
}, 60_000);

afterAll(() => {
    rpcServer?.stop(true);
    facilitator?.stop(true);
    if (outDir) rmSync(outDir, {recursive: true, force: true});
});

/** Drive one node process over stdio; returns each response plus every stdout line. */
async function session(
    file: string,
    env: Record<string, string>,
    calls: {method: string; params?: unknown}[],
): Promise<{responses: Record<string, unknown>[]; stdoutLines: string[]; alive: boolean}> {
    const proc = Bun.spawn(["node", join(outDir, file)], {
        env: {PATH: process.env.PATH ?? "", ...env},
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
    });
    const lines: string[] = [];
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    async function nextLine(): Promise<string> {
        for (;;) {
            const cut = buffered.indexOf("\n");
            if (cut >= 0) {
                const line = buffered.slice(0, cut);
                buffered = buffered.slice(cut + 1);
                lines.push(line);
                return line;
            }
            const {value, done} = await reader.read();
            if (done) throw new Error(`stdout closed; saw ${JSON.stringify(lines)}`);
            buffered += decoder.decode(value, {stream: true});
        }
    }
    const send = (message: unknown) => {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.flush();
    };

    const responses: Record<string, unknown>[] = [];
    send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "node-bundle", version: "0"}},
    });
    responses.push(JSON.parse(await nextLine()));
    send({jsonrpc: "2.0", method: "notifications/initialized"});
    for (const [index, call] of calls.entries()) {
        send({jsonrpc: "2.0", id: index + 1, ...call});
        responses.push(JSON.parse(await nextLine()));
    }
    const alive = proc.exitCode === null && !proc.killed;
    proc.stdin.end();
    proc.kill();
    await proc.exited;
    reader.releaseLock();
    return {responses, stdoutLines: lines, alive};
}

function toolBody(response: Record<string, unknown>): Record<string, unknown> {
    const result = response.result as {content: {type: string; text: string}[]};
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function fixtureEnv(): Record<string, string> {
    return {
        AGENT_PRIVATE_KEY: FIXTURE_KEY,
        PARENT_PERMISSION_CONTEXT: PERMISSION_CONTEXT,
        // Points nowhere: the inline value must win without the file being read.
        PARENT_PERMISSION_CONTEXT_PATH: join(outDir, "absent.permission.json"),
        GIWA_SEPOLIA_RPC_URL: rpcServer.url.toString(),
        FACILITATOR_URL: facilitator.url.toString(),
        SELLER_URL: "http://127.0.0.1:9",
        FRAMEWORK_ADMIN_ADDRESS: FRAMEWORK_ADMIN,
        DELEGATION_DEPLOYMENT_PATH: join(REPO, "deployments/giwa-sepolia.framework.json"),
        DELEGATION_MANIFEST_PATH: join(REPO, "deployments/giwa-sepolia.framework-manifest.json"),
    };
}

const STATUS = {method: "tools/call", params: {name: "mapae_status", arguments: {}}};

describe("the Node bundle", () => {
    test("contains no Bun API", async () => {
        const text = await Bun.file(join(outDir, "mapae-agent-mcp.js")).text();
        expect(text.match(/Bun\./g) ?? []).toHaveLength(0);
    });

    test("answers initialize and lists both tools under node", async () => {
        const {responses} = await session("mapae-agent-mcp.js", {}, [{method: "tools/list"}]);
        expect((responses[0]!.result as {serverInfo: {name: string}}).serverInfo.name).toBe("mapae-agent");
        const names = (responses[1]!.result as {tools: {name: string}[]}).tools.map((tool) => tool.name);
        expect(names).toContain("mapae_pay_for_resource");
        expect(names).toContain("mapae_status");
    }, 30_000);

    test("an empty env reports RUNTIME_UNAVAILABLE, stays up, and writes only JSON-RPC", async () => {
        const {responses, stdoutLines, alive} = await session("mapae-agent-mcp.js", {}, [STATUS, STATUS]);
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

    test("with a fixture key and inline permission, the shipped bootstrap reaches the chain", async () => {
        // Everything before the Framework check — key, inline permission, deployment files,
        // facilitator, viem's HTTP client — runs under node; the fake chain's bytecode is
        // then refused, which is the audited check doing its job, not a Node failure.
        rpcMethods.length = 0;
        const {responses} = await session("mapae-agent-mcp.js", fixtureEnv(), [STATUS]);
        const body = toolBody(responses[1]!);
        expect(body.code).toBe("RUNTIME_UNAVAILABLE");
        expect(String(body.detail)).toContain("runtime code does not match the pinned composition");
        expect(rpcMethods).toContain("eth_getCode");
    }, 30_000);

    test("with the bytecode check stood in, the runtime bootstraps and reports the fixture's address", async () => {
        rpcMethods.length = 0;
        const {responses, stdoutLines} = await session("harness.js", fixtureEnv(), [STATUS]);
        const body = toolBody(responses[1]!);
        expect(body.code).toBeUndefined();
        expect(body.ok).toBe(true);
        expect(body.sessionKey).toBe(privateKeyToAccount(FIXTURE_KEY).address);
        expect(body.trustedFacilitators).toEqual([FACILITATOR_SIGNER]);
        expect(rpcMethods).toContain("eth_chainId");
        // The bearer permission never leaves in a tool result.
        expect(stdoutLines.join("\n")).not.toContain(fixtureEnv().PARENT_PERMISSION_CONTEXT!);
    }, 30_000);
});
