import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
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
 * No network and no socket: `fixtures/fake-chain-preload.mjs` (`node --import`) answers
 * the RPC and the facilitator inside the server's process. The fake RPC replays
 * `fixtures/framework-chain.rpc.json` — the answers a local replay of the GIWA Framework
 * deployment gave the shipped bundle (`fixtures/record-framework-chain.ts`) — so the
 * audited bytecode verifier runs unmodified and passes.
 */
const HERE = new URL(".", import.meta.url).pathname;
const PRELOAD = join(HERE, "fixtures/fake-chain-preload.mjs");
// Same values as FAKE_RPC_URL / FAKE_FACILITATOR_URL in the preload: closed loopback ports.
const URLS = {GIWA_SEPOLIA_RPC_URL: "http://127.0.0.1:1/", FACILITATOR_URL: "http://127.0.0.1:2/"};

let outDir: string;
const BUNDLE = () => join(outDir, "mapae-agent-mcp.js");
const LOG = () => join(outDir, "rpc.jsonl");

/** A full boot under node with the fake chain preloaded; returns the status body and the RPC log. */
async function bootWithFakeChain(codeOverride?: string) {
    rmSync(LOG(), {force: true});
    const env: Record<string, string> = {
        ...fixtureEnv(URLS),
        FAKE_CHAIN_RECORDING: join(HERE, "fixtures/framework-chain.rpc.json"),
        FAKE_CHAIN_LOG: LOG(),
        FAKE_FACILITATOR_SIGNER: FACILITATOR_SIGNER,
    };
    if (codeOverride) env.FAKE_CHAIN_CODE_OVERRIDE = codeOverride;
    const session = await nodeSession(BUNDLE(), env, [STATUS], ["--import", PRELOAD]);
    const calls = existsSync(LOG())
        ? readFileSync(LOG(), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as {method: string; key: string; miss: boolean})
        : [];
    return {...session, body: toolBody(session.responses[1]!), calls};
}

beforeAll(async () => {
    outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mapae-node-bundle-"));
    const proc = Bun.spawn(["bun", "build", "./index.ts", "--target=node", "--outfile", BUNDLE()], {
        cwd: HERE,
        stdout: "ignore",
        stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`bundle failed: ${stderr}`);
}, 60_000);

afterAll(() => {
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
        const {body, calls, stdoutLines, alive} = await bootWithFakeChain();
        expect(body.code).toBeUndefined();
        expect(body.ok).toBe(true);
        expect(body.sessionKey).toBe(privateKeyToAccount(FIXTURE_KEY).address);
        expect(body.trustedFacilitators).toEqual([FACILITATOR_SIGNER]);
        expect(alive).toBe(true);
        // The real verifier ran: it fetched the Framework's runtime code from the fake chain.
        expect(calls.map((call) => call.method)).toContain("eth_getCode");
        expect(calls.filter((call) => call.miss).map((call) => call.key)).toEqual([]);
        for (const line of stdoutLines) {
            expect((JSON.parse(line) as {jsonrpc?: string}).jsonrpc).toBe("2.0");
        }
        // The bearer permission never leaves in a tool result.
        expect(stdoutLines.join("\n")).not.toContain(PERMISSION_CONTEXT);
    }, 30_000);

    test("the same boot is refused when the chain's bytecode is not the pinned composition", async () => {
        // Control for the test above: the verifier is live, not skipped.
        const {body, calls} = await bootWithFakeChain("0x6000");
        expect(calls.map((call) => call.method)).toContain("eth_getCode");
        expect(body.code).toBe("RUNTIME_UNAVAILABLE");
        expect(String(body.detail)).toContain("runtime code does not match the pinned composition");
    }, 30_000);
});
