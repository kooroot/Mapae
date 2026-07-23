import {
    DELEGATION_FRAMEWORK_VERSION,
    ENTRY_POINT_V07,
    parseDeploymentArtifact,
    type DelegationDeploymentArtifact,
} from "@mapae/delegation";
import {giwaSepolia} from "@mapae/shared";
import {deploySmartAccountsEnvironment} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    getAddress,
    http,
    isAddress,
    parseAbi,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {readD3IdentityConfig} from "./runtime-config.js";

const APPROVAL = "reviewed-chain-91342-framework-1.3.0";

function printPreview(frameworkAdmin: string): void {
    console.log("GIWA Delegation Framework deployment preview");
    console.log(`  chain             ${giwaSepolia.name} (${giwaSepolia.id})`);
    console.log(`  framework         ${DELEGATION_FRAMEWORK_VERSION}`);
    console.log(`  existing EntryPoint ${ENTRY_POINT_V07}`);
    console.log(`  framework admin   ${frameworkAdmin}`);
    console.log("  broadcast         BLOCKED");
    console.log("");
    console.log("After code review, deployment requires both:");
    console.log("  1. --broadcast");
    console.log(`  2. GIWA_DEPLOYMENT_APPROVAL=${APPROVAL}`);
    console.log("No key is read and no RPC write is made in preview mode.");
}

function readPrivateKey(): Hex {
    const value = process.env.RELAYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readRpcUrl(): string {
    const value = process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without embedded credentials");
    }
    return url.toString();
}

async function main(): Promise<void> {
    const identities = readD3IdentityConfig();
    if (!process.argv.includes("--broadcast")) {
        printPreview(identities.frameworkAdmin);
        return;
    }
    if (process.env.GIWA_DEPLOYMENT_APPROVAL !== APPROVAL) {
        throw new Error("deployment approval phrase is missing or incorrect; no broadcast made");
    }

    const rpcUrl = readRpcUrl();
    const account = privateKeyToAccount(readPrivateKey());
    const publicClient = createPublicClient({chain: giwaSepolia, transport: http(rpcUrl)});
    const walletClient = createWalletClient({
        account,
        chain: giwaSepolia,
        transport: http(rpcUrl),
    });

    const liveChainId = await publicClient.getChainId();
    if (liveChainId !== giwaSepolia.id) {
        throw new Error(`RPC chain ${liveChainId} does not match ${giwaSepolia.id}`);
    }
    const entryPointCode = await publicClient.getCode({address: ENTRY_POINT_V07});
    if (!entryPointCode || entryPointCode === "0x") {
        throw new Error(`canonical EntryPoint has no code at ${ENTRY_POINT_V07}`);
    }
    const balance = await publicClient.getBalance({address: account.address});
    console.log(`deployer ${account.address} (${formatEther(balance)} ETH)`);
    console.log("broadcast gate passed; deploying audited Smart Accounts Kit 1.7.0 environment");

    // Reuse GIWA's canonical v0.7 EntryPoint; the SDK deploys Framework v1.3 contracts.
    const environment = await deploySmartAccountsEnvironment(
        walletClient,
        publicClient,
        giwaSepolia,
        {EntryPoint: ENTRY_POINT_V07},
    );

    const ownershipAbi = parseAbi([
        "function owner() view returns (address)",
        "function pendingOwner() view returns (address)",
        "function transferOwnership(address newOwner)",
    ]);
    const currentOwner = await publicClient.readContract({
        address: getAddress(environment.DelegationManager),
        abi: ownershipAbi,
        functionName: "owner",
    });
    if (getAddress(currentOwner) !== account.address) {
        throw new Error(`unexpected Framework owner ${currentOwner}; refusing ownership change`);
    }
    const transferHash = await walletClient.writeContract({
        address: getAddress(environment.DelegationManager),
        abi: ownershipAbi,
        functionName: "transferOwnership",
        args: [identities.frameworkAdmin],
    });
    const transferReceipt = await publicClient.waitForTransactionReceipt({hash: transferHash});
    if (transferReceipt.status !== "success") {
        throw new Error("Framework ownership transfer initiation reverted");
    }
    const pendingOwner = await publicClient.readContract({
        address: getAddress(environment.DelegationManager),
        abi: ownershipAbi,
        functionName: "pendingOwner",
    });
    if (getAddress(pendingOwner) !== identities.frameworkAdmin) {
        throw new Error("Framework pending owner does not match configured Framework admin");
    }

    const artifact: DelegationDeploymentArtifact = parseDeploymentArtifact({
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        environment,
        admin: {
            owner: account.address,
            pendingOwner: identities.frameworkAdmin,
        },
    });
    for (const [field, value] of [
        ["DelegationManager", artifact.environment.DelegationManager],
        ["SimpleFactory", artifact.environment.SimpleFactory],
        ["HybridDeleGatorImpl", artifact.environment.implementations.HybridDeleGatorImpl],
        [
            "ERC20PeriodTransferEnforcer",
            artifact.environment.caveatEnforcers.ERC20PeriodTransferEnforcer,
        ],
    ] as const) {
        if (typeof value !== "string" || !isAddress(value)) {
            throw new Error(`${field} is not an address`);
        }
        const code = await publicClient.getCode({address: getAddress(value)});
        if (!code || code === "0x") throw new Error(`${field} has no deployed code`);
    }

    const output =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    await Bun.write(output, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`verified public deployment artifact written to ${output}`);
    console.log(`Framework ownership pending acceptance by ${identities.frameworkAdmin}`);
    console.log("Owner smart-account creation and owner-signed delegations remain separate.");
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
