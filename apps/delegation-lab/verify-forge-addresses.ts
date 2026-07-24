/**
 * Cross-check the Forge address artifact against live chain truth.
 *
 * The deployed contracts are authoritative; anything written before or during the
 * broadcast is a prediction until proven. For every name/address pair this fetches
 * the live runtime and requires it to match that component's pinned hash, then
 * confirms the address is the deterministic CREATE address for its composition index.
 *
 * Read-only. Sends no transaction and reads no private key.
 */
import {
    FRAMEWORK_DEPLOYMENT_ORDER,
    GIWA_ENTRY_POINT_V07_IDENTITY,
    verifyFrameworkRuntimeCode,
} from "@mapae/delegation";
import {createPublicClient, getAddress, getContractAddress, http, keccak256} from "viem";

const RPC = process.env.GIWA_SEPOLIA_RPC_URL?.trim() || "https://sepolia-rpc.giwa.io";
const ARTIFACT =
    process.env.FRAMEWORK_FORGE_ADDRESS_PATH ??
    "../../deployments/giwa-sepolia.framework-forge-addresses.json";
const FIRST_NONCE = Number(process.env.SCAN_FIRST_NONCE ?? "3");

async function main(): Promise<void> {
    const artifact = (await Bun.file(ARTIFACT).json()) as Record<string, string>;
    const client = createPublicClient({transport: http(RPC)});
    const deployer = getAddress(artifact.deployer ?? "");
    let ok = 0;
    const problems: string[] = [];

    for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
        const recorded = artifact[name];
        if (!recorded) {
            problems.push(`${name}: absent from the artifact`);
            continue;
        }
        const address = getAddress(recorded);
        const expectedCreate = getContractAddress({
            from: deployer,
            nonce: BigInt(FIRST_NONCE + index),
        });
        if (address !== expectedCreate) {
            problems.push(
                `${name}: artifact ${address} is not the CREATE address for nonce ${FIRST_NONCE + index} (${expectedCreate})`,
            );
            continue;
        }
        const code = await client.getCode({address});
        if (!code || code === "0x") {
            problems.push(`${name}: ${address} has no runtime code`);
            continue;
        }
        try {
            verifyFrameworkRuntimeCode(name, code);
            ok += 1;
        } catch (error) {
            problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const entryPoint = getAddress(artifact.EntryPoint ?? "");
    const entryPointCode = await client.getCode({address: entryPoint});
    const entryPointOk =
        entryPoint === getAddress(GIWA_ENTRY_POINT_V07_IDENTITY.address) &&
        !!entryPointCode &&
        keccak256(entryPointCode) === GIWA_ENTRY_POINT_V07_IDENTITY.runtimeCodeHash;

    console.log(`artifact  ${ARTIFACT}`);
    console.log(`chain     ${await client.getChainId()}   deployer ${deployer}`);
    console.log(
        `components ${ok}/${FRAMEWORK_DEPLOYMENT_ORDER.length} verified against live runtime + CREATE address`,
    );
    console.log(`EntryPoint identity: ${entryPointOk ? "match" : "MISMATCH"}`);
    if (problems.length) {
        console.log("\nproblems:");
        for (const p of problems) console.log(`  ${p}`);
        process.exitCode = 1;
    } else {
        console.log("\nartifact matches deployed reality");
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
