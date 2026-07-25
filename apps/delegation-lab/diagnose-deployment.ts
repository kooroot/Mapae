/**
 * Read-only forensic scan of an interrupted Forge Framework broadcast.
 *
 * The journal's predicted CREATE addresses are wrong when transactions are mined
 * out of nonce order, so this identifies what is actually on chain by matching each
 * deployer-CREATE address against the pinned composition's runtime hashes.
 *
 * Sends no transaction and reads no private key.
 */
import {redactForLog} from "@mapae/shared";
import {
    FRAMEWORK_DEPLOYMENT_ORDER,
    verifyFrameworkRuntimeCode,
    type FrameworkDeploymentName,
} from "@mapae/delegation";
import {createPublicClient, getAddress, getContractAddress, http, type Address} from "viem";

const RPC = process.env.GIWA_SEPOLIA_RPC_URL?.trim() || "https://sepolia-rpc.giwa.io";
const DEPLOYER = getAddress(process.env.DEPLOYER_ADDRESS ?? "");
const FIRST_NONCE = Number(process.env.SCAN_FIRST_NONCE ?? "3");
const LAST_NONCE = Number(process.env.SCAN_LAST_NONCE ?? "41");

async function main(): Promise<void> {
    const client = createPublicClient({transport: http(RPC)});
    const chainId = await client.getChainId();
    const found = new Map<FrameworkDeploymentName, Address>();
    const unknown: Array<{nonce: number; address: Address; size: number}> = [];
    const empty: number[] = [];

    for (let nonce = FIRST_NONCE; nonce <= LAST_NONCE; nonce += 1) {
        const address = getContractAddress({from: DEPLOYER, nonce: BigInt(nonce)});
        const code = await client.getCode({address});
        if (!code || code === "0x") {
            empty.push(nonce);
            continue;
        }
        let matched: FrameworkDeploymentName | undefined;
        for (const name of FRAMEWORK_DEPLOYMENT_ORDER) {
            try {
                verifyFrameworkRuntimeCode(name, code);
                matched = name;
                break;
            } catch {
                // not this component; keep scanning the pinned set
            }
        }
        if (matched) {
            if (found.has(matched)) {
                console.log(`  DUPLICATE ${matched} at nonce ${nonce} (${address})`);
            }
            found.set(matched, address);
        } else {
            unknown.push({nonce, address, size: (code.length - 2) / 2});
        }
    }

    const missing = FRAMEWORK_DEPLOYMENT_ORDER.filter((name) => !found.has(name));

    console.log(`chain ${chainId}  deployer ${DEPLOYER}  nonces ${FIRST_NONCE}..${LAST_NONCE}`);
    console.log(`matched ${found.size}/${FRAMEWORK_DEPLOYMENT_ORDER.length} pinned components`);
    console.log(`unidentified contracts: ${unknown.length}`);
    console.log(`empty nonces: ${empty.length ? empty.join(", ") : "none"}`);
    console.log("");

    for (const name of FRAMEWORK_DEPLOYMENT_ORDER) {
        const address = found.get(name);
        console.log(`  ${address ?? "MISSING".padEnd(42)}  ${name}`);
    }
    if (unknown.length) {
        console.log("\nunidentified:");
        for (const u of unknown) {
            console.log(`  nonce ${u.nonce}  ${u.address}  ${u.size} bytes`);
        }
    }
    if (missing.length) {
        console.log(`\nMISSING COMPONENTS: ${missing.join(", ")}`);
        process.exitCode = 1;
    }
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
