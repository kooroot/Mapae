/**
 * Shared by `node-bundle.test.ts` and `record-framework-chain.ts`: the fixture identity,
 * the env the shipped bundle boots with, and one stdio session against a `node` process.
 * Runs under Bun (the test runner and the recorder); only the server under test is `node`.
 */
import {join} from "node:path";

const REPO = join(new URL(".", import.meta.url).pathname, "../../..");

export const FIXTURE_KEY = `0x${"11".repeat(32)}` as const;
export const FRAMEWORK_ADMIN = "0x00A7b901abb908ecafEC72973906424c4fDdc100";
export const FACILITATOR_SIGNER = "0x3000000000000000000000000000000000000003";
/**
 * `encodeDelegations` of one root link, delegate = FIXTURE_KEY's address, no caveats,
 * salt 1, empty signature. Pre-encoded so this needs no dependency agent-mcp lacks;
 * the bundle decodes it with the smart-accounts kit, which is part of what is proven.
 */
export const PERMISSION_CONTEXT =
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000002000000000000000000000000000000000000002ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

/** The recorded fixture's key for one JSON-RPC call; the fake RPC answers by it. */
export function rpcKey(method: string, params: unknown[] | undefined): string {
    return `${method} ${JSON.stringify(params ?? [])}`;
}

/** Env for a full boot: fixture key, inline permission, local RPC and facilitator. */
export function fixtureEnv(urls: {GIWA_SEPOLIA_RPC_URL: string; FACILITATOR_URL: string}): Record<string, string> {
    return {
        AGENT_PRIVATE_KEY: FIXTURE_KEY,
        PARENT_PERMISSION_CONTEXT: PERMISSION_CONTEXT,
        // Points nowhere: the inline value must win without the file being read.
        PARENT_PERMISSION_CONTEXT_PATH: join(REPO, "absent.permission.json"),
        SELLER_URL: "http://127.0.0.1:9",
        FRAMEWORK_ADMIN_ADDRESS: FRAMEWORK_ADMIN,
        DELEGATION_DEPLOYMENT_PATH: join(REPO, "deployments/giwa-sepolia.framework.json"),
        DELEGATION_MANIFEST_PATH: join(REPO, "deployments/giwa-sepolia.framework-manifest.json"),
        ...urls,
    };
}

/** Drive one node process over stdio; returns each response plus every stdout line. */
export async function nodeSession(
    file: string,
    env: Record<string, string>,
    calls: {method: string; params?: unknown}[],
    nodeArgs: string[] = [],
): Promise<{responses: Record<string, unknown>[]; stdoutLines: string[]; alive: boolean}> {
    const proc = Bun.spawn(["node", ...nodeArgs, file], {
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

export const STATUS = {method: "tools/call", params: {name: "mapae_status", arguments: {}}};

export function toolBody(response: Record<string, unknown>): Record<string, unknown> {
    const result = response.result as {content: {type: string; text: string}[]};
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** `mapae_status` from the bundle at `file`, booted with the fixture env. */
export async function statusFromNode(
    file: string,
    urls: {GIWA_SEPOLIA_RPC_URL: string; FACILITATOR_URL: string},
    nodeArgs: string[] = [],
): Promise<Record<string, unknown>> {
    const {responses} = await nodeSession(file, fixtureEnv(urls), [STATUS], nodeArgs);
    return toolBody(responses[1]!);
}
