import {beforeAll, describe, expect, test} from "bun:test";
import {cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {privateKeyToAccount} from "viem/accounts";
import {
    FACILITATOR_SIGNER,
    FIXTURE_KEY,
    PERMISSION_CONTEXT,
    STATUS,
    nodeSession,
    toolBody,
} from "../fixtures/framework-chain.js";
import {AGENT_MCP, ARCHIVE_FILES, nodeBuildCommand, pack} from "./pack.js";

/**
 * The extension as Claude Desktop will start it. `node-bundle.test.ts` proves the bundle;
 * this proves the wiring around it: the archive's contents, and a boot whose command, args
 * and env come from the staged `manifest.json` — `${__dirname}` resolved to the staging
 * directory, `${user_config.*}` filled as Desktop fills them (a paste, or the field's
 * default). Only GIWA_SEPOLIA_RPC_URL and FACILITATOR_URL are replaced, by the closed
 * loopback origins `fixtures/fake-chain-preload.mjs` answers in-process; no socket opens.
 */
const REPO = join(AGENT_MCP, "../..");
const PRELOAD = join(AGENT_MCP, "fixtures/fake-chain-preload.mjs");
const SELLER_PRELOAD = join(AGENT_MCP, "mcpb/fake-seller-preload.mjs");
const FAKE_URLS = {GIWA_SEPOLIA_RPC_URL: "http://127.0.0.1:1/", FACILITATOR_URL: "http://127.0.0.1:2/"};

type UserConfigField = {type: string; sensitive?: boolean; required?: boolean; default?: string};
type Manifest = {
    manifest_version: string;
    name: string;
    server: {type: string; entry_point: string; mcp_config: {command: string; args: string[]; env: Record<string, string>}};
    user_config: Record<string, UserConfigField>;
    tools: {name: string}[];
    compatibility: {runtimes: {node: string}};
};

let stage: string;
let archive: string;
let manifest: Manifest;
let scratch: string;

/** Desktop's substitution: `${__dirname}` and `${user_config.<field>}` (a paste, else the default). */
function resolve(value: string, dirname: string, pasted: Record<string, string>): string {
    return value
        .replaceAll("${__dirname}", dirname)
        .replace(/\$\{user_config\.([a-z_]+)\}/g, (_, field: string) => pasted[field] ?? manifest.user_config[field]?.default ?? "");
}

function launch(dirname: string, pasted: Record<string, string>) {
    const {command, args, env} = manifest.server.mcp_config;
    const resolved = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, resolve(value, dirname, pasted)]));
    return {command, args: args.map((arg) => resolve(arg, dirname, pasted)), env: resolved};
}

const PASTED = {agent_private_key: FIXTURE_KEY, permission_context: PERMISSION_CONTEXT};

/** Boot the staged server from the manifest under node, with the fake chain (and optionally seller) preloaded. */
async function boot(
    dirname: string,
    pasted: Record<string, string>,
    calls: {method: string; params?: unknown}[],
    extra: {sellerAmount?: string} = {},
) {
    const {command, args, env} = launch(dirname, pasted);
    expect(command).toBe("node");
    const sellerLog = join(scratch, `seller-${Math.random().toString(36).slice(2)}.jsonl`);
    const nodeArgs = ["--import", PRELOAD];
    const harness: Record<string, string> = {
        FAKE_CHAIN_RECORDING: join(AGENT_MCP, "fixtures/framework-chain.rpc.json"),
        FAKE_FACILITATOR_SIGNER: FACILITATOR_SIGNER,
    };
    if (extra.sellerAmount) {
        nodeArgs.push("--import", SELLER_PRELOAD);
        Object.assign(harness, {FAKE_SELLER_AMOUNT: extra.sellerAmount, FAKE_SELLER_LOG: sellerLog});
    }
    const session = await nodeSession(args[0]!, {...env, ...FAKE_URLS, ...harness}, calls, nodeArgs);
    const sellerCalls = existsSync(sellerLog)
        ? readFileSync(sellerLog, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as {url: string; signed: boolean})
        : [];
    return {...session, env, sellerCalls};
}

function stagedFiles(dir: string): string[] {
    return readdirSync(dir, {recursive: true})
        .map(String)
        .filter((path) => statSync(join(dir, path)).isFile())
        .sort();
}

beforeAll(async () => {
    ({stage, archive} = await pack());
    manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as Manifest;
    scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mapae-mcpb-"));
}, 60_000);

describe("the packed extension", () => {
    test("the manifest declares the node server, hosted defaults and four user_config fields", () => {
        expect(manifest.manifest_version).toBe("0.3");
        expect(manifest.name).toBe("mapae");
        expect(manifest.server.type).toBe("node");
        expect(manifest.server.entry_point).toBe("server/index.js");
        expect(manifest.server.mcp_config.command).toBe("node");
        expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/index.js"]);
        expect(manifest.server.mcp_config.env).toEqual({
            SELLER_URL: "https://seller.mapae.io",
            FACILITATOR_URL: "https://facilitator.mapae.io",
            GIWA_SEPOLIA_RPC_URL: "https://sepolia-rpc.giwa.io",
            FRAMEWORK_ADMIN_ADDRESS: "0x00A7b901abb908ecafEC72973906424c4fDdc100",
            DELEGATION_DEPLOYMENT_PATH: "${__dirname}/deployments/giwa-sepolia.framework.json",
            DELEGATION_MANIFEST_PATH: "${__dirname}/deployments/giwa-sepolia.framework-manifest.json",
            AGENT_PRIVATE_KEY: "${user_config.agent_private_key}",
            PARENT_PERMISSION_CONTEXT: "${user_config.permission_context}",
            AGENT_MAX_PAYMENT_MUSDC: "${user_config.max_payment_musdc}",
            AGENT_SESSION_BUDGET_MUSDC: "${user_config.session_budget_musdc}",
        });
        const fields = manifest.user_config;
        expect(Object.keys(fields).sort()).toEqual(
            ["agent_private_key", "max_payment_musdc", "permission_context", "session_budget_musdc"],
        );
        for (const name of ["agent_private_key", "permission_context"]) {
            expect(fields[name]!.sensitive).toBe(true);
            expect(fields[name]!.required).toBe(true);
            expect(fields[name]!.default).toBeUndefined();
        }
        expect(fields.max_payment_musdc!.required).toBe(false);
        expect(fields.max_payment_musdc!.default).toBe("2.50");
        expect(fields.session_budget_musdc!.required).toBe(false);
        expect(fields.session_budget_musdc!.default).toBe("10.00");
        expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(["mapae_pay_for_resource", "mapae_status"]);
        expect(manifest.compatibility.runtimes.node).toBe(">=20.0.0");
    });

    test("the archive and the staging directory hold exactly the four runtime files", async () => {
        const proc = Bun.spawn(["unzip", "-Z1", archive], {stdout: "pipe", stderr: "ignore"});
        const listed = (await new Response(proc.stdout).text()).trim().split("\n").sort();
        expect(await proc.exited).toBe(0);
        expect(listed).toEqual([...ARCHIVE_FILES].sort());
        expect(stagedFiles(stage)).toEqual([...ARCHIVE_FILES].sort());
        for (const file of ARCHIVE_FILES.filter((path) => path.startsWith("deployments/"))) {
            expect(readFileSync(join(stage, file), "utf8")).toBe(readFileSync(join(REPO, file), "utf8"));
        }
    });

    test("the server is check-mcp-stdio's Node bundle: no Bun API, no hono", () => {
        expect(nodeBuildCommand("OUT")).toEqual(["bun", "build", "./index.ts", "--target=node", "--outfile", "OUT"]);
        const check = readFileSync(join(REPO, "scripts/check-mcp-stdio.ts"), "utf8");
        expect(check).toContain('["bun", "build", `./${basename(entrypoint)}`, "--target=node", "--outfile", outfile]');
        const bundle = readFileSync(join(stage, "server/index.js"), "utf8");
        expect(bundle.match(/Bun\./g) ?? []).toHaveLength(0);
        expect(bundle.match(/hono/gi) ?? []).toHaveLength(0);
    });

    test("no key or permission is shipped", () => {
        const text = JSON.stringify(manifest);
        expect(text).not.toMatch(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/);
        for (const file of ARCHIVE_FILES) {
            const content = readFileSync(join(stage, file), "utf8").toLowerCase();
            expect(content).not.toContain(FIXTURE_KEY.slice(2));
            expect(content).not.toContain(PERMISSION_CONTEXT.slice(2, 130).toLowerCase());
        }
    });

    test("booted from the manifest with the pasted fixture identity, mapae_status is ok", async () => {
        const {responses, stdoutLines, alive, env} = await boot(stage, PASTED, [{method: "tools/list"}, STATUS]);
        const names = (responses[1]!.result as {tools: {name: string}[]}).tools.map((tool) => tool.name);
        expect(names).toContain("mapae_pay_for_resource");
        expect(names).toContain("mapae_status");
        const body = toolBody(responses[2]!);
        expect(body.code).toBeUndefined();
        expect(body.ok).toBe(true);
        expect(body.sessionKey).toBe(privateKeyToAccount(FIXTURE_KEY).address);
        expect(alive).toBe(true);
        for (const line of stdoutLines) expect((JSON.parse(line) as {jsonrpc?: string}).jsonrpc).toBe("2.0");
        expect(stdoutLines.join("\n")).not.toContain(PERMISSION_CONTEXT);
        // The deployment artifacts come from the extension's own directory.
        expect(env.DELEGATION_DEPLOYMENT_PATH).toBe(join(stage, "deployments/giwa-sepolia.framework.json"));
        expect(env.DELEGATION_MANIFEST_PATH).toBe(join(stage, "deployments/giwa-sepolia.framework-manifest.json"));
    }, 30_000);

    test("control: a staged copy without its deployment file cannot boot, so the staged file is the one read", async () => {
        const copy = join(scratch, "stage-copy");
        cpSync(stage, copy, {recursive: true});
        rmSync(join(copy, "deployments/giwa-sepolia.framework.json"));
        const {responses, alive} = await boot(copy, PASTED, [STATUS]);
        const body = toolBody(responses[1]!);
        expect(body.ok).toBe(false);
        expect(body.code).toBe("RUNTIME_UNAVAILABLE");
        expect(String(body.detail)).toContain(copy);
        expect(alive).toBe(true);
    }, 30_000);

    test("with the user_config fields left empty, the extension stays up and reports RUNTIME_UNAVAILABLE", async () => {
        const empty = {agent_private_key: "", permission_context: "", max_payment_musdc: "", session_budget_musdc: ""};
        const {responses, alive, stdoutLines} = await boot(stage, empty, [STATUS, STATUS]);
        for (const response of responses.slice(1)) {
            const body = toolBody(response);
            expect(body.ok).toBe(false);
            expect(body.code).toBe("RUNTIME_UNAVAILABLE");
        }
        expect(alive).toBe(true);
        for (const line of stdoutLines) expect((JSON.parse(line) as {jsonrpc?: string}).jsonrpc).toBe("2.0");
    }, 30_000);

    test("the default per-payment cap reaches the spend gate: a 2.500001 mUSDC offer is refused before signing", async () => {
        const pay = {method: "tools/call", params: {name: "mapae_pay_for_resource", arguments: {resource: "/s/demo-cafe/americano"}}};
        const {responses, alive, env, sellerCalls} = await boot(stage, PASTED, [pay], {sellerAmount: "2500001"});
        expect(env.AGENT_MAX_PAYMENT_MUSDC).toBe("2.50");
        expect(env.AGENT_SESSION_BUDGET_MUSDC).toBe("10.00");
        const body = toolBody(responses[1]!);
        expect(body.ok).toBe(false);
        expect(body.code).toBe("SPEND_POLICY_REFUSED");
        expect(String(body.detail)).toContain("AGENT_MAX_PAYMENT_MUSDC");
        expect(sellerCalls.length).toBe(1);
        expect(sellerCalls.every((call) => !call.signed)).toBe(true);
        expect(alive).toBe(true);
    }, 30_000);
});
