import {Hono, type Context} from "hono";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    PaymentIntentSingleFlight,
    SpendBudget,
    buildDelegatedTransfer,
    costOfReceipt,
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
import {openStore, type SettlementEventInput} from "@mapae/store";
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
import {bearerTokenMatches, metricsReport, readMetricsToken} from "./metrics.js";

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

function readPositiveInteger(name: string, fallback: bigint): bigint {
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

/** `:memory:` is accepted for dry runs; anything else is a file whose directory is created. */
function readStorePath(): string {
    return process.env.STORE_PATH?.trim() || "./data/facilitator.sqlite";
}

const HOST = readHost();
const PORT = readPort();
const RPC_URL = readRpcUrl();
const MAX_AMOUNT = toTokenAmount(process.env.MAX_SETTLEMENT_AMOUNT ?? "10.00");
const STORE_PATH = readStorePath();
const METRICS_TOKEN = readMetricsToken(process.env.METRICS_TOKEN);
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
const MAX_REDEMPTION_GAS = readPositiveInteger("MAX_REDEMPTION_GAS", 1_500_000n);
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
const RECEIPT_TIMEOUT_MS = Number(readPositiveInteger("SETTLEMENT_RECEIPT_TIMEOUT_MS", 25_000n));
// The relayer's own money is the one thing the on-chain caveats do not bound: every
// redemption is paid for in the relayer's gas, and a payer holding a valid grant can
// ask for as many as the grant allows. The daily ceiling is the operator's number for
// the worst day — the same default as the bootstrap sponsor, 0.0005 ETH, about 1,500
// steady-state redemptions at 1 gwei. The day's total lives in the store, so a restart
// resumes it instead of opening a second budget.
const RELAYER_DAILY_WEI = readPositiveInteger("RELAYER_DAILY_WEI", 500_000_000_000_000n);
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
// After the signer and the artifacts, so a misconfigured boot fails before a ledger
// file is created for nothing.
const store = openStore(STORE_PATH);
const budget = new SpendBudget(RELAYER_DAILY_WEI, Date.now(), store.budget);

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const facilitatorClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

type Receipt = Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;

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

/**
 * Raised when the day's relayer gas budget has no room for this redemption. Nothing was
 * broadcast and nobody was charged — a rejection like a simulation revert, but with its
 * own code so the operator can tell "the payer's grant is bad" from "our wallet is done
 * for the day" in the ledger and the seller can tell the buyer to try again later.
 */
class BudgetExhausted extends Error {
    constructor() {
        super("relayer daily gas budget exhausted");
        this.name = "BudgetExhausted";
    }
}

interface SettlementFailure {
    outcome: "rejected" | "error";
    errorCode: string;
    transaction: Hex | null;
}

/**
 * One classification for both consumers of a failed settlement — the wire response and
 * the ledger row — so the two can never disagree about what happened.
 *
 * `rejected`: nobody was charged (validation, simulation revert, gas cap, budget).
 * `error`: the chain was touched and the answer is unknown (SETTLEMENT_UNCONFIRMED —
 * broadcast, receipt not seen) or wrong (`vendor_not_credited` — mined, allowance
 * consumed, the recipient not paid). Both send the seller's ladder to "failed" and
 * withhold the resource; both carry the hash when there is one, because an operator has
 * to be able to find a transaction that consumed allowance without paying anybody.
 */
function describeFailure(error: unknown): SettlementFailure {
    if (error instanceof SettlementUnconfirmed) {
        return {
            outcome: "error",
            errorCode: SETTLEMENT_UNCONFIRMED,
            transaction: error.transaction ?? null,
        };
    }
    if (error instanceof SettlementNotCredited) {
        return {outcome: "error", errorCode: "vendor_not_credited", transaction: error.transaction};
    }
    if (error instanceof BudgetExhausted) {
        return {outcome: "rejected", errorCode: "budget_exhausted", transaction: null};
    }
    return {outcome: "rejected", errorCode: "delegation_rejected", transaction: null};
}

/**
 * One ledger row per settle attempt. Called from inside the single-flight, so a
 * coalesced duplicate request is not counted twice — and never allowed to throw. A
 * ledger that cannot be written is an operator problem; letting it surface here would
 * report a payment that mined as `delegation_rejected`, the exact collapse the rest of
 * this file exists to prevent.
 */
function recordSettlement(event: SettlementEventInput): void {
    try {
        store.ledger.record(event);
    } catch (error) {
        console.error(`[ledger] settlement event not recorded — ${redactForLog(error)}`);
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
        const event = {
            kind: "settle",
            payer: payment.payer,
            payTo: payment.paymentRequirements.payTo,
            amountBase: payment.amount,
        } as const;
        try {
            const {hash, gasUsed} = await this.#redeem(payment);
            recordSettlement({...event, at: Date.now(), outcome: "settled", txHash: hash, gasUsed});
            return {
                success: true,
                transaction: hash,
                network: GIWA_SEPOLIA_CAIP2,
                payer: payment.payer,
            };
        } catch (error) {
            const failure = describeFailure(error);
            recordSettlement({
                ...event,
                at: Date.now(),
                outcome: failure.outcome,
                txHash: failure.transaction,
                errorCode: failure.errorCode,
            });
            throw error;
        }
    }

    /** Broadcast (or resume) the redemption and wait for a receipt that credited the vendor. */
    async #redeem(payment: ValidatedDelegatedPayment): Promise<{hash: Hex; gasUsed: bigint}> {
        const remembered = this.#broadcastTransactions.get(payment.paymentIntentId)?.hash;
        // A remembered hash was already charged to the budget by the attempt that
        // broadcast it — its whole reservation, since no receipt was seen — so resuming
        // it reserves nothing and charges nothing more.
        const receipt = remembered
            ? await this.#awaitReceipt(remembered)
            : await this.#broadcast(payment);
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
                receipt.transactionHash,
                discrepancies.map((problem) => problem.detail).join("; "),
            );
        }
        return {hash: receipt.transactionHash, gasUsed: receipt.gasUsed};
    }

    /**
     * Price the redemption, hold its worst case against the day's budget, broadcast, and
     * settle what the receipt says it cost.
     *
     * Ordering as in account-bootstrap: everything that can refuse without spending runs
     * before the reservation; the reservation lands before the broadcast so two
     * concurrent intents cannot both spend the last of the day; and the settle is in a
     * `finally`, so every exit returns the hold exactly once. What is charged depends on
     * how far the broadcast got — nothing when no hash came back, the whole reservation
     * when a hash did but its receipt did not, and the receipt's own cost when it did.
     */
    async #broadcast(payment: ValidatedDelegatedPayment): Promise<Receipt> {
        const {request, gas} = await this.#prepareRedemption(payment);
        const {maxFeePerGas, maxPriorityFeePerGas} = await publicClient.estimateFeesPerGas();
        // The node's own upfront rule is `balance >= gas * maxFeePerGas`, and the same
        // product is what the day is asked for. The fees go to the broadcast unchanged,
        // so the reservation is the most that transaction can cost in execution gas.
        const hold = budget.reserve(gas * maxFeePerGas, Date.now());
        if (!hold) throw new BudgetExhausted();
        let charged = 0n;
        try {
            let hash: Hex;
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
                // The call is the simulated one, field by field rather than spread: the
                // simulated request is typed over every fee variant, and spreading it
                // beside an EIP-1559 pair is a union the type checker cannot pick from.
                hash = await facilitatorClient.writeContract({
                    address: request.address,
                    abi: request.abi,
                    functionName: request.functionName,
                    args: request.args,
                    gas,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                });
            } catch {
                throw new SettlementUnconfirmed();
            }
            // The relayer's gas is committed the moment the node returns a hash. Until a
            // receipt says otherwise the charge is the whole reservation: a receipt
            // timeout leaves the day over-counted, never under-counted, and settling 0
            // for a broadcast we merely failed to observe is how a daily cap quietly
            // stops bounding anything.
            charged = hold.amount;
            // Save before waiting. A receipt timeout must never trigger a duplicate broadcast.
            this.#rememberBroadcast(payment.paymentIntentId, hash);
            const receipt = await this.#awaitReceipt(hash);
            // A reverted redemption still burned its gas and is charged like a mined one.
            charged = costOfReceipt(receipt, hold.amount);
            return receipt;
        } finally {
            budget.settle(hold, charged, Date.now());
        }
    }

    async #awaitReceipt(hash: Hex): Promise<Receipt> {
        try {
            return await publicClient.waitForTransactionReceipt({
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
    // The remaining budget is deliberately not here. /health is public through the
    // proxy, and "how much gas is left today" is a targeting number for anyone deciding
    // whether draining the day is worth it; it is reported behind /metrics' token.
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

// Operator-only. 503 while no token is configured, so a deployment that forgot the
// secret exposes nothing rather than everything; the token compare is constant-time.
app.get("/metrics", (c) => {
    if (METRICS_TOKEN === undefined) return c.json({error: "metrics_disabled"}, 503);
    if (!bearerTokenMatches(c.req.header("authorization"), METRICS_TOKEN)) {
        c.header("WWW-Authenticate", 'Bearer realm="metrics"');
        return c.json({error: "unauthorized"}, 401);
    }
    return c.json(metricsReport(store.ledger, Date.now(), budget, RELAYER_DAILY_WEI));
});

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

// Every failure, budget exhaustion included, is a 200 with `success: false` and an
// `errorReason`. The seller's client treats any non-2xx as "the answer was lost" and
// tells the buyer the payment is *unknown* — the one thing a refusal that broadcast
// nothing must never be called. The status code is transport here; the body is the claim.
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
        const failure = describeFailure(error);
        const response: Erc7710SettleResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            transaction: failure.transaction ?? undefined,
            errorReason: failure.errorCode,
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
console.log(`  store   ${STORE_PATH}`);
console.log(`  budget  ${RELAYER_DAILY_WEI} wei/day (RELAYER_DAILY_WEI)`);
console.log(`  metrics ${METRICS_TOKEN === undefined ? "disabled (METRICS_TOKEN unset)" : "enabled"}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
