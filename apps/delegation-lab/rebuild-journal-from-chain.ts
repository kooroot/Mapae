/**
 * Rebuild a deployment journal from chain truth after an interrupted Forge broadcast.
 *
 * Forge can lose its receipt bookkeeping when a transaction is retried while the
 * original is already mined; the resulting `run-latest.json` had zero receipts and one
 * null hash even though every transaction landed. The deployed contracts are the
 * authoritative record, so this derives the journal from the chain instead.
 *
 * The block explorer is used only as a nonce -> transaction-hash index. Every field
 * that matters is then re-read over RPC and must agree: sender, nonce, creation vs
 * call, receipt success, and the deterministic CREATE address for that nonce. A hash
 * the explorer reports but RPC does not confirm is rejected rather than recorded.
 *
 * The original Forge journal is never modified. Output is a separate public file that
 * `import-forge-framework.ts` reads through FORGE_FRAMEWORK_BROADCAST_PATH, so the
 * audited importer still performs all of its own independent verification.
 *
 * Read-only. Sends no transaction and reads no private key.
 */
import {FRAMEWORK_DEPLOYMENT_ORDER} from "@mapae/delegation";
import {giwaSepolia} from "@mapae/shared";
import {rename} from "node:fs/promises";
import {resolve} from "node:path";
import {
    createPublicClient,
    getAddress,
    getContractAddress,
    http,
    isAddress,
    type Address,
    type Hex,
} from "viem";

const CREATION_COUNT = FRAMEWORK_DEPLOYMENT_ORDER.length;

function readDeployer(): Address {
    const value = process.env.DEPLOYER_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("DEPLOYER_ADDRESS must be an EVM address");
    return getAddress(value);
}

function readRpcUrl(): string {
    const value =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    return url.toString();
}

function readExplorerBase(): string {
    const value =
        process.env.GIWA_EXPLORER_API_URL?.trim() || "https://sepolia-explorer.giwa.io/api";
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("explorer API must be HTTPS");
    return url.toString();
}

async function writeAtomically(pathInput: string, contents: string): Promise<void> {
    const path = resolve(pathInput);
    const temporary = `${path}.tmp-${process.pid}`;
    await Bun.write(temporary, contents);
    await rename(temporary, path);
}

/** Explorer lookup only. Nothing here is trusted until RPC confirms it. */
async function indexNonceToHash(
    deployer: Address,
    first: number,
    last: number,
): Promise<Map<number, Hex>> {
    const url = `${readExplorerBase()}?module=account&action=txlist&address=${deployer}&sort=asc&page=1&offset=200`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`explorer index request failed: ${response.status}`);
    const body = (await response.json()) as {result?: Array<{nonce?: string; hash?: string}>};
    const rows = Array.isArray(body.result) ? body.result : [];
    const index = new Map<number, Hex>();
    for (const row of rows) {
        const nonce = Number(row.nonce);
        if (!Number.isInteger(nonce) || nonce < first || nonce > last) continue;
        if (typeof row.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.hash)) continue;
        if (index.has(nonce)) throw new Error(`explorer reported two transactions at nonce ${nonce}`);
        index.set(nonce, row.hash.toLowerCase() as Hex);
    }
    return index;
}

async function main(): Promise<void> {
    const deployer = readDeployer();
    const firstNonce = Number(process.env.JOURNAL_FIRST_NONCE ?? "3");
    if (!Number.isInteger(firstNonce) || firstNonce < 0) {
        throw new Error("JOURNAL_FIRST_NONCE must be a non-negative integer");
    }
    const lastCreationNonce = firstNonce + CREATION_COUNT - 1;
    const ownershipNonce = lastCreationNonce + 1;
    const outputPath =
        process.env.CHAIN_JOURNAL_PATH?.trim() ||
        "../../deployments/giwa-sepolia.framework-chain-journal.json";

    const publicClient = createPublicClient({chain: giwaSepolia, transport: http(readRpcUrl())});
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }

    const index = await indexNonceToHash(deployer, firstNonce, ownershipNonce);
    const receipts: Array<{transactionHash: Hex; nonce: number; contractAddress?: Address}> = [];

    for (let nonce = firstNonce; nonce <= ownershipNonce; nonce += 1) {
        const hash = index.get(nonce);
        if (!hash) throw new Error(`no transaction indexed for deployer nonce ${nonce}`);

        const transaction = await publicClient.getTransaction({hash});
        if (getAddress(transaction.from) !== deployer) {
            throw new Error(`nonce ${nonce}: sender ${transaction.from} is not the deployer`);
        }
        if (transaction.nonce !== nonce) {
            throw new Error(`nonce ${nonce}: RPC reports nonce ${transaction.nonce}`);
        }
        const receipt = await publicClient.getTransactionReceipt({hash});
        if (receipt.status !== "success") throw new Error(`nonce ${nonce}: transaction reverted`);

        const isCreation = nonce <= lastCreationNonce;
        if (isCreation) {
            if (transaction.to !== null) {
                throw new Error(`nonce ${nonce}: expected a contract creation`);
            }
            const expected = getContractAddress({from: deployer, nonce: BigInt(nonce)});
            if (!receipt.contractAddress || getAddress(receipt.contractAddress) !== expected) {
                throw new Error(
                    `nonce ${nonce}: created ${receipt.contractAddress} but CREATE address is ${expected}`,
                );
            }
            receipts.push({transactionHash: hash, nonce, contractAddress: expected});
        } else {
            if (transaction.to === null) {
                throw new Error(`nonce ${nonce}: expected the ownership-transfer call`);
            }
            receipts.push({transactionHash: hash, nonce});
        }
    }

    const creations = receipts.filter((entry) => entry.contractAddress).length;
    if (creations !== CREATION_COUNT || receipts.length !== CREATION_COUNT + 1) {
        throw new Error(`expected ${CREATION_COUNT} creations and one call, got ${creations}`);
    }

    const journal = {
        source: "chain-derived",
        note: "Rebuilt from GIWA state after an interrupted Forge broadcast. The explorer supplied only the nonce index; every field was re-verified over RPC. The original Forge journal is unmodified.",
        chainId: giwaSepolia.id,
        deployer,
        firstNonce,
        receipts,
    };
    await writeAtomically(outputPath, `${JSON.stringify(journal, null, 2)}\n`);

    console.log(`rebuilt journal from chain: ${creations} creations + 1 ownership call`);
    console.log(`  deployer  ${deployer}`);
    console.log(`  nonces    ${firstNonce}..${ownershipNonce}`);
    console.log(`  output    ${outputPath}`);
    console.log("");
    console.log("Next, run the audited importer against it:");
    console.log(`  FORGE_FRAMEWORK_BROADCAST_PATH=${outputPath} bun run forge:import`);
    console.log("No transaction was broadcast by this tool.");
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
