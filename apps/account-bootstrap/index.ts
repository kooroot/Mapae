import {Hono, type Context} from "hono";
import {
    FRAMEWORK_COMPOSITION_ID,
    FixedWindowLimiter,
    PaymentIntentSingleFlight,
    SpendBudget,
    buildSponsoredBootstrapApproval,
    costOfReceipt,
    judgeCorsRequest,
    parseActiveDeploymentArtifactJson,
    parseBootstrapOrigins,
    throttledHttp,
    validateAccountBootstrap,
    type AccountBootstrapPolicy,
    type ValidatedAccountBootstrap,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    giwaSepolia,
    parseNodeRpcUrl,
    redactForLog,
} from "@mapae/shared";
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    getAddress,
    isAddress,
    parseAbi,
    publicActions,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount, nonceManager} from "viem/accounts";

const MAX_BODY_CHARACTERS = 150_000;
const MINT_ABI = parseAbi(["function mint(address to, uint256 value)"]);
const BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/**
 * Every refusal this service can emit, as a closed set.
 *
 * The body is an enum and nothing else — no `error.message`, no viem string, no address
 * beyond the account the caller already sent us. Two reasons, both measured rather than
 * stylistic. `apps/web/src/dapp/GrantOnboarding.tsx` renders a failure message straight
 * into the DOM, and `bun run check:logging` only covers `console.*`, so a response body is
 * the one sink no gate inspects. This service holds a funded key and a path-keyed RPC URL,
 * and viem embeds the whole transport URL in its errors.
 *
 * `apps/revocation-submitter` puts `redactForLog(error)` in its body only in its pinned
 * loopback mode, where it answers the account's own owner; its sponsored public mode uses
 * a closed enum for exactly the reasons above. This service answers the public internet.
 */
type BootstrapRefusal =
    | "bootstrap_disabled"
    | "malformed_request"
    | "rate_limited"
    | "budget_exhausted"
    | "sponsor_unfunded"
    | "fee_too_high"
    | "gas_estimate_rejected"
    | "bootstrap_unavailable";

function readPort(): number {
    const value = Number(process.env.PORT ?? 8083);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return value;
}

function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    // Literal list, not `isLoopbackHost`: that helper accepts `0.0.0.0`, which is right for
    // a destination and is the one value a bind must refuse.
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; the Cloudflare Tunnel is the only public path");
    }
    return value;
}

function readBootstrapKey(): Hex {
    const value = process.env.BOOTSTRAP_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("BOOTSTRAP_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readAddressEnv(name: string): Address {
    const value = process.env[name]?.trim() ?? "";
    if (!isAddress(value)) throw new Error(`${name} must be an address`);
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error(`${name} must not be zero`);
    return address;
}

function readOptionalAddressEnv(name: string): Address | undefined {
    const value = process.env[name]?.trim();
    if (!value) return undefined;
    if (!isAddress(value)) throw new Error(`${name} must be an address`);
    return getAddress(value);
}

function readPositiveInteger(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim() || String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw);
}

function readFlag(name: string): boolean {
    return (process.env[name]?.trim().toLowerCase() ?? "false") === "true";
}

async function readDeployment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ?? "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`delegation deployment artifact not found: ${path}`);
    }
    return parseActiveDeploymentArtifactJson(await file.text());
}

const HOST = readHost();
const PORT = readPort();
const RPC_URL = parseNodeRpcUrl(
    process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
);

/**
 * The kill switch, and it defaults to off.
 *
 * Same posture as `deploy:preview`'s `broadcast BLOCKED`: a service that spends the
 * operator's money should not start spending it because a deployment forgot a variable.
 */
const ENABLED = readFlag("BOOTSTRAP_ENABLED");

/**
 * The approval phrase, checked at boot and pinned to the composition.
 *
 * A per-request phrase is impossible for an always-on service, so the approval is granted
 * once to a service *shape*. Pinning it to the composition means a framework redeploy —
 * which changes exactly which contracts the sponsor pays to instantiate — invalidates the
 * approval instead of silently inheriting it.
 */
const EXPECTED_APPROVAL = buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID);
if (ENABLED && process.env.BOOTSTRAP_APPROVAL?.trim() !== EXPECTED_APPROVAL) {
    throw new Error(
        `BOOTSTRAP_ENABLED is true but BOOTSTRAP_APPROVAL does not match this composition; expected ${EXPECTED_APPROVAL}`,
    );
}

const sponsor = privateKeyToAccount(readBootstrapKey(), {nonceManager});
const expectedSponsor = readAddressEnv("BOOTSTRAP_ADDRESS");
if (sponsor.address !== expectedSponsor) {
    throw new Error(
        `BOOTSTRAP_PRIVATE_KEY resolves to ${sponsor.address}, expected ${expectedSponsor}`,
    );
}

/**
 * Key separation, enforced rather than remembered.
 *
 * The facilitator relayer is treated as a single-consumer key across this repo — the
 * hosting runbook already forbids two facilitator instances because a shared nonce space
 * drops in-flight settlements. A sponsor driven at internet request rate would be a third
 * consumer, and the failure would not be an ETH loss but a settlement outage. The deployer
 * is worse still: five call sites, none of them using `nonceManager`.
 */
for (const name of ["RELAYER_ADDRESS", "DEPLOYER_ADDRESS"] as const) {
    const other = readOptionalAddressEnv(name);
    if (other && other === sponsor.address) {
        throw new Error(
            `BOOTSTRAP_ADDRESS must differ from ${name}; a shared nonce space would stall settlement`,
        );
    }
}

const deployment = await readDeployment();

const policy: AccountBootstrapPolicy = {
    environment: deployment.environment,
    chainId: giwaSepolia.id,
    approval: EXPECTED_APPROVAL,
};

/** 1.32x the measured 189,374 for a HybridDeleGator proxy. Larger is a different shape. */
const MAX_DEPLOY_GAS = readPositiveInteger("MAX_BOOTSTRAP_GAS", 250_000n);
const MAX_MINT_GAS = readPositiveInteger("MAX_BOOTSTRAP_MINT_GAS", 100_000n);
/** ~50x the measured 1,000,266 wei. A fee spike above this is the operator's call. */
const MAX_FEE_PER_GAS = readPositiveInteger("MAX_BOOTSTRAP_FEE_PER_GAS", 50_000_000n);
/**
 * The tip, set explicitly because viem's default is 1 gwei and that is 20x this service's
 * whole fee cap on an L2 whose measured gas price is ~0.001 gwei.
 *
 * Leaving it unset does not merely overpay — the node refuses the transaction outright
 * (`tip cannot be higher than the fee cap`), so every deployment fails at broadcast with
 * an error that reads like a node problem. Found by the e2e rather than in production,
 * which is the only reason it is a comment and not an incident.
 */
const PRIORITY_FEE_PER_GAS = readPositiveInteger("BOOTSTRAP_PRIORITY_FEE_WEI", 1_000_000n);
if (PRIORITY_FEE_PER_GAS > MAX_FEE_PER_GAS) {
    throw new Error(
        "BOOTSTRAP_PRIORITY_FEE_WEI must not exceed MAX_BOOTSTRAP_FEE_PER_GAS; the node would refuse every broadcast",
    );
}
const MIN_SPONSOR_BALANCE = readPositiveInteger("BOOTSTRAP_MIN_BALANCE_WEI", 1_000_000_000_000n);
const DAILY_BUDGET = readPositiveInteger("BOOTSTRAP_DAILY_WEI", 500_000_000_000_000n);
const RATE_PER_HOUR = Number(readPositiveInteger("BOOTSTRAP_RATE_PER_HOUR", 20n));
const RECEIPT_TIMEOUT_MS = Number(readPositiveInteger("BOOTSTRAP_RECEIPT_TIMEOUT_MS", 60_000n));

/**
 * The testnet faucet leg, off by default and pinned to the testnet chain id.
 *
 * `MockUSDC.mint` is permissionless, so this grants no authority the caller lacks — it
 * only spends our gas. It exists because a deployed account with a zero token balance
 * still cannot pay, and "your account exists now" is a useless kind of done. On mainnet
 * there is no mint: the user funds the account with real value, which they can do at the
 * counterfactual address before deployment because an ERC-20 balance is the token
 * contract's storage. The chain-id pin below is what keeps that from being a flag away.
 */
const FAUCET_ENABLED = readFlag("BOOTSTRAP_FAUCET_ENABLED") && giwaSepolia.id === 91_342;
const FAUCET_AMOUNT = readPositiveInteger("BOOTSTRAP_FAUCET_AMOUNT_BASE", 3_000_000n);

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const sponsorClient = createWalletClient({
    account: sponsor,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

const limiter = new FixedWindowLimiter(RATE_PER_HOUR, 3_600_000);
const budget = new SpendBudget(DAILY_BUDGET, Date.now());
const singleFlight = new PaymentIntentSingleFlight<BootstrapResponse>();

const CORS_POLICY = {
    allowedOrigins: parseBootstrapOrigins(process.env.BOOTSTRAP_ALLOWED_ORIGINS, [
        "https://app.mapae.io",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ]),
};

interface BootstrapResponse {
    status: "deployed" | "already_deployed";
    account: Address;
    transaction?: Hex;
    fundingTransaction?: Hex;
    network: typeof GIWA_SEPOLIA_CAIP2;
}

class Refused extends Error {
    constructor(readonly refusal: BootstrapRefusal, readonly httpStatus: number) {
        super(refusal);
        this.name = "Refused";
    }
}

/**
 * Deploy one account, charging the budget for what it actually cost.
 *
 * Ordering matters and is not arbitrary: every check that can refuse without spending runs
 * before the reservation, the reservation happens before the broadcast so a concurrent
 * request cannot double-spend the same budget, and the settle is in a `finally` so a
 * thrown broadcast still returns the hold. A reverted deploy charges its real gas — a
 * griefer whose transactions always revert must not ride for free.
 */
async function bootstrap(validated: ValidatedAccountBootstrap): Promise<BootstrapResponse> {
    const existing = await publicClient.getCode({address: validated.account});
    if (existing && existing !== "0x") {
        return {
            status: "already_deployed",
            account: validated.account,
            fundingTransaction: await topUp(validated.account),
            network: GIWA_SEPOLIA_CAIP2,
        };
    }

    const [balance, block] = await Promise.all([
        publicClient.getBalance({address: sponsor.address}),
        publicClient.getBlock({blockTag: "latest"}),
    ]);
    if (balance < MIN_SPONSOR_BALANCE) throw new Refused("sponsor_unfunded", 503);

    // A base fee we cannot read is not a base fee of zero. Refuse rather than guess — the
    // same trap `judgeSubmissionReadiness` documents on the revocation path.
    const baseFee = block.baseFeePerGas;
    if (baseFee === null || baseFee === undefined) throw new Refused("bootstrap_unavailable", 503);
    if (baseFee > MAX_FEE_PER_GAS) throw new Refused("fee_too_high", 503);

    let deployGas: bigint;
    try {
        deployGas = await publicClient.estimateGas({
            account: sponsor,
            to: validated.factoryTarget,
            data: validated.factoryData,
            value: 0n,
        });
    } catch {
        throw new Refused("gas_estimate_rejected", 400);
    }
    if (deployGas > MAX_DEPLOY_GAS) throw new Refused("gas_estimate_rejected", 400);

    const mintReservation = FAUCET_ENABLED ? MAX_MINT_GAS * MAX_FEE_PER_GAS : 0n;
    const deployReservation = deployGas * MAX_FEE_PER_GAS;
    const reservation = deployReservation + mintReservation;

    // The node's own upfront rule is `balance >= gasLimit * maxFeePerGas`, which is exactly
    // the reservation. Checking only MIN_SPONSOR_BALANCE (a floor, not a cost) left a band
    // where the gate passed and then every broadcast was refused by the node — the caller
    // got an opaque 502 instead of the `sponsor_unfunded` that tells the operator to top up.
    if (balance < MIN_SPONSOR_BALANCE + reservation) throw new Refused("sponsor_unfunded", 503);
    if (!budget.reserve(reservation, Date.now())) throw new Refused("budget_exhausted", 503);

    let charged = 0n;
    try {
        const hash = await sponsorClient.sendTransaction({
            to: validated.factoryTarget,
            data: validated.factoryData,
            value: 0n,
            gas: deployGas,
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
        });
        // The sponsor's gas is committed the moment the node accepts this. Anything that
        // throws from here — a receipt timeout, a transient RPC error — leaves a
        // transaction that still mines, so the pessimistic charge goes in *now* and the
        // measured one replaces it. Settling 0 for a broadcast we merely failed to observe
        // is how a daily cap quietly stops bounding anything.
        charged = deployReservation;
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: RECEIPT_TIMEOUT_MS,
        });
        charged = costOfReceipt(receipt, deployReservation);
        if (receipt.status !== "success") throw new Refused("bootstrap_unavailable", 502);

        let fundingTransaction: Hex | undefined;
        if (FAUCET_ENABLED) {
            const funded = await fund(validated.account, mintReservation);
            charged += funded.charged;
            fundingTransaction = funded.hash;
        }

        return {
            status: "deployed",
            account: validated.account,
            transaction: hash,
            fundingTransaction,
            network: GIWA_SEPOLIA_CAIP2,
        };
    } finally {
        budget.settle(reservation, charged, Date.now());
    }
}

/**
 * Recover an account that was deployed but never funded.
 *
 * Without this the faucet is one-shot: a mint that failed after a successful deploy could
 * never be retried, because every later request takes the `already_deployed` branch — and
 * the payer holds no ETH by design, so it has no way to fund itself. `MockUSDC.mint` is
 * permissionless, so this grants no authority the caller lacks; it spends our gas, bounded
 * by the same rate limit and daily budget as everything else, and the mint costs a quarter
 * of the deploy the caller could already ask for.
 *
 * Only at a balance of exactly zero. A partial balance is the user's business.
 */
async function topUp(account: Address): Promise<Hex | undefined> {
    if (!FAUCET_ENABLED) return undefined;
    let balance: bigint;
    try {
        balance = await publicClient.readContract({
            address: MOCK_USDC.address,
            abi: BALANCE_ABI,
            functionName: "balanceOf",
            args: [account],
        });
    } catch (error) {
        console.warn(`[bootstrap] balance read failed, skipping top-up — ${redactForLog(error)}`);
        return undefined;
    }
    if (balance > 0n) return undefined;

    const reservation = MAX_MINT_GAS * MAX_FEE_PER_GAS;
    const sponsorBalance = await publicClient.getBalance({address: sponsor.address});
    if (sponsorBalance < MIN_SPONSOR_BALANCE + reservation) return undefined;
    if (!budget.reserve(reservation, Date.now())) return undefined;
    let charged = 0n;
    try {
        const funded = await fund(account, reservation);
        charged = funded.charged;
        return funded.hash;
    } finally {
        budget.settle(reservation, charged, Date.now());
    }
}

/**
 * Mint the testnet float, and never let its failure discard a successful deploy.
 *
 * The deploy is the expensive, irreversible half. Throwing from here used to turn a mined
 * account into a 502, and the retry then took the `already_deployed` path — which is why
 * the top-up branch above exists as the recovery.
 */
async function fund(account: Address, reservation: bigint): Promise<{hash?: Hex; charged: bigint}> {
    let charged = 0n;
    try {
        const hash = await sponsorClient.sendTransaction({
            to: MOCK_USDC.address,
            data: encodeFunctionData({
                abi: MINT_ABI,
                functionName: "mint",
                args: [account, FAUCET_AMOUNT],
            }),
            value: 0n,
            gas: MAX_MINT_GAS,
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
        });
        charged = reservation;
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: RECEIPT_TIMEOUT_MS,
        });
        charged = costOfReceipt(receipt, reservation);
        // A reverted mint is not a funding. Reporting its hash as `fundingTransaction`
        // would tell the user their account is funded while the balance is zero.
        if (receipt.status !== "success") return {charged};
        return {hash, charged};
    } catch (error) {
        console.warn(`[bootstrap] faucet leg failed, account is deployed — ${redactForLog(error)}`);
        return {charged};
    }
}

const app = new Hono();

app.use("*", async (c, next) => {
    const decision = judgeCorsRequest(c.req.header("origin"), CORS_POLICY);
    if (!decision.allowed) {
        return c.json({network: GIWA_SEPOLIA_CAIP2, reason: "origin_refused"}, 403);
    }
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
});

app.options("/bootstrap", (c) => {
    const decision = judgeCorsRequest(c.req.header("origin"), CORS_POLICY, true);
    if (!decision.allowed) return c.body(null, 403);
    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
    return c.body(null, 204);
});

/**
 * Operator-facing, and deliberately not in the tunnel's ingress.
 *
 * It reports the sponsor's address, its balance and the remaining budget — a targeting
 * oracle for anyone deciding whether a griefing run is worth starting. The facilitator's
 * `/health` is public, but that was a separate judgement about a service whose spend is
 * bound by on-chain caveats; there is no reason to inherit it here.
 */
app.get("/health", (c) => {
    limiter.sweep(Date.now());
    return c.json({
        ok: ENABLED,
        enabled: ENABLED,
        network: GIWA_SEPOLIA_CAIP2,
        sponsor: sponsor.address,
        faucet: FAUCET_ENABLED,
        budgetRemainingWei: String(budget.remaining(Date.now())),
        spentTodayWei: String(budget.spentToday(Date.now())),
        rateLimiterKeys: limiter.size,
    });
});

app.post("/bootstrap", async (c) => {
    if (!ENABLED) return refuse(c, "bootstrap_disabled", 503);

    // Rate limit before any chain read, so an unauthenticated flood costs us nothing.
    // Cloudflare sets `CF-Connecting-IP`; the tunnel is the only public path, so a request
    // arriving without it came over loopback.
    const requester = c.req.header("cf-connecting-ip") ?? "loopback";
    const now = Date.now();
    limiter.sweep(now);
    if (!limiter.tryConsume(requester, now)) return refuse(c, "rate_limited", 429);

    let validated: ValidatedAccountBootstrap;
    try {
        validated = await validateAccountBootstrap(await readJson(c), policy);
    } catch (error) {
        console.error(`[bootstrap] rejected — ${redactForLog(error)}`);
        return refuse(c, "malformed_request", 400);
    }

    try {
        const response = await singleFlight.run(validated.account, () => bootstrap(validated));
        console.log(
            `[bootstrap] ${response.status} account=${response.account} tx=${response.transaction ?? "-"}`,
        );
        return c.json(response);
    } catch (error) {
        console.error(`[bootstrap] failed — ${redactForLog(error)}`);
        if (error instanceof Refused) return refuse(c, error.refusal, error.httpStatus);
        return refuse(c, "bootstrap_unavailable", 502);
    }
});

function refuse(c: Context, reason: BootstrapRefusal, status: number) {
    // `as never` narrows Hono's literal status union; every value used here is a real code.
    return c.json({network: GIWA_SEPOLIA_CAIP2, reason}, status as never);
}

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

console.log(`account bootstrap listening on ${HOST}:${PORT}`);
console.log(`  network   ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  enabled   ${ENABLED}`);
console.log(`  sponsor   ${sponsor.address}`);
console.log(`  faucet    ${FAUCET_ENABLED}`);
console.log(`  daily     ${DAILY_BUDGET} wei`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
