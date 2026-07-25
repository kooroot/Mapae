import {
    DELEGATION_FRAMEWORK_VERSION,
    ENTRY_POINT_V07,
    FRAMEWORK_COMPOSITION_ID,
    FrameworkDeploymentRecorder,
    assertInstalledFrameworkBytecodes,
    createRecordingWalletClient,
    finalizeFrameworkDeploymentManifest,
    parseDeploymentArtifact,
    verifyFrameworkLiveState,
    verifyGiwaEntryPointRuntimeCode,
    type DelegationDeploymentArtifact,
} from "@mapae/delegation";
import {giwaSepolia, redactForLog} from "@mapae/shared";
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
import {readD3IdentityConfig, readExpectedSignerAddress} from "./runtime-config.js";

const APPROVAL = `reviewed-chain-${giwaSepolia.id}-${FRAMEWORK_COMPOSITION_ID}`;

function printPreview(frameworkAdmin: string): void {
    console.log("GIWA Delegation Framework deployment preview");
    console.log(`  chain             ${giwaSepolia.name} (${giwaSepolia.id})`);
    console.log(`  framework         ${DELEGATION_FRAMEWORK_VERSION}`);
    console.log(`  composition       ${FRAMEWORK_COMPOSITION_ID}`);
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
    const value = process.env.DEPLOYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key");
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
    assertInstalledFrameworkBytecodes();
    if (!process.argv.includes("--broadcast")) {
        printPreview(identities.frameworkAdmin);
        return;
    }
    if (process.env.GIWA_DEPLOYMENT_APPROVAL !== APPROVAL) {
        throw new Error("deployment approval phrase is missing or incorrect; no broadcast made");
    }

    const rpcUrl = readRpcUrl();
    const account = privateKeyToAccount(readPrivateKey());
    const expectedDeployer = readExpectedSignerAddress("DEPLOYER_ADDRESS");
    if (account.address !== expectedDeployer) {
        throw new Error(
            `DEPLOYER_PRIVATE_KEY resolves to ${account.address}, expected ${expectedDeployer}`,
        );
    }
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
    verifyGiwaEntryPointRuntimeCode(entryPointCode);
    const balance = await publicClient.getBalance({address: account.address});
    console.log(`deployer ${account.address} (${formatEther(balance)} ETH)`);
    console.log(
        `broadcast gate passed; deploying pinned composition ${FRAMEWORK_COMPOSITION_ID}`,
    );

    // Reuse GIWA's canonical v0.7 EntryPoint; the SDK deploys Framework v1.3 contracts.
    const namedDeployments: Record<string, Hex> = {EntryPoint: ENTRY_POINT_V07};
    const recorder = new FrameworkDeploymentRecorder();
    const recordingWalletClient = createRecordingWalletClient(walletClient, recorder);
    const environment = await deploySmartAccountsEnvironment(
        recordingWalletClient,
        publicClient,
        giwaSepolia,
        namedDeployments,
    );
    const frameworkManifest = await finalizeFrameworkDeploymentManifest(
        recorder,
        publicClient,
        namedDeployments,
        account.address,
    );
    const pendingLiveState = await verifyFrameworkLiveState({
        publicClient,
        manifest: frameworkManifest,
        environment,
        expectedAdmin: {
            owner: account.address,
            pendingOwner: null,
            paused: false,
        },
    });
    const postDeploymentEntryPointCode = await publicClient.getCode({
        address: ENTRY_POINT_V07,
    });
    if (!postDeploymentEntryPointCode) {
        throw new Error("GIWA EntryPoint runtime could not be re-read after deployment");
    }
    verifyGiwaEntryPointRuntimeCode(postDeploymentEntryPointCode);

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
    await verifyFrameworkLiveState({
        publicClient,
        manifest: frameworkManifest,
        environment,
        expectedAdmin: {
            owner: account.address,
            pendingOwner: identities.frameworkAdmin,
            paused: false,
        },
    });

    const artifact: DelegationDeploymentArtifact = parseDeploymentArtifact({
        schemaVersion: 2,
        state: "ownership-pending",
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        environment,
        admin: {
            deployer: account.address,
            owner: account.address,
            pendingOwner: identities.frameworkAdmin,
            ownershipTransferTransaction: transferHash,
            verificationBlock: pendingLiveState.blockNumber,
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
        process.env.DELEGATION_BOOTSTRAP_PATH ??
        "../../deployments/giwa-sepolia.framework.bootstrap.json";
    const manifestOutput =
        process.env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    await Bun.write(manifestOutput, `${JSON.stringify(frameworkManifest, null, 2)}\n`);
    await Bun.write(output, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`ownership-pending bootstrap artifact written to ${output}`);
    console.log(`38-unit composition evidence written to ${manifestOutput}`);
    console.log(`Framework ownership pending acceptance by ${identities.frameworkAdmin}`);
    console.log("Owner smart-account creation and owner-signed delegations remain separate.");
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
