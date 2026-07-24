/**
 * Chain-parameterized negative-path suite for the D3/D4 delegation flow (audit item 4).
 *
 * Every case exercises the REAL Framework caveat enforcers — not mocks — and asserts the
 * exact on-chain revert reason (or an off-chain validator rejection). Two targets:
 *
 *   SUITE_TARGET=ephemeral (default)  spawn Anvil, deploy the pinned 38-unit Framework
 *                                     + MockUSDC fresh. Hermetic, no external RPC.
 *   SUITE_TARGET=fork                 spawn Anvil forked from GIWA (GIWA_SEPOLIA_RPC_URL),
 *                                     reuse the deployed Framework from the active artifact.
 *                                     "real-Framework" evidence on the actual bytecode.
 *
 * The chain id is read from the node and threaded through every signature and CAIP-2
 * network string, so the same cases run on Anvil (31337) or a GIWA fork (91342). Each
 * case gets its own freshly deployed test owner account (unique salt) so period and
 * revocation state never leak between cases. No production key is ever needed: the owner,
 * agent, manager, and child are all throwaway test keys.
 */
import {
    buildD3Policies,
    buildRevocationCall,
    createMapaeDelegationProvider,
    parseActiveDeploymentArtifactJson,
    preparePeriodDelegation,
    signChildPeriodPermission,
    validateDelegatedPayment,
    withDelegationSignature,
    type PeriodPolicy,
} from "@mapae/delegation";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {EntryPoint as EntryPointBytecode} from "@metamask/delegation-abis/bytecode";
import {
    ExecutionMode,
    Implementation,
    createExecution,
    toMetaMaskSmartAccount,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    deploySmartAccountsEnvironment,
    encodeDelegations,
} from "@metamask/smart-accounts-kit/utils";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, giwaSepolia} from "@mapae/shared";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    encodeFunctionData,
    getAddress,
    http,
    keccak256,
    numberToHex,
    parseAbi,
    publicActions,
    stringToHex,
    toHex,
    type Abi,
    type Account,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {buildErc7710PaymentPayload, type Erc7710PaymentRequirements} from "@mapae/shared";
import {X402_VERSION} from "@mapae/shared";

// ── keys (throwaway test identities) ──────────────────────────────────────────
// ANVIL_KEY_0/1 are the standard Anvil dev keys — used only as the relayer / wrong
// relayer (the redeem tx sender), never as a delegation signer, and Anvil pre-funds
// them with ETH on both a fresh node and a fork.
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
// The signer identities (owner / agent / manager / children) must be EOAs the
// DelegationManager validates via ecrecover. On a fork of a live chain the well-known
// low-entropy test keys (0x…011‑0x…015) are unusable: GIWA carries EIP-7702 delegation
// designators (0xef0100…) at those addresses, so the manager sees code, routes their
// signature check to ERC-1271, gets a non-magic answer, and reverts empty. Derive the
// signer keys from a suite-specific seed instead — high-entropy addresses that are
// empty on any real chain, so ecrecover is the path taken on ephemeral and fork alike.
const signerKey = (label: string) =>
    keccak256(stringToHex(`mapae.negative-path-suite.v1.${label}`)) as Hex;
const OWNER_KEY = signerKey("owner");
const AGENT_KEY = signerKey("agent");
const MANAGER_KEY = signerKey("manager");
const CHILD_A_KEY = signerKey("child-a");
const CHILD_B_KEY = signerKey("child-b");
const FIXED_VENDOR = getAddress("0x2000000000000000000000000000000000000002");
const WRONG_PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const OTHER_PAYEE = getAddress("0x2000000000000000000000000000000000000003");

type RelayerClient = WalletClient<ReturnType<typeof http>, Chain, Account> &
    ReturnType<typeof publicActions>;

interface Ctx {
    chain: Chain;
    chainId: number;
    rpcUrl: string;
    publicClient: PublicClient;
    relayer: RelayerClient;
    relayerAddress: Address;
    wrongRelayer: RelayerClient;
    wrongRelayerAddress: Address;
    environment: SmartAccountsEnvironment;
    token: Address;
    tokenAbi: Abi;
    policies: ReturnType<typeof buildD3Policies>;
}

// ── revert decoding ───────────────────────────────────────────────────────────
// The Framework enforcers revert with Error(string) reasons ("TimestampEnforcer:…");
// the DelegationManager and the account's ERC-1271 path revert with *custom* errors
// (e.g. InvalidSignature). Surface both so a caveat rejection and a signature failure
// are never confused — that distinction is the whole point of a fork run.
function decodeRevert(error: unknown): string {
    let cur: unknown = error;
    let depth = 0;
    while (cur instanceof Error && depth < 12) {
        const any = cur as unknown as {
            errorName?: unknown;
            args?: unknown;
            reason?: unknown;
            signature?: unknown;
            data?: {errorName?: unknown; args?: unknown};
            details?: unknown;
            cause?: unknown;
        };
        // Error(string) — the enforcer reason strings
        if (any.errorName === "Error" && Array.isArray(any.args) && typeof any.args[0] === "string") {
            return any.args[0];
        }
        if (typeof any.reason === "string" && any.reason) return any.reason;
        // Decoded custom error (ContractFunctionRevertedError.data)
        if (any.data && typeof any.data.errorName === "string") {
            const named = any.data.errorName;
            const args = Array.isArray(any.data.args) && any.data.args.length
                ? `(${any.data.args.map(String).join(",")})`
                : "";
            return `${named}${args}`;
        }
        // Undecodable custom error — surface the 4-byte selector so it's still diagnosable
        if (typeof any.signature === "string" && any.signature) return `custom error ${any.signature}`;
        if (typeof any.errorName === "string" && any.errorName) return any.errorName as string;
        if (typeof any.details === "string") {
            const m = any.details.match(/reverted:?\s*(.*)/i);
            if (m && m[1]) return m[1].trim();
            if (any.details) return any.details;
        }
        cur = any.cause;
        depth += 1;
    }
    if (error instanceof Error) {
        const short = (error as unknown as {shortMessage?: string}).shortMessage;
        return (short ?? error.message).split("\n")[0]!;
    }
    return String(error);
}

// ── raw JSON-RPC (Anvil cheatcodes) ───────────────────────────────────────────
async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
    const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
    });
    const body = (await res.json()) as {result?: unknown; error?: {message: string}};
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
}

// ── Anvil lifecycle ───────────────────────────────────────────────────────────
async function spawnAnvil(forkUrl: string | undefined, port: number): Promise<() => void> {
    const args = ["--port", String(port), "--silent"];
    if (forkUrl) args.push("--fork-url", forkUrl);
    const proc = Bun.spawn(["anvil", ...args], {stdout: "ignore", stderr: "pipe"});
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        try {
            await rpc(url, "eth_chainId");
            return () => proc.kill();
        } catch {
            /* not ready yet */
        }
    }
    proc.kill();
    throw new Error("anvil did not become ready");
}

// ── target acquisition ────────────────────────────────────────────────────────
async function acquireContext(): Promise<{ctx: Ctx; stop: () => void}> {
    const target = process.env.SUITE_TARGET?.trim() || "ephemeral";
    const port = Number(process.env.SUITE_ANVIL_PORT ?? "8546");
    const external = process.env.SUITE_RPC_URL?.trim();

    let stop = () => {};
    let rpcUrl: string;
    if (external) {
        rpcUrl = external;
    } else if (target === "fork") {
        const forkUrl = process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
        stop = await spawnAnvil(forkUrl, port);
        rpcUrl = `http://127.0.0.1:${port}`;
    } else {
        stop = await spawnAnvil(undefined, port);
        rpcUrl = `http://127.0.0.1:${port}`;
    }

    const chainId = Number(BigInt((await rpc(rpcUrl, "eth_chainId")) as string));
    const chain = defineChain({
        id: chainId,
        name: `mapae-negative-${chainId}`,
        nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
        rpcUrls: {default: {http: [rpcUrl]}},
    });
    const publicClient = createPublicClient({chain, transport: http(rpcUrl)}) as PublicClient;
    const relayerAccount = privateKeyToAccount(ANVIL_KEY_0);
    const wrongRelayerAccount = privateKeyToAccount(ANVIL_KEY_1);
    const relayer = createWalletClient({account: relayerAccount, chain, transport: http(rpcUrl)}).extend(
        publicActions,
    ) as RelayerClient;
    const wrongRelayer = createWalletClient({
        account: wrongRelayerAccount,
        chain,
        transport: http(rpcUrl),
    }).extend(publicActions) as RelayerClient;

    let environment: SmartAccountsEnvironment;
    let token: Address;
    let tokenAbi: Abi;

    if (target === "fork") {
        const artifact = parseActiveDeploymentArtifactJson(
            await Bun.file("../../deployments/giwa-sepolia.framework.json").text(),
        );
        environment = artifact.environment;
        token = MOCK_USDC.address;
        tokenAbi = MINIMAL_ERC20_ABI;
        console.log(`[suite] fork target — real GIWA Framework, chainId ${chainId}`);
    } else {
        console.log(`[suite] ephemeral target — deploying Framework on chainId ${chainId}`);
        const entryPointHash = await relayer.deployContract({
            abi: EntryPointAbi,
            bytecode: EntryPointBytecode,
            args: [],
            account: relayerAccount,
            chain,
        });
        const epReceipt = await publicClient.waitForTransactionReceipt({hash: entryPointHash});
        if (!epReceipt.contractAddress) throw new Error("EntryPoint deploy returned no address");
        environment = await deploySmartAccountsEnvironment(relayer, publicClient, chain, {
            EntryPoint: getAddress(epReceipt.contractAddress),
        });
        const usdc = await deployMockUsdc(relayer, publicClient, chain);
        token = usdc.address;
        tokenAbi = usdc.abi;
    }

    const policies = buildD3Policies(FIXED_VENDOR);
    return {
        ctx: {
            chain,
            chainId,
            rpcUrl,
            publicClient,
            relayer,
            relayerAddress: relayerAccount.address,
            wrongRelayer,
            wrongRelayerAddress: wrongRelayerAccount.address,
            environment,
            token,
            tokenAbi,
            policies,
        },
        stop,
    };
}

const MINIMAL_ERC20_ABI = parseAbi([
    "function mint(address to, uint256 value)",
    "function balanceOf(address) view returns (uint256)",
]) as unknown as Abi;

async function deployMockUsdc(client: RelayerClient, publicClient: PublicClient, chain: Chain) {
    const artifact = (await Bun.file("../../contracts/out/MockUSDC.sol/MockUSDC.json").json()) as {
        abi: Abi;
        bytecode: {object: Hex};
    };
    const hash = await client.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: [],
        account: client.account,
        chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (!receipt.contractAddress) throw new Error("MockUSDC deploy returned no address");
    return {address: getAddress(receipt.contractAddress), abi: artifact.abi};
}

// ── per-case owner account ────────────────────────────────────────────────────
async function freshOwnerAccount(ctx: Ctx, owner: Account, saltLabel: string) {
    const deploySalt = keccak256(stringToHex(saltLabel)) as Hex;
    const account = await toMetaMaskSmartAccount({
        client: ctx.publicClient,
        implementation: Implementation.Hybrid,
        signer: {account: owner},
        environment: ctx.environment,
        deployParams: [owner.address, [], [], []],
        deploySalt,
    });
    const factory = await account.getFactoryArgs();
    if (!factory.factory || !factory.factoryData) throw new Error("no factory args");
    const hash = await ctx.relayer.sendTransaction({
        to: factory.factory,
        data: factory.factoryData,
        value: 0n,
    });
    await ctx.publicClient.waitForTransactionReceipt({hash});
    const code = await ctx.publicClient.getCode({address: account.address});
    if (!code || code === "0x") throw new Error("owner account not deployed");
    // fund it with mUSDC via the permissionless faucet
    const mintHash = await ctx.relayer.writeContract({
        address: ctx.token,
        abi: ctx.tokenAbi,
        functionName: "mint",
        args: [account.address, 1_000_000_000n],
    });
    await ctx.publicClient.waitForTransactionReceipt({hash: mintHash});
    return account;
}

function requirements(ctx: Ctx, payTo: Address, amount: bigint): Erc7710PaymentRequirements {
    return {
        scheme: "exact",
        network: `eip155:${ctx.chainId}`,
        asset: ctx.token,
        amount: amount.toString(),
        payTo,
        // 300s (the validator max) so leaves survive the period-reset case's evm_increaseTime,
        // which permanently advances the node clock ahead of the wall-clock the leaf expiry uses.
        maxTimeoutSeconds: 300,
        extra: {assetTransferMethod: "erc7710", facilitatorAddresses: [ctx.relayerAddress]},
    };
}

async function buildLeaf(
    ctx: Ctx,
    agentKey: Hex,
    parentPermissionContext: Hex,
    payTo: Address,
    amount: bigint,
) {
    const provider = createMapaeDelegationProvider({
        account: privateKeyToAccount(agentKey),
        environment: ctx.environment,
        parentPermissionContext,
        facilitatorAddresses: [ctx.relayerAddress],
    });
    return provider(requirements(ctx, payTo, amount));
}

const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

function redeemArgs(ctx: Ctx, leafContext: Hex, payTo: Address, amount: bigint) {
    const execution = createExecution({
        target: ctx.token,
        value: 0n,
        callData: encodeFunctionData({
            abi: TRANSFER_ABI,
            functionName: "transfer",
            args: [payTo, amount],
        }),
    });
    return {
        delegationManagerAddress: getAddress(ctx.environment.DelegationManager),
        delegations: [leafContext] as Hex[],
        modes: [ExecutionMode.SingleDefault],
        executions: [[execution]],
    };
}

/** Simulate a redemption; returns nothing on success, throws on revert. */
async function simulateRedeem(
    ctx: Ctx,
    client: RelayerClient,
    leafContext: Hex,
    payTo: Address,
    amount: bigint,
) {
    await DelegationManager.simulate.redeemDelegations({
        client,
        ...redeemArgs(ctx, leafContext, payTo, amount),
    });
}

/** Execute a real redemption; throws if it reverts. */
async function settle(
    ctx: Ctx,
    leafContext: Hex,
    payTo: Address,
    amount: bigint,
): Promise<void> {
    const sim = await DelegationManager.simulate.redeemDelegations({
        client: ctx.relayer,
        ...redeemArgs(ctx, leafContext, payTo, amount),
    });
    const hash = await ctx.relayer.writeContract({
        ...sim.request,
        account: ctx.relayer.account,
        chain: ctx.chain,
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error("redemption reverted on chain");
}

async function signedRoot(
    ctx: Ctx,
    ownerAccount: Awaited<ReturnType<typeof freshOwnerAccount>>,
    delegate: Address,
    policy: PeriodPolicy,
    startDate: number,
): Promise<Hex> {
    const unsigned = preparePeriodDelegation({
        environment: ctx.environment,
        delegator: ownerAccount.address,
        delegate,
        policy: {...policy, token: ctx.token},
        startDate,
    });
    const signature = await ownerAccount.signDelegation({delegation: unsigned, chainId: ctx.chainId});
    return encodeDelegations([withDelegationSignature(unsigned, signature)]);
}

async function chainNow(ctx: Ctx): Promise<number> {
    return Number((await ctx.publicClient.getBlock()).timestamp);
}

// ── test harness ──────────────────────────────────────────────────────────────
interface Result {
    name: string;
    ok: boolean;
    detail: string;
}
const results: Result[] = [];

async function testCase(name: string, fn: () => Promise<string>): Promise<void> {
    try {
        const detail = await fn();
        results.push({name, ok: true, detail});
        console.log(`  ✓ ${name} — ${detail}`);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        results.push({name, ok: false, detail});
        console.log(`  ✗ ${name} — ${detail}`);
    }
}

async function expectRevert(
    label: string,
    expected: string | undefined,
    fn: () => Promise<unknown>,
): Promise<string> {
    try {
        await fn();
    } catch (error) {
        const reason = decodeRevert(error);
        if (expected && !reason.includes(expected)) {
            throw new Error(`reverted with "${reason}", expected to contain "${expected}"`);
        }
        return reason;
    }
    throw new Error(`${label}: expected a revert but the call succeeded`);
}

// ── cases ─────────────────────────────────────────────────────────────────────
async function run(ctx: Ctx): Promise<void> {
    const owner = privateKeyToAccount(OWNER_KEY);
    const agent = privateKeyToAccount(AGENT_KEY);
    const openPolicy = ctx.policies["open-agent"]; // 3 mUSDC / 60s
    const vendorPolicy = ctx.policies["vendor-agent"]; // 5 mUSDC / 60s, fixed recipient

    // baseline happy path — proves the positive flow before the negatives
    await testCase("happy: 3×1mUSDC settles under 3/60s cap", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "happy");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        for (let i = 0; i < 3; i += 1) {
            const leaf = await buildLeaf(ctx, AGENT_KEY, root, FIXED_VENDOR, 1_000_000n);
            await settle(ctx, leaf.permissionContext, FIXED_VENDOR, 1_000_000n);
        }
        const bal = (await ctx.publicClient.readContract({
            address: ctx.token,
            abi: MINIMAL_ERC20_ABI,
            functionName: "balanceOf",
            args: [FIXED_VENDOR],
        })) as bigint;
        if (bal < 3_000_000n) throw new Error(`vendor received ${bal}, expected ≥ 3000000`);
        return "3 mUSDC transferred";
    });

    await testCase("period-cap: 4th payment exceeds 3/60s", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "cap");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        for (let i = 0; i < 3; i += 1) {
            const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
            await settle(ctx, leaf.permissionContext, OTHER_PAYEE, 1_000_000n);
        }
        const overflow = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        return expectRevert("period-cap", "ERC20PeriodTransferEnforcer", () =>
            simulateRedeem(ctx, ctx.relayer, overflow.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("period-reset: cap refreshes after the period elapses", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "reset");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        for (let i = 0; i < 3; i += 1) {
            const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
            await settle(ctx, leaf.permissionContext, OTHER_PAYEE, 1_000_000n);
        }
        await rpc(ctx.rpcUrl, "evm_increaseTime", [61]);
        await rpc(ctx.rpcUrl, "evm_mine", []);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        await settle(ctx, leaf.permissionContext, OTHER_PAYEE, 1_000_000n);
        return "settled again in the next period";
    });

    await testCase("expiry: expired root is rejected", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "expiry");
        const now = await chainNow(ctx);
        const expiredPolicy = {...openPolicy, expiresAfterSeconds: 3600};
        const root = await signedRoot(ctx, acct, agent.address, expiredPolicy, now - 7200);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        return expectRevert("expiry", "TimestampEnforcer", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("wrong-redeemer: non-allowlisted caller is rejected", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "redeemer");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        // leaf is scoped to ctx.relayer; redeem from wrongRelayer must fail
        return expectRevert("wrong-redeemer", undefined, () =>
            simulateRedeem(ctx, ctx.wrongRelayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("recipient-mismatch: fixed-vendor parent rejects other payee", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "recipient");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, vendorPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, WRONG_PAYEE, 1_000_000n);
        return expectRevert("recipient-mismatch", undefined, () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, WRONG_PAYEE, 1_000_000n),
        );
    });

    await testCase("replay: exact-context leaf cannot be redeemed twice", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "replay");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 2_000_000n);
        await settle(ctx, leaf.permissionContext, OTHER_PAYEE, 2_000_000n);
        // The payment-specific leaf carries a one-shot ERC20TransferAmount allowance equal
        // to the exact payment, so redeeming the identical context again is refused.
        return expectRevert("replay", "ERC20TransferAmountEnforcer", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 2_000_000n),
        );
    });

    await testCase("payer-mismatch: off-chain validator rejects a forged delegator", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "payer");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        // validateDelegatedPayment is the pure GIWA trust-boundary validator: it hardcodes
        // the GIWA network and MockUSDC asset, so feed it a GIWA-shaped requirement to reach
        // the payer-binding branch regardless of which chain the leaf was signed for.
        const req: Erc7710PaymentRequirements = {
            scheme: "exact",
            network: GIWA_SEPOLIA_CAIP2,
            asset: MOCK_USDC.address,
            amount: "1000000",
            payTo: OTHER_PAYEE,
            maxTimeoutSeconds: 60,
            extra: {assetTransferMethod: "erc7710", facilitatorAddresses: [ctx.relayerAddress]},
        };
        const forged = buildErc7710PaymentPayload({
            accepted: req,
            delegationManager: getAddress(leaf.delegationManager),
            permissionContext: leaf.permissionContext,
            delegator: WRONG_PAYEE, // claim a delegator that isn't the signed root payer
        });
        let threw = "";
        try {
            validateDelegatedPayment(
                {x402Version: X402_VERSION, paymentPayload: forged, paymentRequirements: req},
                {
                    delegationManager: getAddress(leaf.delegationManager),
                    facilitator: ctx.relayerAddress,
                    maxAmount: 10_000_000n,
                },
            );
        } catch (error) {
            threw = error instanceof Error ? error.message : String(error);
        }
        if (!threw.includes("claimed delegator does not match")) {
            throw new Error(`expected payer-binding rejection, got: ${threw || "no error"}`);
        }
        return `rejected: ${threw}`;
    });

    await testCase("root-revocation: disabled root cannot be redeemed", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "revoke");
        const start = (await chainNow(ctx)) - 1;
        const unsigned = preparePeriodDelegation({
            environment: ctx.environment,
            delegator: acct.address,
            delegate: agent.address,
            policy: {...openPolicy, token: ctx.token},
            startDate: start,
        });
        const signature = await acct.signDelegation({delegation: unsigned, chainId: ctx.chainId});
        const signedDelegation = withDelegationSignature(unsigned, signature);
        const root = encodeDelegations([signedDelegation]);
        // revoke via a self-call, impersonating the owner smart account (Anvil cheat)
        const call = buildRevocationCall(signedDelegation);
        await rpc(ctx.rpcUrl, "anvil_setBalance", [acct.address, numberToHex(10n ** 18n)]);
        await rpc(ctx.rpcUrl, "anvil_impersonateAccount", [acct.address]);
        const revoker = createWalletClient({
            account: acct.address,
            chain: ctx.chain,
            transport: http(ctx.rpcUrl),
        });
        const revokeHash = await revoker.sendTransaction({
            to: call.to,
            data: call.data,
            value: 0n,
            account: acct.address,
            chain: ctx.chain,
        });
        await ctx.publicClient.waitForTransactionReceipt({hash: revokeHash});
        await rpc(ctx.rpcUrl, "anvil_stopImpersonatingAccount", [acct.address]);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        return expectRevert("root-revocation", undefined, () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("manager-aggregate: two children cannot exceed the manager bucket", async () => {
        const manager = privateKeyToAccount(MANAGER_KEY);
        const childA = privateKeyToAccount(CHILD_A_KEY);
        const childB = privateKeyToAccount(CHILD_B_KEY);
        const acct = await freshOwnerAccount(ctx, owner, "aggregate");
        const start = (await chainNow(ctx)) - 1;
        // root: owner → manager, 6 mUSDC / 60s aggregate
        const managerRoot = await signedRoot(
            ctx,
            acct,
            manager.address,
            ctx.policies["team-manager"],
            start,
        );
        // manager re-delegates to child-a (4) and child-b (4)
        const childAPerm = await signChildPeriodPermission({
            managerPrivateKey: MANAGER_KEY,
            managerAddress: manager.address,
            childAddress: childA.address,
            parentPermissionContext: managerRoot,
            environment: ctx.environment,
            policy: {...ctx.policies["child-a"], token: ctx.token},
            startDate: start,
            chainId: ctx.chainId,
        });
        const childBPerm = await signChildPeriodPermission({
            managerPrivateKey: MANAGER_KEY,
            managerAddress: manager.address,
            childAddress: childB.address,
            parentPermissionContext: managerRoot,
            environment: ctx.environment,
            policy: {...ctx.policies["child-b"], token: ctx.token},
            startDate: start,
            chainId: ctx.chainId,
        });
        // child-a settles 4 (manager bucket now 4/6)
        const leafA = await buildLeaf(ctx, CHILD_A_KEY, childAPerm.permissionContext, OTHER_PAYEE, 4_000_000n);
        await settle(ctx, leafA.permissionContext, OTHER_PAYEE, 4_000_000n);
        // child-b tries 4 — within its own 4 cap, but manager aggregate would be 8 > 6
        const leafB = await buildLeaf(ctx, CHILD_B_KEY, childBPerm.permissionContext, OTHER_PAYEE, 4_000_000n);
        return expectRevert("manager-aggregate", "ERC20PeriodTransferEnforcer", () =>
            simulateRedeem(ctx, ctx.relayer, leafB.permissionContext, OTHER_PAYEE, 4_000_000n),
        );
    });
}

async function main(): Promise<void> {
    const {ctx, stop} = await acquireContext();
    try {
        console.log(`[suite] running negative-path cases on chainId ${ctx.chainId}\n`);
        await run(ctx);
    } finally {
        stop();
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n[suite] ${results.length - failed.length}/${results.length} cases passed`);
    if (failed.length > 0) {
        console.log("[suite] FAILED:");
        for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
        process.exitCode = 1;
    } else {
        console.log("[suite] all negative-path cases PASS");
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
