import {
    FRAMEWORK_COMPOSITION_ID,
    FrameworkDeploymentRecorder,
    buildD3Policies,
    createMapaeDelegationProvider,
    createRecordingWalletClient,
    finalizeFrameworkDeploymentManifest,
    parseFrameworkDeploymentManifest,
    preparePeriodDelegation,
    verifyFrameworkLiveState,
    verifyOwnerSmartAccount,
    withDelegationSignature,
} from "@mapae/delegation";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {EntryPoint as EntryPointBytecode} from "@metamask/delegation-abis/bytecode";
import {
    ExecutionMode,
    Implementation,
    createExecution,
    toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    deploySmartAccountsEnvironment,
    encodeDelegations,
} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    encodeFunctionData,
    getAddress,
    http,
    parseAbi,
    publicActions,
    type Abi,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const ANVIL_RELAYER_KEY =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL_FRAMEWORK_ADMIN_KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OWNER_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
const AGENT_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex;
const WRONG_PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const LOCAL_FIXED_VENDOR = getAddress("0x2000000000000000000000000000000000000002");
const D3_POLICIES = buildD3Policies(LOCAL_FIXED_VENDOR);
const FIXED_VENDOR = D3_POLICIES["vendor-agent"].recipient!;
const RPC_URL = process.env.ANVIL_RPC_URL?.trim() || "http://127.0.0.1:8545";

const anvil = defineChain({
    id: 31_337,
    name: "Mapae local Anvil",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [RPC_URL]}},
});

async function main(): Promise<void> {
    const relayer = privateKeyToAccount(ANVIL_RELAYER_KEY);
    const frameworkAdmin = privateKeyToAccount(ANVIL_FRAMEWORK_ADMIN_KEY);
    const owner = privateKeyToAccount(OWNER_KEY);
    const agent = privateKeyToAccount(AGENT_KEY);
    const publicClient = createPublicClient({chain: anvil, transport: http(RPC_URL)});
    const relayerClient = createWalletClient({
        account: relayer,
        chain: anvil,
        transport: http(RPC_URL),
    }).extend(publicActions);
    const frameworkAdminClient = createWalletClient({
        account: frameworkAdmin,
        chain: anvil,
        transport: http(RPC_URL),
    });
    if ((await publicClient.getChainId()) !== anvil.id) {
        throw new Error("local integration requires Anvil chain 31337");
    }

    console.log("[local] deploying ERC-4337 v0.7 EntryPoint");
    const entryPointHash = await relayerClient.deployContract({
        abi: EntryPointAbi,
        bytecode: EntryPointBytecode,
        args: [],
        account: relayer,
        chain: anvil,
    });
    const entryPointReceipt = await publicClient.waitForTransactionReceipt({
        hash: entryPointHash,
    });
    if (!entryPointReceipt.contractAddress) {
        throw new Error("local EntryPoint deployment returned no address");
    }
    const namedDeployments: Record<string, Hex> = {
        EntryPoint: getAddress(entryPointReceipt.contractAddress),
    };
    const recorder = new FrameworkDeploymentRecorder();
    const recordingRelayerClient = createRecordingWalletClient(relayerClient, recorder);

    console.log("[local] deploying and recording pinned 38-unit Framework composition");
    const environment = await deploySmartAccountsEnvironment(
        recordingRelayerClient,
        publicClient,
        anvil,
        namedDeployments,
    );
    const rawFrameworkManifest = await finalizeFrameworkDeploymentManifest(
        recorder,
        publicClient,
        namedDeployments,
        relayer.address,
    );
    const frameworkManifest = parseFrameworkDeploymentManifest(
        JSON.parse(JSON.stringify(rawFrameworkManifest)) as unknown,
    );
    if (frameworkManifest.compositionId !== FRAMEWORK_COMPOSITION_ID) {
        throw new Error("local Framework manifest composition ID mismatch");
    }
    await verifyFrameworkLiveState({
        publicClient,
        manifest: frameworkManifest,
        environment,
        expectedAdmin: {
            owner: relayer.address,
            pendingOwner: null,
            paused: false,
        },
    });
    console.log(
        `[local] verified ${frameworkManifest.deploymentCount} deployments (${frameworkManifest.compositionId})`,
    );
    const ownershipAbi = parseAbi([
        "function transferOwnership(address newOwner)",
        "function acceptOwnership()",
    ]);
    const transferOwnershipHash = await relayerClient.writeContract({
        address: getAddress(environment.DelegationManager),
        abi: ownershipAbi,
        functionName: "transferOwnership",
        args: [frameworkAdmin.address],
    });
    await publicClient.waitForTransactionReceipt({hash: transferOwnershipHash});
    await verifyFrameworkLiveState({
        publicClient,
        manifest: frameworkManifest,
        environment,
        expectedAdmin: {
            owner: relayer.address,
            pendingOwner: frameworkAdmin.address,
            paused: false,
        },
    });
    const acceptOwnershipHash = await frameworkAdminClient.writeContract({
        address: getAddress(environment.DelegationManager),
        abi: ownershipAbi,
        functionName: "acceptOwnership",
    });
    await publicClient.waitForTransactionReceipt({hash: acceptOwnershipHash});
    await verifyFrameworkLiveState({
        publicClient,
        manifest: frameworkManifest,
        environment,
        expectedAdmin: {
            owner: frameworkAdmin.address,
            pendingOwner: null,
            paused: false,
        },
    });
    console.log("[local] verified two-step Framework ownership finalization");
    const token = await deployMockUsdc(relayerClient, publicClient);

    const ownerAccount = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        signer: {account: owner},
        environment,
        deployParams: [owner.address, [], [], []],
        deploySalt:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    const factory = await ownerAccount.getFactoryArgs();
    if (!factory.factory || !factory.factoryData) {
        throw new Error("owner smart account did not return factory args");
    }
    const deployHash = await relayerClient.sendTransaction({
        to: factory.factory,
        data: factory.factoryData,
        value: 0n,
    });
    await publicClient.waitForTransactionReceipt({hash: deployHash});
    const accountCode = await publicClient.getCode({address: ownerAccount.address});
    if (!accountCode || accountCode === "0x") throw new Error("owner smart account not deployed");
    await verifyOwnerSmartAccount({
        publicClient,
        account: ownerAccount.address,
        expectedOwner: owner.address,
        environment,
    });
    console.log("[local] verified owner account proxy, wiring, and initialization");

    const mintHash = await relayerClient.writeContract({
        address: token.address,
        abi: token.abi,
        functionName: "mint",
        args: [ownerAccount.address, 100_000_000n],
    });
    await publicClient.waitForTransactionReceipt({hash: mintHash});
    const block = await publicClient.getBlock();
    const startDate = Number(block.timestamp) - 1;

    const periodPolicy = {
        ...D3_POLICIES["open-agent"],
        token: token.address,
    };
    const unsigned = preparePeriodDelegation({
        environment,
        delegator: ownerAccount.address,
        delegate: agent.address,
        policy: periodPolicy,
        startDate,
    });
    const rootSignature = await ownerAccount.signDelegation({
        delegation: unsigned,
        chainId: anvil.id,
    });
    const parentPermissionContext = encodeDelegations([
        withDelegationSignature(unsigned, rootSignature),
    ]);
    const provider = createMapaeDelegationProvider({
        account: agent,
        environment,
        parentPermissionContext,
        facilitatorAddresses: [relayer.address],
    });

    console.log("[local] settling three 1 mUSDC leaves under a 3 mUSDC/60s parent");
    for (let index = 0; index < 3; index += 1) {
        await settleLeaf({
            provider,
            environment,
            client: relayerClient,
            publicClient,
            token: token.address,
            payTo: FIXED_VENDOR,
            amount: 1_000_000n,
        });
    }
    const vendorBalance = await publicClient.readContract({
        address: token.address,
        abi: token.abi,
        functionName: "balanceOf",
        args: [FIXED_VENDOR],
    });
    if (vendorBalance !== 3_000_000n) {
        throw new Error(`period happy path transferred ${vendorBalance}, expected 3000000`);
    }

    let limitRejected = false;
    try {
        await settleLeaf({
            provider,
            environment,
            client: relayerClient,
            publicClient,
            token: token.address,
            payTo: FIXED_VENDOR,
            amount: 1n,
        });
    } catch {
        limitRejected = true;
    }
    if (!limitRejected) throw new Error("fourth payment crossed the parent period cap");
    console.log("[local] parent period overflow rejected");

    const vendorPolicy = {
        ...D3_POLICIES["vendor-agent"],
        token: token.address,
    };
    const vendorUnsigned = preparePeriodDelegation({
        environment,
        delegator: ownerAccount.address,
        delegate: agent.address,
        policy: vendorPolicy,
        startDate,
    });
    const vendorRootSignature = await ownerAccount.signDelegation({
        delegation: vendorUnsigned,
        chainId: anvil.id,
    });
    const vendorProvider = createMapaeDelegationProvider({
        account: agent,
        environment,
        parentPermissionContext: encodeDelegations([
            withDelegationSignature(vendorUnsigned, vendorRootSignature),
        ]),
        facilitatorAddresses: [relayer.address],
    });
    let recipientRejected = false;
    try {
        await settleLeaf({
            provider: vendorProvider,
            environment,
            client: relayerClient,
            publicClient,
            token: token.address,
            payTo: WRONG_PAYEE,
            amount: 1n,
        });
    } catch {
        recipientRejected = true;
    }
    if (!recipientRejected) throw new Error("fixed-vendor parent accepted a wrong recipient");
    console.log("[local] fixed-vendor recipient mismatch rejected");
    console.log("[local] D3/D4 framework integration PASS");
}

async function deployMockUsdc(
    client: ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>,
    publicClient: ReturnType<typeof createPublicClient>,
) {
    const artifact = (await Bun.file(
        "../../contracts/out/MockUSDC.sol/MockUSDC.json",
    ).json()) as {
        abi: Abi;
        bytecode: {object: Hex};
    };
    const hash = await client.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [],
        account: client.account!,
        chain: anvil,
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (!receipt.contractAddress) throw new Error("MockUSDC deployment returned no address");
    return {address: getAddress(receipt.contractAddress), abi: artifact.abi};
}

async function settleLeaf(params: {
    provider: ReturnType<typeof createMapaeDelegationProvider>;
    environment: Awaited<ReturnType<typeof deploySmartAccountsEnvironment>>;
    client: ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>;
    publicClient: ReturnType<typeof createPublicClient>;
    token: Address;
    payTo: Address;
    amount: bigint;
}): Promise<Hex> {
    const leaf = await params.provider({
        scheme: "exact",
        network: `eip155:${anvil.id}`,
        asset: params.token,
        amount: params.amount.toString(),
        payTo: params.payTo,
        maxTimeoutSeconds: 60,
        extra: {assetTransferMethod: "erc7710", facilitatorAddresses: [params.client.account!.address]},
    });
    const execution = createExecution({
        target: params.token,
        value: 0n,
        callData: encodeFunctionData({
            abi: [
                {
                    type: "function",
                    name: "transfer",
                    stateMutability: "nonpayable",
                    inputs: [
                        {name: "to", type: "address"},
                        {name: "amount", type: "uint256"},
                    ],
                    outputs: [{name: "", type: "bool"}],
                },
            ],
            functionName: "transfer",
            args: [params.payTo, params.amount],
        }),
    });
    const simulation = await DelegationManager.simulate.redeemDelegations({
        client: params.client,
        delegationManagerAddress: getAddress(params.environment.DelegationManager),
        delegations: [leaf.permissionContext],
        modes: [ExecutionMode.SingleDefault],
        executions: [[execution]],
    });
    const hash = await params.client.writeContract({
        ...simulation.request,
        account: params.client.account!,
        chain: anvil,
    });
    const receipt = await params.publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error("local redemption reverted");
    return hash;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
