/**
 * Regenerates `framework-chain.rpc.json`: the JSON-RPC answers the shipped server needs to
 * pass the audited Framework verifier, recorded from a local replay of the GIWA deployment.
 *
 *     bun apps/agent-mcp/fixtures/record-framework-chain.ts
 *
 * Offline: it starts `anvil` (Foundry) on loopback, replays the Framework deployment from
 * the creation bytecode the installed `@metamask/delegation-abis` ships (the same bytes
 * `assertInstalledFrameworkBytecodes` pins), at the deployer's recorded nonces so every
 * address comes out as in the manifest, and replays the ownership hand-off. EntryPoint
 * v0.7 is set from the GIWA Sepolia recording in `apps/arcade-service/fixtures/entrypoint-v07.json`
 * (see ENTRY_POINT_RUNTIME). The verifier — not this script — then judges the result:
 * the shipped bundle runs `mapae_status` under `node` against a recording proxy, and the
 * recording is kept only if that status came back `ok`.
 *
 * The node-bundle test replays the recording from an in-process fake RPC, so the test
 * itself needs neither anvil nor the network.
 */
import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {rpcKey, statusFromNode} from "./framework-chain.js";
import {concat, encodeAbiParameters, getAddress, keccak256, type Address, type Hex} from "viem";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = join(HERE, "../../..");
const OUT = join(HERE, "framework-chain.rpc.json");
const requireFromDelegation = createRequire(join(REPO, "packages/delegation/package.json"));
const bytecodes = requireFromDelegation("@metamask/delegation-abis/bytecode") as Record<string, unknown>;

/** `eth_getCode 0x0000000071727De22E5E9d8BAf0edAc6f37da032` on GIWA Sepolia, recorded for the arcade. */
const ENTRY_POINT_RUNTIME = join(REPO, "apps/arcade-service/fixtures/entrypoint-v07.json");
/** `GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash` in packages/delegation/src/composition.ts. */
const GIWA_ENTRY_POINT_V07_RUNTIME_CODE_HASH = "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58";

interface ManifestDeployment {
    index: number;
    name: string;
    address: Address;
    nonce: string;
    constructorArguments: Address[];
}
const manifest = JSON.parse(
    readFileSync(join(REPO, "deployments/giwa-sepolia.framework-manifest.json"), "utf8"),
) as {deployer: Address; entryPoint: Address; deployments: ManifestDeployment[]};
const artifact = JSON.parse(
    readFileSync(join(REPO, "deployments/giwa-sepolia.framework.json"), "utf8"),
) as {admin: {owner: Address}};

function creationCode(name: string): Hex {
    const exportName = name.endsWith("Impl") ? name.slice(0, -"Impl".length) : name;
    const value = bytecodes[exportName];
    if (typeof value !== "string" || !value.startsWith("0x")) throw new Error(`no bytecode for ${name}`);
    // HybridDeleGator links the SCL_RIP7212 library: the only placeholder in the set.
    const scl = manifest.deployments.find((deployment) => deployment.name === "SCL_RIP7212")!.address;
    return value.replace(/__\$[0-9a-fA-F]{34}\$__/g, scl.slice(2).toLowerCase()) as Hex;
}

const port = 20_000 + Math.floor(Math.random() * 20_000);
const anvilUrl = `http://127.0.0.1:${port}`;
// Genesis at the artifact's verification block: the verifier refuses state read before it.
const genesis = (JSON.parse(readFileSync(join(REPO, "deployments/giwa-sepolia.framework.json"), "utf8")) as {
    admin: {verificationBlock: string};
}).admin.verificationBlock;
const anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "91342", "--number", genesis, "--silent"],
    {
        stdio: "ignore",
    },
);
let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch(anvilUrl, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: ++id, method, params}),
    });
    const body = (await response.json()) as {result?: unknown; error?: {message: string}};
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
}
async function send(from: Address, to: Address | null, data: Hex): Promise<{contractAddress: Address | null}> {
    const hash = await rpc("eth_sendTransaction", [{from, ...(to ? {to} : {}), data, gas: "0x1c9c380"}]);
    let receipt: {status: string; contractAddress: Address | null} | null = null;
    for (let tries = 0; receipt === null; tries++) {
        if (tries > 50) throw new Error(`transaction from ${from} was not mined`);
        if (tries > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        receipt = (await rpc("eth_getTransactionReceipt", [hash])) as typeof receipt;
    }
    if (receipt.status !== "0x1") throw new Error(`transaction from ${from} reverted`);
    return receipt;
}

try {
    for (let attempt = 0; ; attempt++) {
        try {
            await rpc("eth_chainId");
            break;
        } catch (error) {
            if (attempt > 100) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    // EntryPoint v0.7. Its exact runtime bytes are not in any installed package (the
    // delegation-abis build differs from the canonical one), so they come from
    // ENTRY_POINT_RUNTIME, checked against the pinned GIWA identity before use. Without
    // it the replay still runs, with the delegation-abis build standing in, to show how
    // far the shipped verifier gets — and nothing is written.
    const [funder] = (await rpc("eth_accounts")) as Address[];
    const entryPointRuntime = existsSync(ENTRY_POINT_RUNTIME)
        ? ((JSON.parse(readFileSync(ENTRY_POINT_RUNTIME, "utf8")) as {code: Hex}).code)
        : undefined;
    if (entryPointRuntime !== undefined) {
        if (keccak256(entryPointRuntime) !== GIWA_ENTRY_POINT_V07_RUNTIME_CODE_HASH) {
            throw new Error(`${ENTRY_POINT_RUNTIME} is not the canonical EntryPoint v0.7 runtime`);
        }
        await rpc("anvil_setCode", [manifest.entryPoint, entryPointRuntime]);
    } else {
        const {contractAddress} = await send(funder!, null, creationCode("EntryPoint"));
        await rpc("anvil_setCode", [manifest.entryPoint, await rpc("eth_getCode", [contractAddress, "latest"])]);
        console.error(`${ENTRY_POINT_RUNTIME} is absent: EntryPoint is a stand-in, the recording will not be kept`);
    }

    // The Framework, from the deployer, at the manifest's nonces.
    const deployer = getAddress(manifest.deployer);
    await rpc("anvil_impersonateAccount", [deployer]);
    await rpc("anvil_setBalance", [deployer, "0x56bc75e2d63100000"]);
    for (const deployment of [...manifest.deployments].sort((a, b) => a.index - b.index)) {
        await rpc("anvil_setNonce", [deployer, `0x${BigInt(deployment.nonce).toString(16)}`]);
        const args = encodeAbiParameters(
            deployment.constructorArguments.map(() => ({type: "address"})),
            deployment.constructorArguments,
        );
        const {contractAddress} = await send(deployer, null, concat([creationCode(deployment.name), args]));
        if (getAddress(contractAddress!) !== getAddress(deployment.address)) {
            throw new Error(`${deployment.name} landed at ${contractAddress}, manifest says ${deployment.address}`);
        }
    }

    // Ownable2Step hand-off to the recorded Framework admin.
    const manager = manifest.deployments.find((deployment) => deployment.name === "DelegationManager")!.address;
    const owner = getAddress(artifact.admin.owner);
    const selector = (signature: string) => keccak256(new TextEncoder().encode(signature)).slice(0, 10) as Hex;
    await send(deployer, manager, concat([selector("transferOwnership(address)"), encodeAbiParameters([{type: "address"}], [owner])]));
    await rpc("anvil_impersonateAccount", [owner]);
    await rpc("anvil_setBalance", [owner, "0x56bc75e2d63100000"]);
    await send(owner, manager, selector("acceptOwnership()"));

    // Record what the shipped bundle asks while it boots.
    const recorded: Record<string, unknown> = {};
    const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const body = (await request.json()) as {id: unknown; method: string; params?: unknown[]} | {id: unknown; method: string; params?: unknown[]}[];
            const answer = async (call: {id: unknown; method: string; params?: unknown[]}) => {
                const result = await rpc(call.method, call.params ?? []);
                recorded[rpcKey(call.method, call.params)] = result;
                return {jsonrpc: "2.0", id: call.id, result};
            };
            return Response.json(Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body));
        },
    });
    const facilitator = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({signers: {"eip155:91342": ["0x3000000000000000000000000000000000000003"]}}),
    });
    const outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mapae-record-"));
    try {
        const bundle = join(outDir, "mapae-agent-mcp.js");
        const build = spawnSync("bun", ["build", "./index.ts", "--target=node", "--outfile", bundle], {cwd: join(HERE, "..")});
        if (build.status !== 0) throw new Error(`bundle failed: ${build.stderr}`);
        const body = await statusFromNode(bundle, {
            GIWA_SEPOLIA_RPC_URL: proxy.url.toString(),
            FACILITATOR_URL: facilitator.url.toString(),
        });
        if (entryPointRuntime === undefined) {
            console.error(`shipped bundle status against the replay: ${JSON.stringify(body)}`);
            process.exitCode = 1;
        } else if (body.ok !== true) {
            throw new Error(`the bundle did not boot against the replay: ${JSON.stringify(body)}`);
        } else {
            writeFileSync(OUT, `${JSON.stringify(recorded, null, 1)}\n`);
            console.log(`recorded ${Object.keys(recorded).length} answers to ${OUT}`);
        }
    } finally {
        proxy.stop(true);
        facilitator.stop(true);
        rmSync(outDir, {recursive: true, force: true});
    }
} finally {
    anvil.kill();
}

