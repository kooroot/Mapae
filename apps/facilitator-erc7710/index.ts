import {Hono, type Context} from "hono";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    PaymentIntentSingleFlight,
    buildDelegatedTransfer,
    parseActiveDeploymentArtifactJson,
    readRenamedEnv,
    parseFrameworkDeploymentManifestJson,
    reconcileSettlementReceipt,
    validateDelegatedPayment,
    verifyActiveFrameworkDeployment,
    verifyFrameworkOperationalState,
    throttledHttp,
    SETTLEMENT_UNCONFIRMED,
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
    type FrameworkLiveVerification,
    type ValidatedDelegatedPayment,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    buildErc7710SupportedPayload,
    giwaSepolia,
    parseNodeRpcUrl,
    redactForLog,
    toTokenAmount,
} from "@mapae/shared";
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    isAddress,
    nonceManager,
    publicActions,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const MAX_BODY_CHARACTERS = 150_000;

function readPort(): number {
    const value = Number(process.env.PORT ?? 8081);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return value;
}

function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; put a TLS reverse proxy in front for remote access");
    }
    return value;
}

function readRpcUrl(): string {
    return parseNodeRpcUrl(
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
}

// FACILITATOR_SIGNER_* is this wallet's one global name across every service; the legacy
// RELAYER_* spelling keeps a live mini `.env` booting through the rename, with a warning.
function readRelayerKey(): Hex {
    const value =
        readRenamedEnv({current: "FACILITATOR_SIGNER_PRIVATE_KEY", legacy: "RELAYER_PRIVATE_KEY"}) ??
        "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("FACILITATOR_SIGNER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readRelayerAddress(): Address {
    const value =
        readRenamedEnv({current: "FACILITATOR_SIGNER_ADDRESS", legacy: "RELAYER_ADDRESS"}) ?? "";
    if (!isAddress(value)) throw new Error("FACILITATOR_SIGNER_ADDRESS must be an address");
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("FACILITATOR_SIGNER_ADDRESS must not be zero");
    return address;
}

function readPositiveInteger(name: string, fallback: number): bigint {
    const raw = process.env[name]?.trim() || String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw);
}

async function readDeployment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`delegation deployment artifact not found: ${path}`);
    }
    return parseActiveDeploymentArtifactJson(await file.text());
}

async function readManifest() {
    const path =
        process.env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`Framework composition manifest not found: ${path}`);
    }
    return parseFrameworkDeploymentManifestJson(await file.text());
}

function readFrameworkAdmin(): Address {
    const value = process.env.FRAMEWORK_ADMIN_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("FRAMEWORK_ADMIN_ADDRESS must be an address");
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("FRAMEWORK_ADMIN_ADDRESS must not be zero");
    return address;
}

const HOST = readHost();
const PORT = readPort();
const RPC_URL = readRpcUrl();
const MAX_AMOUNT = toTokenAmount(process.env.MAX_SETTLEMENT_AMOUNT ?? "10.00");
// 1.5M was an unsourced guess until 2026-07-28; these are the first measured numbers.
// Twelve successful `redeemDelegations` receipts scanned out of a local anvil after the
// 23-case ephemeral negative-path suite ran against it:
//
//   333,523–333,547  steady state, the shipped root→leaf payment shape
//   448,185          first payment of a period into a cold recipient balance slot
//   635,102          manager→child→leaf, three deep — a lab case, not a shipped flow
//
// So the cap carries 4.5x headroom on the ordinary path and 2.4x on the deepest chain
// that exists anywhere in this repository. It is a backstop against a pathological
// permission context, not a tuned budget, and lowering it toward the measured figures
// would start refusing legitimate first-of-period payments.
//
// Measured on anvil, and one property of that measurement did not transfer: anvil's
// `eth_estimateGas` returned the exact `gasUsed` on all twelve, so the broadcast below
// carries no slack over the estimate. Whether GIWA's node is equally tight is unverified.
const MAX_REDEMPTION_GAS = readPositiveInteger("MAX_REDEMPTION_GAS", 1_500_000);
// Configurable like the other limits, and lowering it is how the broadcast-but-
// unconfirmed path gets exercised without waiting a minute for a real stall.
//
// The default is 25 s, not 60 s. This is the innermost of four stacked timeouts and it
// sets the budget for all of them: the seller must out-wait this, its HTTP server must
// out-wait the seller, and the agent must out-wait that — while still finishing inside an
// MCP client's 60 s default. Sixty seconds here leaves no room for the other three.
//
// 25 s is not tight. GIWA Sepolia produces a block every 1.00 s (measured across
// 31634888→31634935), and settlement waits for a single confirmation, so the real cost is
// the throttled RPC round trips rather than the chain.
const RECEIPT_TIMEOUT_MS = Number(readPositiveInteger("SETTLEMENT_RECEIPT_TIMEOUT_MS", 25_000));
// The nonce manager serializes nonce assignment per address. Without it, two concurrent
// /settle calls for different payment intents each read eth_getTransactionCount(pending)
// independently and can pick the same nonce — one broadcast then replaces the other in the
// mempool, dropping a settlement the seller already told the buyer succeeded. PaymentIntent
// single-flight only coalesces same-intent calls; distinct intents race here.
const relayer = privateKeyToAccount(readRelayerKey(), {nonceManager});
const expectedRelayer = readRelayerAddress();
if (relayer.address !== expectedRelayer) {
    throw new Error(
        `FACILITATOR_SIGNER_PRIVATE_KEY resolves to ${relayer.address}, expected ${expectedRelayer}`,
    );
}
const deployment = await readDeployment();
const manifest = await readManifest();
const frameworkAdmin = readFrameworkAdmin();
const manager = getAddress(deployment.environment.DelegationManager);

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const facilitatorClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

class FrameworkReadinessGate {
    #cachedUntil: number;
    #cached: FrameworkLiveVerification;
    #pending?: Promise<FrameworkLiveVerification>;

    constructor(initial: FrameworkLiveVerification) {
        this.#cached = initial;
        this.#cachedUntil = Date.now() + 5_000;
    }

    async verify(): Promise<FrameworkLiveVerification> {
        if (Date.now() < this.#cachedUntil) return this.#cached;
        this.#pending ??= verifyFrameworkOperationalState({
            publicClient,
            deployment,
            expectedFrameworkAdmin: frameworkAdmin,
        });
        try {
            const result = await this.#pending;
            this.#cached = result;
            this.#cachedUntil = Date.now() + 5_000;
            return result;
        } finally {
            this.#pending = undefined;
        }
    }
}

const startupVerification = await verifyActiveFrameworkDeployment({
    publicClient,
    deployment,
    manifest,
    expectedFrameworkAdmin: frameworkAdmin,
});
const readiness = new FrameworkReadinessGate(startupVerification);

/**
 * How long a broadcast transaction stays remembered for its payment intent.
 *
 * The map exists so a receipt timeout never triggers a second broadcast, which
 * only matters while a client could still be retrying — bounded by the agent's own
 * request timeout (AGENT_REQUEST_TIMEOUT_MS in @mapae/delegation, the outermost layer
 * of the settlement budget). Keeping entries forever would grow the process without
 * bound; evicting them earlier than any live retry could arrive is what makes dropping
 * them safe.
 */
const INTENT_MEMORY_MS = 60 * 60 * 1_000;

/**
 * Raised when a redemption was broadcast but its receipt did not arrive in time.
 *
 * Distinct from every other settlement failure because the payer may well have been
 * charged. The caller needs the hash to find out, and must not be told the payment
 * was rejected.
 */
class SettlementUnconfirmed extends Error {
    /**
     * `transaction` is optional because the ambiguity has two shapes. A receipt-wait
     * timeout knows the hash (the broadcast returned it); a throw from the broadcast
     * call itself does not — `writeContract` prepares, signs, and sends in one step, so
     * a lost response after the node accepted the transaction rejects without ever
     * handing back a hash. Both are "unknown, may be charged", and both must reach the
     * seller as SETTLEMENT_UNCONFIRMED so the client is told not to re-sign.
     */
    constructor(readonly transaction?: Hex) {
        super("redemption broadcast but not confirmed");
        this.name = "SettlementUnconfirmed";
    }
}

/**
 * Raised when the redemption mined with status "success" but its own receipt carries
 * no `Transfer(payer → payTo, amount)` on the asset — the false-return-token shape.
 * Distinct from a rejection on both sides of the ledger: the vendor was NOT paid, so
 * the resource must not be served, and yet the payer's period allowance WAS consumed,
 * so the transaction hash has to reach the operator instead of being swallowed.
 */
class SettlementNotCredited extends Error {
    constructor(
        readonly transaction: Hex,
        detail: string,
    ) {
        super(`settlement mined without crediting the vendor: ${detail}`);
        this.name = "SettlementNotCredited";
    }
}

class SettlementCoordinator {
    readonly #singleFlight = new PaymentIntentSingleFlight<Erc7710SettleResponse>();
    readonly #broadcastTransactions = new Map<Hex, {hash: Hex; at: number}>();

    #rememberBroadcast(intent: Hex, hash: Hex): void {
        const cutoff = Date.now() - INTENT_MEMORY_MS;
        for (const [key, entry] of this.#broadcastTransactions) {
            if (entry.at < cutoff) this.#broadcastTransactions.delete(key);
        }
        this.#broadcastTransactions.set(intent, {hash, at: Date.now()});
    }

    /**
     * Simulate the redemption against live state and price it. Nothing in here can
     * broadcast — a simulation revert or a gas-cap refusal charges nobody — so a throw
     * from this method is a genuine rejection on `/verify` and `/settle` alike.
     */
    async #prepareRedemption(payment: ValidatedDelegatedPayment) {
        const transfer = buildDelegatedTransfer(payment);
        const simulation = await DelegationManager.simulate.redeemDelegations({
            client: facilitatorClient,
            delegationManagerAddress: manager,
            delegations: [...transfer.delegations],
            modes: [...transfer.modes],
            executions: transfer.executions.map((batch) => [...batch]),
        });
        const gas = await facilitatorClient.estimateContractGas(simulation.request);
        if (gas > MAX_REDEMPTION_GAS) {
            throw new Error(`redemption gas ${gas} exceeds configured cap`);
        }
        return {request: simulation.request, gas};
    }

    async simulate(payment: ValidatedDelegatedPayment): Promise<void> {
        await this.#prepareRedemption(payment);
    }

    async settle(payment: ValidatedDelegatedPayment): Promise<Erc7710SettleResponse> {
        return this.#singleFlight.run(payment.paymentIntentId, () =>
            this.#settleOnce(payment),
        );
    }

    async #settleOnce(payment: ValidatedDelegatedPayment): Promise<Erc7710SettleResponse> {
        let hash = this.#broadcastTransactions.get(payment.paymentIntentId)?.hash;
        if (!hash) {
            const {request, gas} = await this.#prepareRedemption(payment);
            // `#prepareRedemption` provably did not broadcast, so its throws are genuine
            // rejections. `writeContract` is the one ambiguous step: it prepares, signs,
            // and sends in a single call, so a lost response after the node accepted the
            // transaction rejects here while the transfer will still mine. Reporting that
            // as `delegation_rejected` would tell the payer they were not charged and
            // invite a retry that signs a fresh leaf and pays twice — the exact
            // unknown-vs-failed collapse SETTLEMENT_UNCONFIRMED exists to prevent, which
            // was being enforced only one step later at the receipt wait. A same-intent
            // retry is safe regardless: the leaf's one-shot ERC20TransferAmountEnforcer
            // reverts a second redemption of the identical context.
            try {
                hash = await facilitatorClient.writeContract({...request, gas});
            } catch {
                throw new SettlementUnconfirmed();
            }
            // Save before waiting. A receipt timeout must never trigger a duplicate broadcast.
            this.#rememberBroadcast(payment.paymentIntentId, hash);
        }

        let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
        try {
            receipt = await publicClient.waitForTransactionReceipt({
                hash,
                confirmations: 1,
                timeout: RECEIPT_TIMEOUT_MS,
            });
        } catch {
            // The transaction is already on the network; only our wait gave up.
            // Collapsing this into the generic rejection would tell the seller the
            // payer was not charged, which is exactly what nobody knows yet.
            throw new SettlementUnconfirmed(hash);
        }
        if (receipt.status !== "success") throw new Error("redemption transaction reverted");
        // Status "success" only says the call did not revert. The enforcers constrain
        // calldata and consume allowance but never prove the recipient was credited —
        // a token returning false instead of reverting passes everything above while
        // moving nothing. The receipt's own Transfer log is the precondition for
        // reporting success, and through the seller's settle ladder, for the resource.
        const discrepancies = reconcileSettlementReceipt({
            logs: receipt.logs,
            asset: payment.paymentRequirements.asset,
            payer: payment.payer,
            payTo: payment.paymentRequirements.payTo,
            amount: payment.amount,
        });
        if (discrepancies.length > 0) {
            throw new SettlementNotCredited(
                hash,
                discrepancies.map((problem) => problem.detail).join("; "),
            );
        }
        return {
            success: true,
            transaction: hash,
            network: GIWA_SEPOLIA_CAIP2,
            payer: payment.payer,
        };
    }
}

const coordinator = new SettlementCoordinator();
const app = new Hono();

app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

app.get("/health", async (c) => {
    let framework: FrameworkLiveVerification | undefined;
    // Why it is unhealthy, not just that it is. Verification throws for a paused
    // manager, an unexpected owner, and an unreachable RPC alike, so without this
    // every one of them looks identical: ok=false, frameworkPaused=null. Loopback
    // only, and redacted, so the reason never becomes an oracle for a caller.
    let frameworkError: string | null = null;
    try {
        framework = await readiness.verify();
    } catch (error) {
        framework = undefined;
        frameworkError = redactForLog(error, 200);
    }
    // Degrade like the framework check above rather than throwing: a health probe
    // that 500s when the RPC blips tells the operator less than one that reports
    // which dependency is down.
    const relayerBalance = await publicClient
        .getBalance({address: relayer.address})
        .catch(() => undefined);
    return c.json({
        ok: Boolean(framework) && relayerBalance !== undefined && relayerBalance > 0n,
        network: GIWA_SEPOLIA_CAIP2,
        composition: deployment.compositionId,
        delegationManager: manager,
        frameworkOwner: framework?.owner ?? null,
        frameworkPaused: framework?.paused ?? null,
        frameworkError,
        facilitator: relayer.address,
        relayerFunded: relayerBalance === undefined ? null : relayerBalance > 0n,
    });
});

app.get("/supported", (c) =>
    c.json(
        buildErc7710SupportedPayload({
            facilitatorAddresses: [relayer.address],
            delegationManager: manager,
        }),
    ),
);

app.post("/verify", async (c) => {
    try {
        await readiness.verify();
        const payment = validateDelegatedPayment(await readJson(c), {
            delegationManager: manager,
            facilitator: relayer.address,
            maxAmount: MAX_AMOUNT,
        });
        await coordinator.simulate(payment);
        const response: Erc7710VerifyResponse = {
            isValid: true,
            payer: payment.payer,
        };
        return c.json(response);
    } catch (error) {
        logSafeFailure("verify", error);
        const response: Erc7710VerifyResponse = {isValid: false, invalidReason: "delegation_rejected"};
        return c.json(response);
    }
});

app.post("/settle", async (c) => {
    try {
        await readiness.verify();
        const payment = validateDelegatedPayment(await readJson(c), {
            delegationManager: manager,
            facilitator: relayer.address,
            maxAmount: MAX_AMOUNT,
        });
        const response = await coordinator.settle(payment);
        console.log(
            `[settled] paymentIntentId=${payment.paymentIntentId} tx=${response.transaction}`,
        );
        return c.json(response);
    } catch (error) {
        logSafeFailure("settle", error);
        if (error instanceof SettlementUnconfirmed) {
            const pending: Erc7710SettleResponse = {
                success: false,
                network: GIWA_SEPOLIA_CAIP2,
                transaction: error.transaction,
                errorReason: SETTLEMENT_UNCONFIRMED,
            };
            return c.json(pending);
        }
        if (error instanceof SettlementNotCredited) {
            // `success: false` sends the seller's ladder to "failed" — the resource is
            // withheld. The hash still travels: allowance was consumed by a transaction
            // that paid nobody, and an operator has to be able to find it.
            const notCredited: Erc7710SettleResponse = {
                success: false,
                network: GIWA_SEPOLIA_CAIP2,
                transaction: error.transaction,
                errorReason: "vendor_not_credited",
            };
            return c.json(notCredited);
        }
        const response: Erc7710SettleResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            errorReason: "delegation_rejected",
        };
        return c.json(response);
    }
});

async function readJson(c: Context): Promise<unknown> {
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new Error("content-type must be JSON");
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARACTERS) {
        throw new Error("request body is too large");
    }
    const text = await c.req.text();
    if (text.length === 0 || text.length > MAX_BODY_CHARACTERS) {
        throw new Error("request body is empty or too large");
    }
    return JSON.parse(text) as unknown;
}

function logSafeFailure(path: string, error: unknown): void {
    // The response stays deliberately opaque — an untrusted caller learns nothing
    // about why its payment failed. The operator is not untrusted, and logging only
    // the error name left them with "Error: request rejected" for an on-chain
    // caveat rejection. `redactForLog` keeps the revert reason and strips the
    // bearer-length hex that viem embeds in its errors.
    console.error(`[${path}] rejected — ${redactForLog(error)}`);
}

// `manager` is already `getAddress(...)`-checked at construction, which throws on
// anything malformed — a second check here could never fire while reading like a
// real guard.
console.log(`ERC-7710 facilitator listening on ${HOST}:${PORT}`);
console.log(`  network ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  manager ${manager}`);
console.log(`  signer  ${relayer.address}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
