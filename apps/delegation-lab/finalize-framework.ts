import {
    DELEGATION_FRAMEWORK_VERSION,
    FRAMEWORK_COMPOSITION_ID,
    buildFrameworkOwnershipAcceptance,
    parseDeploymentArtifact,
    parseDeploymentArtifactJson,
    parseFrameworkDeploymentManifestJson,
    throttledHttp,
    verifyFrameworkLiveState,
} from "@mapae/delegation";
import {giwaSepolia, redactForLog} from "@mapae/shared";
import {resolve} from "node:path";
import {rename} from "node:fs/promises";
import {
    createPublicClient,
    encodeFunctionData,
    getAddress,
    parseAbi,
    type Hex,
} from "viem";
import {readD3IdentityConfig} from "./runtime-config.js";

function readRpcUrl(): string {
    const value =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() ||
        giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    return url.toString();
}

function readAcceptanceHash(): Hex {
    const value = process.env.FRAMEWORK_OWNERSHIP_ACCEPTANCE_TX?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(
            "FRAMEWORK_OWNERSHIP_ACCEPTANCE_TX must be the public acceptOwnership transaction hash",
        );
    }
    return value as Hex;
}

async function readText(path: string, label: string): Promise<string> {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`${label} not found: ${path}`);
    return file.text();
}

async function writeAtomically(pathInput: string, contents: string): Promise<void> {
    const path = resolve(pathInput);
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await Bun.write(temporary, contents);
    await rename(temporary, path);
}

async function main(): Promise<void> {
    const identities = readD3IdentityConfig();
    const bootstrapPath =
        process.env.DELEGATION_BOOTSTRAP_PATH ??
        "../../deployments/giwa-sepolia.framework.bootstrap.json";
    const manifestPath =
        process.env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const activePath =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";

    const bootstrap = parseDeploymentArtifactJson(
        await readText(bootstrapPath, "ownership-pending bootstrap artifact"),
    );
    if (bootstrap.state !== "ownership-pending") {
        throw new Error("bootstrap artifact is not ownership-pending");
    }
    if (bootstrap.admin.pendingOwner !== identities.frameworkAdmin) {
        throw new Error("bootstrap pending owner does not match FRAMEWORK_ADMIN_ADDRESS");
    }
    const manifest = parseFrameworkDeploymentManifestJson(
        await readText(manifestPath, "Framework composition manifest"),
    );
    if (
        manifest.chainId !== bootstrap.chainId ||
        manifest.deployer !== bootstrap.admin.deployer ||
        manifest.compositionId !== bootstrap.compositionId
    ) {
        throw new Error("bootstrap artifact and composition manifest do not match");
    }

    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(readRpcUrl()),
    });
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }
    const manager = getAddress(bootstrap.environment.DelegationManager);
    const transferOwnershipData = encodeFunctionData({
        abi: parseAbi(["function transferOwnership(address newOwner)"]),
        functionName: "transferOwnership",
        args: [identities.frameworkAdmin],
    });
    const acceptance = buildFrameworkOwnershipAcceptance(manager);
    const acceptanceHash = readAcceptanceHash();
    const [transferTransaction, transferReceipt, acceptanceTransaction, acceptanceReceipt] =
        await Promise.all([
            publicClient.getTransaction({
                hash: bootstrap.admin.ownershipTransferTransaction,
            }),
            publicClient.getTransactionReceipt({
                hash: bootstrap.admin.ownershipTransferTransaction,
            }),
            publicClient.getTransaction({hash: acceptanceHash}),
            publicClient.getTransactionReceipt({hash: acceptanceHash}),
        ]);
    if (
        transferReceipt.status !== "success" ||
        transferTransaction.to === null ||
        getAddress(transferTransaction.to) !== manager ||
        getAddress(transferTransaction.from) !== bootstrap.admin.deployer ||
        transferTransaction.input !== transferOwnershipData ||
        transferTransaction.value !== 0n
    ) {
        throw new Error("bootstrap ownership-transfer transaction evidence is invalid");
    }
    if (
        acceptanceReceipt.status !== "success" ||
        acceptanceTransaction.to === null ||
        getAddress(acceptanceTransaction.to) !== manager ||
        getAddress(acceptanceTransaction.from) !== identities.frameworkAdmin ||
        acceptanceTransaction.input !== acceptance.data ||
        acceptanceTransaction.value !== 0n
    ) {
        throw new Error("Framework ownership-acceptance transaction evidence is invalid");
    }

    const live = await verifyFrameworkLiveState({
        publicClient,
        manifest,
        environment: bootstrap.environment,
        expectedAdmin: {
            owner: identities.frameworkAdmin,
            pendingOwner: null,
            paused: false,
        },
    });
    if (BigInt(live.blockNumber) < acceptanceReceipt.blockNumber) {
        throw new Error("active verification block predates ownership acceptance");
    }

    const active = parseDeploymentArtifact({
        schemaVersion: 2,
        state: "active",
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        environment: bootstrap.environment,
        admin: {
            deployer: bootstrap.admin.deployer,
            owner: identities.frameworkAdmin,
            pendingOwner: null,
            ownershipTransferTransaction:
                bootstrap.admin.ownershipTransferTransaction,
            ownershipAcceptanceTransaction: acceptanceHash,
            verificationBlock: live.blockNumber,
        },
    });
    if (active.state !== "active") {
        throw new Error("active artifact parser returned a non-active state");
    }
    await writeAtomically(activePath, `${JSON.stringify(active, null, 2)}\n`);

    console.log(`active Framework artifact written atomically to ${activePath}`);
    console.log(`  composition ${active.compositionId}`);
    console.log(`  owner       ${active.admin.owner}`);
    console.log(`  block       ${active.admin.verificationBlock}`);
    console.log("No transaction was broadcast by this finalizer.");
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
