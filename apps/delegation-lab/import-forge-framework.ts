import {
    DELEGATION_FRAMEWORK_VERSION,
    ENTRY_POINT_V07,
    FRAMEWORK_COMPOSITION_ID,
    FRAMEWORK_DEPLOYMENT_ORDER,
    FrameworkDeploymentRecorder,
    assertInstalledFrameworkBytecodes,
    finalizeFrameworkDeploymentManifest,
    parseDeploymentArtifact,
    verifyFrameworkLiveState,
    throttledHttp,
    verifyGiwaEntryPointRuntimeCode,
    type FrameworkDeploymentName,
} from "@mapae/delegation";
import {giwaSepolia, redactForLog} from "@mapae/shared";
import {rename} from "node:fs/promises";
import {resolve} from "node:path";
import {
    createPublicClient,
    encodeFunctionData,
    getAddress,
    isAddress,
    parseAbi,
    type Address,
    type Hex,
} from "viem";

interface FoundryBroadcastReceipt {
    transactionHash?: unknown;
}

function readRpcUrl(): string {
    const value =
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() ||
        giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    const localTestRpc =
        process.env.ALLOW_LOCAL_RPC === "true" &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (
        (!localTestRpc && url.protocol !== "https:") ||
        url.username ||
        url.password
    ) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without credentials");
    }
    return url.toString();
}

function readFrameworkAdmin(): Address {
    const value = process.env.FRAMEWORK_ADMIN_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) {
        throw new Error("FRAMEWORK_ADMIN_ADDRESS must be an EVM address");
    }
    return getAddress(value);
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

function parseReceiptHashes(json: string): readonly Hex[] {
    let input: unknown;
    try {
        input = JSON.parse(json);
    } catch {
        throw new Error("Foundry broadcast journal is not valid JSON");
    }
    if (!input || typeof input !== "object") {
        throw new Error("Foundry broadcast journal must be an object");
    }
    const receipts = (input as Record<string, unknown>).receipts;
    if (!Array.isArray(receipts)) {
        throw new Error("Foundry broadcast journal has no receipts");
    }
    const seen = new Set<Hex>();
    return receipts.map((raw, index) => {
        const hash =
            raw && typeof raw === "object"
                ? (raw as FoundryBroadcastReceipt).transactionHash
                : undefined;
        if (
            typeof hash !== "string" ||
            !/^0x[0-9a-fA-F]{64}$/.test(hash)
        ) {
            throw new Error(`Foundry receipt ${index} has no transaction hash`);
        }
        const normalized = hash.toLowerCase() as Hex;
        if (seen.has(normalized)) {
            throw new Error(`Foundry receipt ${index} duplicates a transaction`);
        }
        seen.add(normalized);
        return normalized;
    });
}

function environmentFromAddresses(
    addresses: Readonly<Record<FrameworkDeploymentName, Address>>,
) {
    const implementations = Object.fromEntries(
        [
            "HybridDeleGatorImpl",
            "MultiSigDeleGatorImpl",
            "EIP7702StatelessDeleGatorImpl",
        ].map((name) => [name, addresses[name as FrameworkDeploymentName]]),
    ) as Record<string, Address>;
    const caveatEnforcers = Object.fromEntries(
        FRAMEWORK_DEPLOYMENT_ORDER.filter(
            (name) =>
                ![
                    "SimpleFactory",
                    "DelegationManager",
                    "SCL_RIP7212",
                    "HybridDeleGatorImpl",
                    "MultiSigDeleGatorImpl",
                    "EIP7702StatelessDeleGatorImpl",
                ].includes(name),
        ).map((name) => [name, addresses[name]]),
    ) as Record<string, Address>;
    return {
        DelegationManager: addresses.DelegationManager,
        EntryPoint: ENTRY_POINT_V07,
        SimpleFactory: addresses.SimpleFactory,
        implementations,
        caveatEnforcers,
    };
}

async function main(): Promise<void> {
    assertInstalledFrameworkBytecodes();
    const frameworkAdmin = readFrameworkAdmin();
    const broadcastPath =
        process.env.FORGE_FRAMEWORK_BROADCAST_PATH?.trim() ||
        "../../contracts/broadcast/DeployDelegationFramework.s.sol/91342/run-latest.json";
    const manifestPath =
        process.env.DELEGATION_MANIFEST_PATH?.trim() ||
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const bootstrapPath =
        process.env.DELEGATION_BOOTSTRAP_PATH?.trim() ||
        "../../deployments/giwa-sepolia.framework.bootstrap.json";

    const hashes = parseReceiptHashes(
        await readText(broadcastPath, "Foundry broadcast journal"),
    );
    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(readRpcUrl()),
    });
    if ((await publicClient.getChainId()) !== giwaSepolia.id) {
        throw new Error("RPC is not GIWA Sepolia");
    }
    const entryPointCode = await publicClient.getCode({address: ENTRY_POINT_V07});
    if (!entryPointCode) throw new Error("GIWA EntryPoint runtime is missing");
    verifyGiwaEntryPointRuntimeCode(entryPointCode);

    const transactions = [];
    for (const hash of hashes) {
        transactions.push(await publicClient.getTransaction({hash}));
    }
    const creationTransactions = transactions.filter(
        (transaction) => transaction.to === null,
    );
    const callTransactions = transactions.filter(
        (transaction) => transaction.to !== null,
    );
    if (
        creationTransactions.length !== FRAMEWORK_DEPLOYMENT_ORDER.length ||
        callTransactions.length !== 1
    ) {
        throw new Error(
            "Foundry journal must contain exactly 38 creations and one ownership-transfer call",
        );
    }

    const deployer = getAddress(creationTransactions[0]?.from ?? "0x");
    const recorder = new FrameworkDeploymentRecorder();
    for (const transaction of creationTransactions) {
        if (getAddress(transaction.from) !== deployer) {
            throw new Error("Foundry Framework deployment uses multiple senders");
        }
        recorder.recordExternalDeployment(transaction.hash, transaction.input);
    }
    recorder.assertComplete();

    const addresses = {} as Record<FrameworkDeploymentName, Address>;
    for (const [index, name] of FRAMEWORK_DEPLOYMENT_ORDER.entries()) {
        const transaction = creationTransactions[index];
        if (!transaction) throw new Error(`${name} transaction is missing`);
        const receipt = await publicClient.getTransactionReceipt({
            hash: transaction.hash,
        });
        if (receipt.status !== "success" || !receipt.contractAddress) {
            throw new Error(`${name} Forge deployment did not create a contract`);
        }
        addresses[name] = getAddress(receipt.contractAddress);
    }
    const namedDeployments: Record<string, Hex> = {EntryPoint: ENTRY_POINT_V07};
    for (const name of FRAMEWORK_DEPLOYMENT_ORDER) {
        if (name !== "SCL_RIP7212") namedDeployments[name] = addresses[name];
    }

    const manifest = await finalizeFrameworkDeploymentManifest(
        recorder,
        publicClient,
        namedDeployments,
        deployer,
    );
    const environment = environmentFromAddresses(addresses);
    const manager = getAddress(environment.DelegationManager);
    const ownershipTransaction = callTransactions[0];
    if (!ownershipTransaction) throw new Error("ownership-transfer transaction is missing");
    const expectedTransferData = encodeFunctionData({
        abi: parseAbi(["function transferOwnership(address newOwner)"]),
        functionName: "transferOwnership",
        args: [frameworkAdmin],
    });
    const ownershipReceipt = await publicClient.getTransactionReceipt({
        hash: ownershipTransaction.hash,
    });
    if (
        ownershipReceipt.status !== "success" ||
        ownershipTransaction.to === null ||
        getAddress(ownershipTransaction.to) !== manager ||
        getAddress(ownershipTransaction.from) !== deployer ||
        ownershipTransaction.input !== expectedTransferData ||
        ownershipTransaction.value !== 0n
    ) {
        throw new Error("Forge ownership-transfer transaction evidence is invalid");
    }
    const live = await verifyFrameworkLiveState({
        publicClient,
        manifest,
        environment,
        expectedAdmin: {
            owner: deployer,
            pendingOwner: frameworkAdmin,
            paused: false,
        },
    });

    const bootstrap = parseDeploymentArtifact({
        schemaVersion: 2,
        state: "ownership-pending",
        chainId: giwaSepolia.id,
        frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
        compositionId: FRAMEWORK_COMPOSITION_ID,
        environment,
        admin: {
            deployer,
            owner: deployer,
            pendingOwner: frameworkAdmin,
            ownershipTransferTransaction: ownershipTransaction.hash,
            verificationBlock: live.blockNumber,
        },
    });
    await writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeAtomically(bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

    console.log("Forge broadcast imported and independently verified");
    console.log(`  composition ${manifest.compositionId}`);
    console.log(`  deployments ${manifest.deploymentCount}`);
    console.log(`  manager      ${manager}`);
    console.log(`  state        ${bootstrap.state}`);
    console.log(`  manifest     ${manifestPath}`);
    console.log(`  bootstrap    ${bootstrapPath}`);
    console.log("No transaction was broadcast by this importer.");
}

main().catch((error: unknown) => {
    console.error(redactForLog(error));
    process.exitCode = 1;
});
