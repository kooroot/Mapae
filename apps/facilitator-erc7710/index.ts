import {Hono} from "hono";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    FixedWindowLimiter,
    budgetDay,
    buildDelegatedTransfer,
    parseActiveDeploymentArtifactJson,
    parseFrameworkDeploymentManifestJson,
    validateDelegatedPayment,
    verifyActiveFrameworkDeployment,
    verifyFrameworkOperationalState,
    throttledHttp,
    type Erc7710SettleResponse,
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
    TransactionReceiptNotFoundError,
    publicActions,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
    CachedProbe,
    RATE_WINDOW_MS,
    SETTLE_NOT_READY,
    SETTLE_RATE_LIMITED,
    SettlementUnconfirmed,
    VERIFY_NOT_READY,
    VERIFY_RATE_LIMITED,
    beforeBroadcast,
    classifyFrameworkError,
    describeFailure,
    frameworkPausedFrom,
    rateLimitByIp,
    requireReadiness,
    type FrameworkHealthError,
} from "./guards.js";
import {createPaymentRoutes} from "./routes.js";
import {receiptFailure, settlementResponse} from "./settlement.js";
import {SettlementRecovery} from "./recovery.js";
import {bearerTokenMatches, metricsReport, readMetricsToken, rejectedRetention} from "./metrics.js";

// Two caps on one body, in different units, because they guard different things. Bun's
// is bytes on the wire: a Content-Length above it is refused with an empty 413 before
// the handler runs, and a chunked body with no Content-Length is cut at the cap inside
// `c.req.text()`, which rejects and Bun again answers 413 whatever the handler returns
// (measured on Bun 1.4.0 with the cap at 10 bytes). So buffering is bounded at the cap
// rather than avoided — without it a chunked request made the process hold up to Bun's
// 128 MB default. The character cap is what `JSON.parse` is handed and is the one that
// answers with a 200 body (a 413 from Bun reaches the seller as "answer lost", which is
// wrong for a request that was never parsed). Payments are ASCII, so a body under the
// character cap is under the byte cap and always gets the 200 answer; the byte cap only
// ever fires on bodies no client of this service produces.
const MAX_BODY_BYTES = 200_000;
// The framework check and the relayer balance are each read at most once per window.
// 5 s is short enough that a pause or a drained wallet is seen before the next block's
// settlements, long enough that /health — public, and the one route with no rate limit
// — cannot enqueue more than one probe per window.
const PROBE_TTL_MS = 5_000;

// These obsolete names once referred to different wallets in different services.
for (const name of ["RELAYER_ADDRESS", "RELAYER_PRIVATE_KEY"]) {
    if (process.env[name]?.trim()) throw new Error(`${name} is obsolete; use FACILITATOR_SIGNER_*`);
}

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

// FACILITATOR_SIGNER_* is this wallet's only name across every service.
function readRelayerKey(): Hex {
    const value =
        process.env.FACILITATOR_SIGNER_PRIVATE_KEY?.trim() ??
        "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("FACILITATOR_SIGNER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readRelayerAddress(): Address {
    const value =
        process.env.FACILITATOR_SIGNER_ADDRESS?.trim() ?? "";
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

/**
 * A tenth of the day unless set. A day under 10 wei — a dry-run figure for exercising
 * `budget_exhausted` — has no tenth, and is refused naming that: handing the "0" to the
 * integer check blamed RELAYER_PAYER_DAILY_WEI, which the operator never wrote. Larger
 * than the day is refused rather than clamped: a share above the ceiling is a
 * configuration that says one thing and does another.
 */
function readPayerShare(dailyWei: bigint): bigint {
    const tenth = dailyWei / 10n;
    if (tenth === 0n && !process.env.RELAYER_PAYER_DAILY_WEI?.trim()) {
        throw new Error(
            "RELAYER_DAILY_WEI under 10 wei leaves no default payer share; set RELAYER_PAYER_DAILY_WEI",
        );
    }
    const share = readPositiveInteger("RELAYER_PAYER_DAILY_WEI", tenth);
    if (share > dailyWei) throw new Error("RELAYER_PAYER_DAILY_WEI must not exceed RELAYER_DAILY_WEI");
    return share;
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
// The day's ceiling bounds the operator's loss; it does not bound who causes it. Every
// redemption used to be charged to that one figure, and /settle takes any payTo and any
// amount from anyone holding a grant, so a payer who paid themselves with free testnet
// tUSDC could spend the whole day — about 1,500 calls — at zero cost, and every other
// seller got `budget_exhausted` until UTC midnight. A tenth of the day per payer means
// draining it takes ten funded grants, and nine of them leave room for everyone else.
const RELAYER_PAYER_DAILY_WEI = readPayerShare(RELAYER_DAILY_WEI);
// Requests per address per hour on /verify and /settle together, refused before the body
// is read. A real seller's payment is one /verify and one /settle, so the default admits
// 300 payments an hour from one address — more than the day's gas budget can settle —
// while a flood from one address stops costing RPC after its first 600 requests. Bounded
// to a number so the limiter's integer check sees an integer, as the receipt timeout is.
const FACILITATOR_RATE_PER_HOUR = Number(readPositiveInteger("FACILITATOR_RATE_PER_HOUR", 600n));
// How often the ledger's rejected rows are pruned to `rejectedRetention`: once at boot
// and hourly after. An hour of the worst flood is 600 rows — nothing against the
// 50,000 cap — and the delete is two indexed statements in one transaction.
const LEDGER_PRUNE_EVERY_MS = 3_600_000;
// The durable settlement journal allocates nonces; one coordinator owns this signer.
const relayer = privateKeyToAccount(readRelayerKey());
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
const budget = {
    spentToday: (now: number) => store.budget.load(budgetDay(now)),
    remaining: (now: number) => {
        const left = RELAYER_DAILY_WEI - store.budget.load(budgetDay(now));
        return left > 0n ? left : 0n;
    },
};
const limiter = new FixedWindowLimiter(FACILITATOR_RATE_PER_HOUR, RATE_WINDOW_MS);

/**
 * Housekeeping never takes the service down: a delete that fails (a locked file, a full
 * disk) is the operator's problem and is logged as one, like a ledger row that could not
 * be written. Silent when there was nothing to prune — the common hour.
 */
function pruneLedger(): void {
    try {
        const pruned = store.ledger.prune(rejectedRetention(Date.now()));
        if (pruned > 0) console.log(`[ledger] pruned ${pruned} rejected settlement events`);
    } catch (error) {
        console.error(`[ledger] rejected settlement events not pruned — ${redactForLog(error)}`);
    }
}
pruneLedger();
// unref'd: a timer must never be what keeps the process alive.
setInterval(pruneLedger, LEDGER_PRUNE_EVERY_MS).unref();

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const facilitatorClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

type Receipt = Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;

const startupVerification = await verifyActiveFrameworkDeployment({
    publicClient,
    deployment,
    manifest,
    expectedFrameworkAdmin: frameworkAdmin,
});
// The operator sees the redacted reason here, once per probe; the wire sees a closed
// enum from `classifyFrameworkError`. Logging in the handler instead would repeat one
// failure for every caller that shared the probe.
//
// A failed readiness probe is not the window's answer: its callers are payments, and a
// single timed-out read out of the ten must not become five seconds of every seller
// being refused. The next caller probes again. The balance read is the other way round —
// see `CachedProbeOptions`.
const readiness = new CachedProbe(
    async () => {
        try {
            return await verifyFrameworkOperationalState({
                publicClient,
                deployment,
                expectedFrameworkAdmin: frameworkAdmin,
            });
        } catch (error) {
            console.error(`[readiness] framework verification failed — ${redactForLog(error)}`);
            throw error;
        }
    },
    {ttlMs: PROBE_TTL_MS, cacheFailures: false},
);
readiness.prime(startupVerification);
const relayerBalance = new CachedProbe(
    async () => {
        try {
            return await publicClient.getBalance({address: relayer.address});
        } catch (error) {
            console.error(`[health] relayer balance not read — ${redactForLog(error)}`);
            throw error;
        }
    },
    {ttlMs: PROBE_TTL_MS, cacheFailures: true},
);

/** Pre-broadcast refusals are best-effort diagnostics; terminal accounting is atomic in the journal. */
function recordRejection(event: SettlementEventInput): void {
    try {store.ledger.record(event);}
    catch (error) {console.error(`[ledger] rejection not recorded — ${redactForLog(error)}`);}
}

class SettlementCoordinator {
    readonly #recovery = new SettlementRecovery(store.settlements, relayer.address, giwaSepolia.id,
        {total: RELAYER_DAILY_WEI, payer: RELAYER_PAYER_DAILY_WEI});

    /**
     * Simulate the redemption against live state and price its gas. Nothing in here can
     * broadcast — a simulation revert or a gas-cap refusal charges nobody — so a throw
     * from this method is a genuine rejection on `/verify` and `/settle` alike, with one
     * exception both callers make: the RPC failing to answer is no verdict, and each
     * wraps this stage in `beforeBroadcast` so that failure reaches its route as
     * `RpcUnreachableBeforeBroadcast` — answered not-ready, recorded nowhere.
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
        // A retry resolves the original transaction in /settle. Re-simulation would
        // reject an already consumed or expired leaf before its receipt can be recovered.
        if (this.#recovery.transaction(payment.paymentIntentId)) return;
        await beforeBroadcast(() => this.#prepareRedemption(payment));
    }

    async settle(payment: ValidatedDelegatedPayment): Promise<Erc7710SettleResponse> {
        try {
            const record = await this.#recovery.settle({paymentIntentId: payment.paymentIntentId,
                payer: payment.payer, payTo: payment.paymentRequirements.payTo, amountBase: payment.amount}, {
                pendingNonce: () => beforeBroadcast(() => publicClient.getTransactionCount({address: relayer.address, blockTag: "pending"})),
                prepare: async (nonce) => {
                    const {gas} = await beforeBroadcast(() => this.#prepareRedemption(payment));
                    const fees = await beforeBroadcast(() => publicClient.estimateFeesPerGas());
                    return this.#sign(payment, {nonce, gas, ...fees});
                },
                restore: (envelope) => this.#sign(payment, envelope),
                receipt: async (hash) => {
                    try {return await publicClient.getTransactionReceipt({hash});}
                    catch (error) {if (error instanceof TransactionReceiptNotFoundError) return null; throw error;}
                },
                send: (serializedTransaction) => facilitatorClient.sendRawTransaction({serializedTransaction}),
                wait: (hash) => this.#awaitReceipt(hash),
                failure: (receipt) => receiptFailure(receipt, payment),
            });
            return settlementResponse(record);
        } catch (error) {
            const failure = describeFailure(error);
            if (failure.outcome === "rejected") recordRejection({kind: "settle", payer: payment.payer,
                payTo: payment.paymentRequirements.payTo, amountBase: payment.amount, at: Date.now(),
                outcome: "rejected", errorCode: failure.errorCode});
            throw error;
        }
    }

    async #sign(payment: ValidatedDelegatedPayment, envelope: {nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}) {
        const transfer = buildDelegatedTransfer(payment);
        const data = DelegationManager.encode.redeemDelegations({delegations: [...transfer.delegations],
            modes: [...transfer.modes], executions: transfer.executions.map((batch) => [...batch])});
        return facilitatorClient.signTransaction({to: manager, data, type: "eip1559", chainId: giwaSepolia.id,
            nonce: envelope.nonce, gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas,
            maxPriorityFeePerGas: envelope.maxPriorityFeePerGas});
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

// Public: the tunnel's catch-all forwards it, and facilitator.mapae.io/health answers
// anyone. Everything here is either a closed enum or an address that is already on
// chain; the one free-text field it used to carry is now a log line.
app.get("/health", async (c) => {
    let framework: FrameworkLiveVerification | undefined;
    // Why it is unhealthy, not just that it is. Verification throws for a paused
    // manager, an unexpected owner, and an unreachable RPC alike, so without this
    // every one of them looks identical: ok=false. As one of four words, so the reason
    // never becomes an oracle for a caller — the redacted text said which RPC host was
    // down and which viem was talking to it. `frameworkPaused` is read off the same
    // word: a verification that threw returned no flag, so the pause is only ever known
    // through its classification.
    let frameworkError: FrameworkHealthError | null = null;
    try {
        framework = await readiness.read();
    } catch (error) {
        frameworkError = classifyFrameworkError(error);
    }
    // Degrade like the framework check above rather than throwing: a health probe
    // that 500s when the RPC blips tells the operator less than one that reports
    // which dependency is down.
    const balance = await relayerBalance.read().catch(() => undefined);
    // The remaining budget is deliberately not here. "How much gas is left today" is a
    // targeting number for anyone deciding whether draining the day is worth it; it is
    // reported behind /metrics' token.
    return c.json({
        ok: Boolean(framework) && balance !== undefined && balance > 0n,
        network: GIWA_SEPOLIA_CAIP2,
        composition: deployment.compositionId,
        delegationManager: manager,
        frameworkOwner: framework?.owner ?? null,
        frameworkPaused: frameworkPausedFrom(frameworkError),
        frameworkError,
        facilitator: relayer.address,
        relayerFunded: balance === undefined ? null : balance > 0n,
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

// One window for both routes: a payment is one /verify and one /settle, and a flood is a
// flood whichever of the two it picks. The limiter runs before the readiness probe and
// before the body is read, so a refused request costs a Map lookup and no RPC.
app.use("/verify", rateLimitByIp(limiter, VERIFY_RATE_LIMITED));
app.use("/settle", rateLimitByIp(limiter, SETTLE_RATE_LIMITED));
// After the limiter and before the body: a caller whose probe failed is told the
// facilitator was not ready, not that its delegation was refused — no verdict exists.
app.use("/verify", requireReadiness(readiness, VERIFY_NOT_READY));
app.use("/settle", requireReadiness(readiness, SETTLE_NOT_READY));

app.route("/", createPaymentRoutes({
    validate: (body) => validateDelegatedPayment(body, {delegationManager: manager,
        facilitator: relayer.address, maxAmount: MAX_AMOUNT}),
    simulate: (payment) => coordinator.simulate(payment),
    settle: (payment) => coordinator.settle(payment),
}));

// `manager` is already `getAddress(...)`-checked at construction, which throws on
// anything malformed — a second check here could never fire while reading like a
// real guard.
console.log(`ERC-7710 facilitator listening on ${HOST}:${PORT}`);
console.log(`  network ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  manager ${manager}`);
console.log(`  signer  ${relayer.address}`);
console.log(`  store   ${STORE_PATH}`);
console.log(`  budget  ${RELAYER_DAILY_WEI} wei/day (RELAYER_DAILY_WEI)`);
console.log(`  payer   ${RELAYER_PAYER_DAILY_WEI} wei/day per payer (RELAYER_PAYER_DAILY_WEI)`);
console.log(`  rate    ${FACILITATOR_RATE_PER_HOUR}/hour per IP (FACILITATOR_RATE_PER_HOUR)`);
console.log(`  metrics ${METRICS_TOKEN === undefined ? "disabled (METRICS_TOKEN unset)" : "enabled"}`);

// Bun reads the object as `Bun.serve` options; `maxRequestBodySize` is the byte cap
// above — a 413 from Bun for anything over it, with buffering bounded at the cap.
export default {hostname: HOST, port: PORT, fetch: app.fetch, maxRequestBodySize: MAX_BODY_BYTES};
