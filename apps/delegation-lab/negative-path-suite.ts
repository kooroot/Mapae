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
    buildRevocationUserOperation,
    createMapaeDelegationProvider,
    DEFAULT_REVOCATION_GAS,
    finalizeRevocationUserOperation,
    isDelegationRevoked,
    judgeSubmissionReadiness,
    parseActiveDeploymentArtifactJson,
    preparePeriodDelegation,
    readRevocationNonce,
    readRevocationPrefundState,
    signChildPeriodPermission,
    validateDelegatedPayment,
    validateRevocationSubmission,
    withDelegationSignature,
    type PeriodPolicy,
} from "@mapae/delegation";
import {EntryPoint as EntryPointAbi, HybridDeleGator as HybridDeleGatorAbi} from "@metamask/delegation-abis";
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
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, giwaSepolia, redactUrls} from "@mapae/shared";
import {startForkSourceProxy} from "./fork-source-proxy";
import {
    createPublicClient,
    decodeErrorResult,
    createWalletClient,
    defineChain,
    encodeFunctionData,
    getAddress,
    http,
    keccak256,
    numberToHex,
    parseAbi,
    parseEventLogs,
    publicActions,
    stringToHex,
    zeroAddress,
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
// handleOps beneficiary. Deliberately NOT the relayer, and the reason is not what it
// first looks like.
//
// An earlier note here blamed Anvil for losing the local 10000 ETH dev-account override
// when the EntryPoint credits that account mid-transaction. That was measured and is
// false. The real mechanism is on the chain, not in Anvil: `ANVIL_KEY_0`/`_1` both carry
// an EIP-7702 designator on GIWA (`0xef0100…6bd9b715…89606`) pointing at a 614-byte
// sweeper. `EntryPoint._compensate` pays the beneficiary with `beneficiary.call{value:…}`,
// which runs that code, and it forwards the account's whole balance onward.
//
// `debug_traceTransaction` settles it — the balance leaves in a nested CALL to
// `0x1330d9…7d8869`, which an override-loss would never produce. Measured on a fork:
// relayer 1 ETH → 0.00024 ETH in the handleOps block, against a 0.00017 ETH transaction.
//
// The distinction matters because it changes the fix. If Anvil were at fault the problem
// would be local-only; it is not, so a beneficiary must be an address with no code on the
// *target chain*, and `assertBeneficiaryIsCodeFree` enforces exactly that rather than
// leaving it to this comment.
const BENEFICIARY = getAddress("0x2000000000000000000000000000000000000004");

/**
 * Refuse to start if the beneficiary would execute code on being paid.
 *
 * Without this the failure surfaces several cases later as "total cost exceeds balance",
 * which reads like the suite spending too much and sends you to look at gas parameters.
 */
async function assertBeneficiaryIsCodeFree(publicClient: PublicClient): Promise<void> {
    const code = await publicClient.getCode({address: BENEFICIARY});
    if (code !== undefined) {
        throw new Error(
            `handleOps beneficiary ${BENEFICIARY} carries code on this chain — ` +
                "EntryPoint._compensate would execute it and the payout can be swept",
        );
    }
}

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
/** Decode a raw revert payload against the EntryPoint ABI; undefined if it is not one. */
function decodeEntryPointError(data: Hex): string | undefined {
    try {
        const {errorName, args} = decodeErrorResult({abi: EntryPointAbi, data});
        const rendered = args && args.length ? `(${args.map(String).join(",")})` : "";
        return `${errorName}${rendered}`;
    } catch {
        return undefined;
    }
}

function decodeRevert(error: unknown): string {
    // Two passes over the cause chain, deliberately. The outermost error carries a
    // `details` string that always matches ("execution reverted: custom error 0x…"),
    // while the decodable payload sits several levels down — so a single pass that
    // accepts `details` reports a bare selector for errors it could have named.
    const chain: Record<string, unknown>[] = [];
    let cur: unknown = error;
    while (cur instanceof Error && chain.length < 12) {
        const node = cur as unknown as Record<string, unknown>;
        chain.push(node);
        cur = node["cause"];
    }

    for (const node of chain) {
        // Error(string) — the enforcer reason strings
        if (node["errorName"] === "Error" && Array.isArray(node["args"]) && typeof node["args"][0] === "string") {
            return node["args"][0] as string;
        }
        if (typeof node["reason"] === "string" && node["reason"]) return node["reason"] as string;
        // Decoded custom error (ContractFunctionRevertedError.data)
        const data = node["data"];
        if (data && typeof data === "object") {
            const named = (data as {errorName?: unknown}).errorName;
            if (typeof named === "string") {
                const dataArgs = (data as {args?: unknown}).args;
                const rendered = Array.isArray(dataArgs) && dataArgs.length
                    ? `(${dataArgs.map(String).join(",")})`
                    : "";
                return `${named}${rendered}`;
            }
        }
        // Raw payload (RpcRequestError.data is a hex string). The EntryPoint's FailedOp
        // only ever arrives this way: no layer above it holds the ABI, so decoding it
        // here is what turns an AA-code assertion into a named error instead of a
        // substring match against undecoded bytes.
        if (typeof data === "string" && data.startsWith("0x") && data.length > 10) {
            const decoded = decodeEntryPointError(data as Hex);
            if (decoded) return decoded;
        }
    }

    // Nothing was decodable — fall back to whatever text is available.
    for (const node of chain) {
        if (typeof node["signature"] === "string" && node["signature"]) {
            return `custom error ${node["signature"] as string}`;
        }
        if (typeof node["errorName"] === "string" && node["errorName"]) return node["errorName"] as string;
        if (typeof node["details"] === "string") {
            const m = (node["details"] as string).match(/reverted:?\s*(.*)/i);
            if (m && m[1]) return m[1].trim();
            if (node["details"]) return node["details"] as string;
        }
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
/**
 * The readiness probe below cannot tell our Anvil from someone else's. If anything is
 * already listening on the port, the new Anvil fails to bind, `eth_chainId` is answered
 * by the *other* node, and the probe reports success — so the suite runs its cases
 * against a chain it did not create. Two consecutive fork runs have the same chain id,
 * so nothing downstream would notice. Evidence that can silently come from the wrong
 * chain is not evidence, which is the whole point of this file.
 */
function assertPortFree(port: number): void {
    try {
        Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(true);
    } catch {
        throw new Error(
            `port ${port} is already in use, so this run's Anvil cannot start. A node from ` +
                "an earlier run is probably still alive; this run would otherwise redeem " +
                "against it and report the result as fresh. Kill it, or set SUITE_ANVIL_PORT.",
        );
    }
}

/**
 * GIWA Sepolia block the fork target pins to. Verified to carry code for the
 * DelegationManager, the canonical v0.7 EntryPoint, and MockUSDC. Override with
 * SUITE_FORK_BLOCK when the pin needs to move.
 */
const FORK_BLOCK = 31_606_000;

/**
 * Every node this process started, torn down from one place.
 *
 * Handing the caller a `stop` it must remember to call is not enough: anything that
 * throws between `spawnAnvil` returning and `stop` reaching the caller leaks the node.
 * That is not hypothetical — a guard added to `acquireContext` did exactly this, and the
 * run did not merely leave an orphan, it **hung indefinitely**, because Bun will not exit
 * while a spawned child is alive. The visible symptom is a suite that produces no output
 * and never returns, which looks nothing like the error that actually occurred.
 *
 * Registering at spawn time covers every failure path, including ones added later that
 * nobody thought to wrap.
 */
const teardowns: Array<() => void> = [];

function runTeardowns(): void {
    // `splice` empties the list, so calling this twice is safe — `main` runs it in a
    // `finally` and the top-level handler runs it again for failures that happen before
    // that `finally` is ever entered.
    for (const teardown of teardowns.splice(0)) {
        try {
            teardown();
        } catch {
            /* already gone */
        }
    }
}

async function spawnAnvil(forkUrl: string | undefined, port: number): Promise<() => void> {
    assertPortFree(port);
    const args = ["--port", String(port), "--silent"];
    // The fork source's API key lives in the URL *path*, and argv is world-readable
    // through `ps`. `--fork-url` has no env alias, so the credential is handed to a
    // loopback proxy that keeps it in memory and gives anvil a keyless address instead.
    // Measured both ways: `pgrep -f` finds the key with the URL passed directly and finds
    // nothing through the proxy.
    const source = forkUrl ? startForkSourceProxy(forkUrl) : undefined;
    if (forkUrl && source) {
        // The public GIWA RPC rate-limits, and Anvil does not degrade gracefully: an
        // upstream 429 during a storage fetch panics the node mid-suite
        // ("pre-execution changes failed: … over rate limit"). Every later case then
        // reports "Unable to connect", which reads like a local network fault and sends
        // you looking in the wrong place. Throttle Anvil's own upstream rate and let it
        // back off instead of dying. SUITE_CUPS raises it for a private endpoint.
        args.push("--fork-url", source.url);
        args.push("--compute-units-per-second", process.env["SUITE_CUPS"]?.trim() || "50");
        args.push("--retries", "30");
        args.push("--fork-retry-backoff", "4");
        // Pin the fork block. Two reasons, both load-bearing: an unpinned fork follows
        // `latest`, so Anvil's on-disk cache key changes every run and every run pays the
        // full upstream cost against a rate-limited endpoint; and a moving fork point
        // makes a failure impossible to reproduce. The pin only has to be a block where
        // the Framework, the canonical EntryPoint, and MockUSDC all have code.
        args.push("--fork-block-number", process.env["SUITE_FORK_BLOCK"]?.trim() || String(FORK_BLOCK));
    }
    const proc = Bun.spawn(["anvil", ...args], {stdout: "ignore", stderr: "pipe"});
    // Drain stderr into a buffer. Anvil's panic message is the only place the real cause
    // is written; discarding it is why the rate-limit crash above looked like a network
    // fault for as long as it did.
    let stderr = "";
    void (async () => {
        try {
            for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
                stderr += new TextDecoder().decode(chunk);
            }
        } catch {
            /* the pipe closes when the child is killed */
        }
    })();
    const died = () => {
        // Redacted, because this is the one place the fork URL comes back at us. Anvil
        // quotes the endpoint it failed to reach, and a private endpoint carries its API
        // key in the path — so the diagnostic that exists to make a rate-limit crash
        // legible would otherwise print a credential to the terminal and into CI logs.
        const tail = redactUrls(stderr.trim()).split("\n").slice(-6).join("\n");
        return tail ? `\nanvil said:\n${tail}` : "";
    };

    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        // A node that answered once and then died mid-suite produces "Unable to connect"
        // on every later call, which reads like a network fault rather than a dead child.
        if (proc.killed || proc.exitCode !== null) {
            throw new Error(`anvil exited before becoming ready (code ${proc.exitCode})${died()}`);
        }
        try {
            await rpc(url, "eth_chainId");
            const stop = () => {
                if (proc.exitCode !== null && proc.exitCode !== 0) {
                    console.error(`[suite] anvil exited with code ${proc.exitCode}${died()}`);
                }
                proc.kill();
                source?.stop();
            };
            // Registered here, not by the caller: the gap this closes is precisely the one
            // between this return and the caller storing the handle.
            teardowns.push(stop);
            return stop;
        } catch {
            /* not ready yet */
        }
    }
    proc.kill();
    throw new Error(`anvil did not become ready${died()}`);
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

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/**
 * A redemption whose execution deliberately does NOT match the leaf it carries.
 *
 * This is the mechanism the facilitator trust boundary rests on: `redeemDelegations`
 * takes `_executionCallDatas` as calldata from the caller (DelegationManager.sol:126-133),
 * so the execution is chosen at redemption time and is not part of anything the payer or
 * the agent signed. An allowlisted facilitator is free to submit any execution it likes
 * alongside a perfectly valid leaf. The only thing standing between it and an arbitrary
 * transfer out of the payer's smart account is the caveat set on that leaf.
 *
 * The `wrong-redeemer` case above does not cover this: it proves a *stranger* cannot
 * redeem. The facilitator is not a stranger — it is the address the leaf pins as its
 * redeemer. These cases are the payer's protection *from the party it authorized*.
 */
async function simulateTamperedRedeem(
    ctx: Ctx,
    leafContext: Hex,
    tampered: {target?: Address; value?: bigint; callData?: Hex},
) {
    const execution = createExecution({
        target: tampered.target ?? ctx.token,
        value: tampered.value ?? 0n,
        callData:
            tampered.callData ??
            encodeFunctionData({
                abi: TRANSFER_ABI,
                functionName: "transfer",
                args: [FIXED_VENDOR, 1_000_000n],
            }),
    });
    await DelegationManager.simulate.redeemDelegations({
        client: ctx.relayer,
        delegationManagerAddress: getAddress(ctx.environment.DelegationManager),
        delegations: [leafContext] as Hex[],
        modes: [ExecutionMode.SingleDefault],
        executions: [[execution]],
    });
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
        return expectRevert("period-cap", "ERC20PeriodTransferEnforcer:transfer-amount-exceeded", () =>
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
        return expectRevert("expiry", "TimestampEnforcer:expired-delegation", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("wrong-redeemer: non-allowlisted caller is rejected", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "redeemer");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        // leaf is scoped to ctx.relayer; redeem from wrongRelayer must fail
        return expectRevert("wrong-redeemer", "RedeemerEnforcer:unauthorized-redeemer", () =>
            simulateRedeem(ctx, ctx.wrongRelayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    await testCase("recipient-mismatch: fixed-vendor parent rejects other payee", async () => {
        const acct = await freshOwnerAccount(ctx, owner, "recipient");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, vendorPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, WRONG_PAYEE, 1_000_000n);
        return expectRevert("recipient-mismatch", "AllowedCalldataEnforcer:invalid-calldata", () =>
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
        return expectRevert("replay", "ERC20TransferAmountEnforcer:allowance-exceeded", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 2_000_000n),
        );
    });

    // ── facilitator trust boundary ────────────────────────────────────────────
    // Threat model: the facilitator is fully compromised. It holds the relayer key, it
    // holds a valid X-PAYMENT the agent signed (1 mUSDC → FIXED_VENDOR), and it is the
    // redeemer that leaf pins — so every identity check passes. It then submits an
    // execution of its own choosing. Each case names one way it could profit and asserts
    // the enforcer that refuses it, by exact revert string.
    const hostileLeaf = async (label: string) => {
        const acct = await freshOwnerAccount(ctx, owner, label);
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        return buildLeaf(ctx, AGENT_KEY, root, FIXED_VENDOR, 1_000_000n);
    };

    // The control for the five cases below. Without it each of them could be reverting
    // for a reason that has nothing to do with tampering — an exhausted period, a stale
    // account, a mis-scoped redeemer — and the suite would still print five green ticks.
    // Same helper, same leaf shape, same relayer; the ONLY difference in the five cases
    // that follow is the execution.
    await testCase("facilitator-control: the untampered execution settles", async () => {
        const leaf = await hostileLeaf("fac-control");
        await simulateTamperedRedeem(ctx, leaf.permissionContext, {});
        return "identical setup succeeds when the execution matches the leaf";
    });

    await testCase("facilitator-redirect: cannot pay itself instead of the vendor", async () => {
        const leaf = await hostileLeaf("fac-redirect");
        // Same token, same amount — only the recipient is swapped for the relayer's own
        // address. The recipient is pinned inside the calldata, not in the signature.
        return expectRevert("facilitator-redirect", "AllowedCalldataEnforcer:invalid-calldata", () =>
            simulateTamperedRedeem(ctx, leaf.permissionContext, {
                callData: encodeFunctionData({
                    abi: TRANSFER_ABI,
                    functionName: "transfer",
                    args: [ctx.relayerAddress, 1_000_000n],
                }),
            }),
        );
    });

    await testCase("facilitator-inflate: cannot enlarge the amount it was handed", async () => {
        const leaf = await hostileLeaf("fac-inflate");
        // Correct recipient, correct token — 3 mUSDC instead of the 1 the agent signed for.
        // Note this is still inside the 3/60s period cap, so the parent would allow it;
        // what refuses it is the leaf's own one-shot allowance.
        return expectRevert(
            "facilitator-inflate",
            "ERC20TransferAmountEnforcer:allowance-exceeded",
            () =>
                simulateTamperedRedeem(ctx, leaf.permissionContext, {
                    callData: encodeFunctionData({
                        abi: TRANSFER_ABI,
                        functionName: "transfer",
                        args: [FIXED_VENDOR, 3_000_000n],
                    }),
                }),
        );
    });

    await testCase("facilitator-approve: cannot convert a payment into an allowance", async () => {
        const leaf = await hostileLeaf("fac-approve");
        // The classic drain: turn a one-shot transfer permission into a standing
        // allowance. Written so every address check still passes — the spender slot holds
        // the pinned vendor — which leaves the selector as the only thing that can refuse
        // it, and it does.
        return expectRevert("facilitator-approve", "ERC20TransferAmountEnforcer:invalid-method", () =>
            simulateTamperedRedeem(ctx, leaf.permissionContext, {
                callData: encodeFunctionData({
                    abi: APPROVE_ABI,
                    functionName: "approve",
                    args: [FIXED_VENDOR, (1n << 256n) - 1n],
                }),
            }),
        );
    });

    await testCase("facilitator-token: cannot point the call at another contract", async () => {
        const leaf = await hostileLeaf("fac-token");
        return expectRevert("facilitator-token", "ERC20TransferAmountEnforcer:invalid-contract", () =>
            simulateTamperedRedeem(ctx, leaf.permissionContext, {target: OTHER_PAYEE}),
        );
    });

    await testCase("facilitator-value: cannot attach native value to the call", async () => {
        const leaf = await hostileLeaf("fac-value");
        // The transfer itself is untouched and would pass every other caveat; the only
        // change is 1 wei of ETH riding along out of the payer's account.
        return expectRevert("facilitator-value", "ValueLteEnforcer:value-too-high", () =>
            simulateTamperedRedeem(ctx, leaf.permissionContext, {value: 1n}),
        );
    });

    await testCase("facilitator-self-target: cannot aim the execution at the payer account itself", async () => {
        // The sharpest version of the tampering family, and the one that is not obvious
        // from the others. Execution runs as `IDeleGatorCore(root.delegator).executeFromExecutor`
        // (DelegationManager.sol:252-253), so if the execution's target were the payer
        // account, the account would call ITSELF — satisfying `msg.sender == address(this)`,
        // the *self* disjunct of `onlyEntryPointOrSelf` (DeleGatorCore.sol:106-109). That
        // branch reaches `withdrawDeposit` (:356), `enableDelegation` (:373 — which would
        // UNDO a revocation), and `_authorizeUpgrade` (:526, i.e. swapping the account's
        // implementation outright). Nothing inside DeleGatorCore refuses a self-call; the
        // only thing standing there is the caveat set.
        //
        // The payload is `withdrawDeposit(address,uint256)` deliberately: its calldata is
        // 68 bytes, exactly the length ERC20TransferAmountEnforcer requires
        // (ERC20TransferAmountEnforcer.sol:87), so it clears the length gate and is
        // refused on the contract check at :92 rather than incidentally on its size. It
        // also names the real stake — that deposit is what arms the revocation kill switch.
        //
        // What this proves and what it does not: it proves the caveat set refuses a
        // self-targeted execution, and mutation shows the refusal is attributable to the
        // target (swapping the target back to the token moves the revert to
        // `invalid-method`). It does NOT prove the self-call would otherwise succeed —
        // that rests on reading the two contracts above, not on this case.
        const acct = await freshOwnerAccount(ctx, owner, "fac-self");
        const start = (await chainNow(ctx)) - 1;
        const root = await signedRoot(ctx, acct, agent.address, openPolicy, start);
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, FIXED_VENDOR, 1_000_000n);
        const drain = encodeFunctionData({
            abi: parseAbi(["function withdrawDeposit(address withdrawAddress, uint256 withdrawAmount)"]),
            functionName: "withdrawDeposit",
            args: [ctx.relayerAddress, 10n ** 15n],
        });
        if (((drain.length - 2) / 2) !== 68) {
            throw new Error(`payload must be 68 bytes to clear the length gate, got ${(drain.length - 2) / 2}`);
        }
        return expectRevert(
            "facilitator-self-target",
            "ERC20TransferAmountEnforcer:invalid-contract",
            () =>
                simulateTamperedRedeem(ctx, leaf.permissionContext, {
                    target: acct.address,
                    callData: drain,
                }),
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
        return expectRevert("root-revocation", "CannotUseADisabledDelegation", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
    });

    // ── the EntryPoint branch of the kill switch ──────────────────────────────
    //
    // `root-revocation` above proves the *self* branch of `onlyEntryPointOrSelf`, and it
    // gets there with an Anvil impersonation cheat — a route that does not exist on a real
    // chain. No EOA can ever produce `msg.sender == account`, so the only real revocation
    // path is a UserOperation through the EntryPoint. These four cases prove that path,
    // and prove that each thing it depends on is load-bearing.
    //
    // Each needs its own salt: `freshOwnerAccount` derives the deploy salt from the label,
    // and a successful revocation leaves both a disabled root and a refunded deposit
    // behind, which would make a later "starts from nothing" assertion pass on stale state.
    const prepareRevocation = async (saltLabel: string) => {
        const acct = await freshOwnerAccount(ctx, owner, saltLabel);
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
        // Read the EntryPoint from the environment, never a hardcoded canonical address:
        // on the ephemeral target it is a CREATE address owned by the relayer, and
        // hardcoding yields an undecodable empty return instead of a clear failure.
        const entryPoint = getAddress(ctx.environment.EntryPoint);
        const nonce = await readRevocationNonce({
            publicClient: ctx.publicClient,
            entryPoint,
            sender: acct.address,
        });
        const built = buildRevocationUserOperation({
            delegation: signedDelegation,
            entryPoint,
            chainId: ctx.chainId,
            nonce,
            gas: DEFAULT_REVOCATION_GAS,
        });
        // Anti-vacuity: a zero prefund would make AA21 dead code and let handleOps
        // succeed on a completely unfunded account, so assert it before anything else.
        if (built.requiredPrefund === 0n) throw new Error("requiredPrefund is 0 — the prefund gate would be vacuous");
        const state = await readRevocationPrefundState({
            publicClient: ctx.publicClient,
            entryPoint,
            sender: acct.address,
            requiredPrefund: built.requiredPrefund,
        });
        if (state.deposit !== 0n || state.nativeBalance !== 0n) {
            throw new Error(`account must start with nothing, got deposit=${state.deposit} balance=${state.nativeBalance}`);
        }
        if (state.ready) throw new Error("prefund reported ready before any deposit");
        const domainName = await ctx.publicClient.readContract({
            address: acct.address,
            abi: HybridDeleGatorAbi,
            functionName: "NAME",
        });
        if (domainName !== built.typedData.domain.name) {
            throw new Error(`account NAME() is "${domainName}", builder signs "${built.typedData.domain.name}"`);
        }
        return {acct, signedDelegation, entryPoint, built};
    };

    const fundPrefund = async (sender: Address, entryPoint: Address, amount: bigint) => {
        // `depositTo` credits an arbitrary account and leaves its native balance at zero.
        // Sending raw ETH to the EntryPoint instead would credit the *sender* — the
        // relayer — via `receive()`, and the operation would still fail AA21.
        const hash = await ctx.relayer.writeContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "depositTo",
            args: [sender],
            value: amount,
        });
        await ctx.publicClient.waitForTransactionReceipt({hash});
    };

    const revoked = (signedDelegation: Parameters<typeof buildRevocationCall>[0]) =>
        isDelegationRevoked({
            publicClient: ctx.publicClient,
            delegationManager: getAddress(ctx.environment.DelegationManager),
            delegation: signedDelegation,
        });

    await testCase("revocation-userop: owner-signed UserOp revokes through the EntryPoint", async () => {
        const {acct, signedDelegation, entryPoint, built} = await prepareRevocation("revoke-userop");
        const root = encodeDelegations([signedDelegation]);

        // Fund exactly, not with headroom: `balance == requiredPrefund` is the boundary
        // the EntryPoint's subtraction branch actually walks.
        await fundPrefund(acct.address, entryPoint, built.requiredPrefund);
        const funded = await readRevocationPrefundState({
            publicClient: ctx.publicClient,
            entryPoint,
            sender: acct.address,
            requiredPrefund: built.requiredPrefund,
        });
        if (!funded.ready) throw new Error("deposit did not arm the kill switch");
        // The invariant the whole demo rests on: the payer still holds zero gas.
        if (funded.nativeBalance !== 0n) {
            throw new Error(`depositTo gave the payer ${funded.nativeBalance} wei of ETH — it must stay at 0`);
        }

        // Sign the builder's own typed data with a bare EOA. Signing via the kit's
        // `acct.signUserOperation` would test the kit against itself; this proves the
        // construction in packages/delegation is what the account accepts.
        const signature = await owner.signTypedData(built.typedData);
        const viaKit = await acct.signUserOperation({
            ...built.userOperation,
            signature: "0x",
            chainId: ctx.chainId,
        });
        if (viaKit !== signature) {
            throw new Error("builder typed data does not match the kit's UserOp signing payload");
        }

        const final = finalizeRevocationUserOperation(built, signature);
        const sim = await ctx.publicClient.simulateContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "handleOps",
            args: [[final.packed], BENEFICIARY],
            account: ctx.relayer.account,
        });
        const hash = await ctx.relayer.writeContract({
            ...sim.request,
            account: ctx.relayer.account,
            chain: ctx.chain,
        });
        const receipt = await ctx.publicClient.waitForTransactionReceipt({hash});
        if (receipt.status !== "success") throw new Error("handleOps reverted");
        // A successful receipt is NOT proof: the EntryPoint swallows an inner-call revert
        // into UserOperationRevertReason and the transaction still succeeds.
        const events = parseEventLogs({
            abi: EntryPointAbi,
            logs: receipt.logs,
            eventName: "UserOperationEvent",
        });
        const event = events[0];
        if (!event) throw new Error("no UserOperationEvent — the op never executed");
        if (!(event.args as {success: boolean}).success) {
            throw new Error("UserOperationEvent.success is false — disableDelegation reverted inside");
        }
        if (!(await revoked(signedDelegation))) throw new Error("delegation is still enabled after a successful op");
        const after = await readRevocationPrefundState({
            publicClient: ctx.publicClient,
            entryPoint,
            sender: acct.address,
            requiredPrefund: built.requiredPrefund,
        });
        if (after.deposit >= built.requiredPrefund) {
            throw new Error("no gas was charged to the deposit — the prefund path was not exercised");
        }
        // and the consequence the payer actually cares about
        const leaf = await buildLeaf(ctx, AGENT_KEY, root, OTHER_PAYEE, 1_000_000n);
        const reason = await expectRevert("revocation-userop", "CannotUseADisabledDelegation", () =>
            simulateRedeem(ctx, ctx.relayer, leaf.permissionContext, OTHER_PAYEE, 1_000_000n),
        );
        return `revoked via EntryPoint (prefund ${built.requiredPrefund} wei, payer ETH still 0); redemption then reverts: ${reason}`;
    });

    await testCase("revocation-submitter: a JSON wire submission validates and revokes", async () => {
        // The unit tests prove the validator is internally consistent. This proves the
        // bytes it emits are the bytes the EntryPoint accepts — and that they survive a
        // real JSON round trip, which is where a leaked bigint would surface.
        const {acct, signedDelegation, entryPoint, built} = await prepareRevocation("revoke-submit");
        const root = encodeDelegations([signedDelegation]);
        const signature = await owner.signTypedData(built.typedData);
        const final = finalizeRevocationUserOperation(built, signature);

        const policy = {
            payer: acct.address,
            maxCallGasLimit: DEFAULT_REVOCATION_GAS.callGasLimit,
            maxVerificationGasLimit: DEFAULT_REVOCATION_GAS.verificationGasLimit,
            maxPreVerificationGas: DEFAULT_REVOCATION_GAS.preVerificationGas,
            maxFeePerGas: DEFAULT_REVOCATION_GAS.maxFeePerGas,
        };
        const body = JSON.parse(
            JSON.stringify({
                permissionContext: root,
                userOperation: {
                    sender: final.packed.sender,
                    nonce: final.packed.nonce.toString(),
                    initCode: final.packed.initCode,
                    callData: final.packed.callData,
                    accountGasLimits: final.packed.accountGasLimits,
                    preVerificationGas: final.packed.preVerificationGas.toString(),
                    gasFees: final.packed.gasFees,
                    paymasterAndData: final.packed.paymasterAndData,
                    signature: final.packed.signature,
                },
            }),
        ) as unknown;
        const submission = validateRevocationSubmission(body, policy);
        for (const field of [
            "sender",
            "nonce",
            "initCode",
            "callData",
            "accountGasLimits",
            "preVerificationGas",
            "gasFees",
            "paymasterAndData",
            "signature",
        ] as const) {
            if (submission.packed[field] !== final.packed[field]) {
                throw new Error(`validated ${field} differs from the signed struct`);
            }
        }

        // The readiness judgment, against real chain state, before and after funding.
        const baseFeePerGas = (await ctx.publicClient.getBlock({blockTag: "latest"})).baseFeePerGas ?? 0n;
        const relayerBalance = await ctx.publicClient.getBalance({address: ctx.relayerAddress});
        const before = judgeSubmissionReadiness({
            deposit: (await readRevocationPrefundState({
                publicClient: ctx.publicClient,
                entryPoint,
                sender: acct.address,
                requiredPrefund: submission.requiredPrefund,
            })).deposit,
            requiredPrefund: submission.requiredPrefund,
            baseFeePerGas,
            maxFeePerGas: submission.gas.maxFeePerGas,
            relayerBalance,
        });
        if (before.ok || before.refusal.reason !== "prefund_short") {
            throw new Error("an unfunded account was judged ready — the deposit gate is not live");
        }

        await fundPrefund(acct.address, entryPoint, submission.requiredPrefund);
        const armed = judgeSubmissionReadiness({
            deposit: (await readRevocationPrefundState({
                publicClient: ctx.publicClient,
                entryPoint,
                sender: acct.address,
                requiredPrefund: submission.requiredPrefund,
            })).deposit,
            requiredPrefund: submission.requiredPrefund,
            baseFeePerGas,
            maxFeePerGas: submission.gas.maxFeePerGas,
            relayerBalance,
        });
        if (!armed.ok) throw new Error(`funded account still judged unready: ${armed.refusal.reason}`);

        const sim = await ctx.publicClient.simulateContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "handleOps",
            args: [[submission.packed], BENEFICIARY],
            account: ctx.relayer.account,
        });
        const hash = await ctx.relayer.writeContract({
            ...sim.request,
            account: ctx.relayer.account,
            chain: ctx.chain,
        });
        const receipt = await ctx.publicClient.waitForTransactionReceipt({hash});
        if (receipt.status !== "success") throw new Error("handleOps reverted");
        const events = parseEventLogs({abi: EntryPointAbi, logs: receipt.logs, eventName: "UserOperationEvent"});
        const event = events[0];
        if (!event) throw new Error("no UserOperationEvent — the op never executed");
        if (!(event.args as {success: boolean}).success) {
            throw new Error("UserOperationEvent.success is false — disableDelegation reverted inside");
        }
        if (!(await revoked(signedDelegation))) throw new Error("delegation is still enabled");
        return `wire submission validated and revoked (prefund ${submission.requiredPrefund} wei)`;
    });

    await testCase("revocation-submitter-foreign-sender: another account's op is refused off-chain", async () => {
        // The griefing case the allowlist exists for: a well-formed, correctly signed
        // revocation for a DIFFERENT account. On chain it would succeed — it is a valid
        // operation. The submitter must refuse to spend its gas on it, and must do so
        // before any chain read.
        const {acct, signedDelegation, built} = await prepareRevocation("revoke-foreign");
        const signature = await owner.signTypedData(built.typedData);
        const final = finalizeRevocationUserOperation(built, signature);
        const body = {
            permissionContext: encodeDelegations([signedDelegation]),
            userOperation: {
                sender: final.packed.sender,
                nonce: final.packed.nonce.toString(),
                initCode: final.packed.initCode,
                callData: final.packed.callData,
                accountGasLimits: final.packed.accountGasLimits,
                preVerificationGas: final.packed.preVerificationGas.toString(),
                gasFees: final.packed.gasFees,
                paymasterAndData: final.packed.paymasterAndData,
                signature: final.packed.signature,
            },
        };
        // The submitter serves OTHER_PAYEE, not this account.
        const foreignPolicy = {
            payer: OTHER_PAYEE,
            maxCallGasLimit: DEFAULT_REVOCATION_GAS.callGasLimit,
            maxVerificationGasLimit: DEFAULT_REVOCATION_GAS.verificationGasLimit,
            maxPreVerificationGas: DEFAULT_REVOCATION_GAS.preVerificationGas,
            maxFeePerGas: DEFAULT_REVOCATION_GAS.maxFeePerGas,
        };
        let refusal = "";
        try {
            validateRevocationSubmission(body, foreignPolicy);
        } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
        }
        if (!refusal.includes("not the account this submitter serves")) {
            throw new Error(`expected a sender-allowlist refusal, got: ${refusal || "acceptance"}`);
        }
        // Anti-vacuity: the very same body is accepted by the policy that does serve it,
        // so the refusal is attributable to the allowlist and not to a malformed body.
        validateRevocationSubmission(body, {...foreignPolicy, payer: acct.address});
        return refusal;
    });

    await testCase("revocation-userop-unfunded: no deposit means no kill switch (AA21)", async () => {
        // The control that makes the case above non-vacuous. Without it, that case would
        // pass identically with a zero-fee op and nobody would learn anything.
        const {acct, signedDelegation, entryPoint, built} = await prepareRevocation("revoke-userop-unfunded");
        const signature = await owner.signTypedData(built.typedData);
        const final = finalizeRevocationUserOperation(built, signature);
        // simulateContract, not writeContract: writeContract estimates gas first and the
        // failure arrives in a shape the revert walker may not decode.
        const reason = await expectRevert("revocation-userop-unfunded", "AA21 didn't pay prefund", () =>
            ctx.publicClient.simulateContract({
                address: entryPoint,
                abi: EntryPointAbi,
                functionName: "handleOps",
                args: [[final.packed], BENEFICIARY],
                account: ctx.relayer.account,
            }),
        );
        if (await revoked(signedDelegation)) throw new Error("delegation was disabled despite a rejected op");
        void acct;
        return reason;
    });

    await testCase("revocation-userop-wrong-signer: a non-owner cannot revoke (AA24)", async () => {
        // Must be funded: the EntryPoint checks the prefund before it checks the
        // signature, so an unfunded wrong-signature op fails AA21 and proves nothing.
        const {acct, signedDelegation, entryPoint, built} = await prepareRevocation("revoke-userop-wrongsig");
        await fundPrefund(acct.address, entryPoint, built.requiredPrefund);
        const signature = await agent.signTypedData(built.typedData);
        const final = finalizeRevocationUserOperation(built, signature);
        const reason = await expectRevert("revocation-userop-wrong-signer", "AA24 signature error", () =>
            ctx.publicClient.simulateContract({
                address: entryPoint,
                abi: EntryPointAbi,
                functionName: "handleOps",
                args: [[final.packed], BENEFICIARY],
                account: ctx.relayer.account,
            }),
        );
        if (await revoked(signedDelegation)) throw new Error("delegation was disabled by a non-owner signature");
        return reason;
    });

    await testCase("revocation-userop-tampered-field: the signed entryPoint field is load-bearing (AA24)", async () => {
        // `entryPoint` is the ninth field of the signed struct and appears in no other
        // EIP-712 payload in this repo — exactly the field a hand-rolled builder gets
        // wrong. Sign a mutated payload, submit the unmutated op.
        const {acct, signedDelegation, entryPoint, built} = await prepareRevocation("revoke-userop-tampered");
        await fundPrefund(acct.address, entryPoint, built.requiredPrefund);
        const signature = await owner.signTypedData({
            ...built.typedData,
            message: {...built.typedData.message, entryPoint: zeroAddress},
        });
        if (signature === (await owner.signTypedData(built.typedData))) {
            throw new Error("mutating the entryPoint field did not change the digest");
        }
        const final = finalizeRevocationUserOperation(built, signature);
        const reason = await expectRevert("revocation-userop-tampered-field", "AA24 signature error", () =>
            ctx.publicClient.simulateContract({
                address: entryPoint,
                abi: EntryPointAbi,
                functionName: "handleOps",
                args: [[final.packed], BENEFICIARY],
                account: ctx.relayer.account,
            }),
        );
        if (await revoked(signedDelegation)) throw new Error("delegation was disabled by a tampered signature");
        return reason;
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
    try {
        const {ctx} = await acquireContext();
        await assertBeneficiaryIsCodeFree(ctx.publicClient);
        console.log(`[suite] running negative-path cases on chainId ${ctx.chainId}\n`);
        await run(ctx);
    } finally {
        // `runTeardowns`, not the returned `stop`: `acquireContext` itself can throw after
        // the node is up, and then no handle ever reaches this scope. Keeping the call
        // inside the same `try` as `acquireContext` is what makes that case reachable.
        runTeardowns();
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
    // Belt and braces: `main`'s `finally` already covers everything it can reach, but a
    // throw from the `acquireContext` call itself would otherwise leave a live child and
    // Bun would never exit — a hang, not an error message.
    runTeardowns();
    // The stack is kept — for a suite failure the frames are the whole point — but it is
    // run through `redactUrls` first. On a viem `BaseError` the stack begins with the
    // composed message, which includes `URL:` and `Request body:` metaMessages, so
    // printing it raw would put the fork endpoint (API key in its path) on the terminal
    // and into CI output. `redactForLog` is wrong here: it collapses newlines and caps at
    // 300 characters, which would destroy the frames this handler exists to show.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(redactUrls(detail));
    process.exitCode = 1;
});
