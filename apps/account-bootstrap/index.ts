import {Hono, type Context} from "hono";
import {
    FRAMEWORK_COMPOSITION_ID,
    PaymentIntentSingleFlight,
    SpendBudget,
    assertFundedKeySeparation,
    buildSponsoredBootstrapApproval,
    costOfReceipt,
    judgeCorsRequest,
    parseActiveDeploymentArtifactJson,
    parseBootstrapOrigins,
    readRenamedEnv,
    throttledHttp,
    validateAccountBootstrap,
    type AccountBootstrapPolicy,
    type ValidatedAccountBootstrap,
} from "@mapae/delegation";
import {FaucetGate, planTopUp, readFaucetConfig} from "@mapae/delegation/faucet-policy";
import {openStore} from "@mapae/store";
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
    | "origin_refused"
    | "bootstrap_disabled"
    | "malformed_request"
    | "faucet_recently_used"
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
 *
 * Wallet variable names are global: one wallet, one name, in every service. The
 * facilitator's signer is `FACILITATOR_SIGNER_ADDRESS` here for the same reason it is in
 * the revocation submitter — this file used to call it `RELAYER_ADDRESS` while the
 * submitter used the same spelling for its *own* sender, and that collision of meanings is
 * how a settlement key nearly became another service's broadcast sender. The legacy name
 * still works with a warning so the live mini `.env` keeps booting through the rename.
 */
function readFacilitatorSignerReference(): Address | undefined {
    const value = readRenamedEnv({
        current: "FACILITATOR_SIGNER_ADDRESS",
        legacy: "RELAYER_ADDRESS",
    });
    if (value === undefined) return undefined;
    if (!isAddress(value)) throw new Error("FACILITATOR_SIGNER_ADDRESS must be an address");
    return getAddress(value);
}
assertFundedKeySeparation({
    BOOTSTRAP_ADDRESS: sponsor.address,
    FACILITATOR_SIGNER_ADDRESS: readFacilitatorSignerReference(),
    DEPLOYER_ADDRESS: readOptionalAddressEnv("DEPLOYER_ADDRESS"),
    REVOCATION_SPONSOR_ADDRESS: readOptionalAddressEnv("REVOCATION_SPONSOR_ADDRESS"),
});

const deployment = await readDeployment();

const policy: AccountBootstrapPolicy = {
    environment: deployment.environment,
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
const RECEIPT_TIMEOUT_MS = Number(readPositiveInteger("BOOTSTRAP_RECEIPT_TIMEOUT_MS", 60_000n));
/** `:memory:` is accepted for dry runs; anything else is a file whose directory is created. */
const STORE_PATH = process.env.STORE_PATH?.trim() || "./data/bootstrap.sqlite";

/**
 * The testnet faucet leg: on by default, and pinned to the testnet by the artifact.
 *
 * `MockUSDC.mint` is permissionless, so this grants no authority the caller lacks — it
 * only spends our gas. It exists because a deployed account with an empty token balance
 * still cannot pay, and "your account exists now" is a useless kind of done. On mainnet
 * there is no mint: the user funds the account with real value, which they can do at the
 * counterfactual address before deployment because an ERC-20 balance is the token
 * contract's storage.
 *
 * The pin is the *deployment artifact's* chain id compared against the chain this service
 * signs for — not a literal. A mainnet artifact would fail to parse today, and if that
 * ever changes the faucet turns itself off here rather than needing someone to remember a
 * number. The policy itself (target, window, defaults) lives in `faucet-policy.ts`.
 */
const FAUCET = readFaucetConfig(process.env);
const FAUCET_ENABLED = FAUCET.enabled && deployment.chainId === giwaSepolia.id;
const FAUCET_TARGET = FAUCET_ENABLED ? FAUCET.target : 0n;

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const sponsorClient = createWalletClient({
    account: sponsor,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

const faucetGate = new FaucetGate();
// The day's charged gas lives in the store, so a redeploy resumes the budget instead of
// resetting it — the one bound that is a real guarantee must not be a restart away.
const store = openStore(STORE_PATH);
const budget = new SpendBudget(DAILY_BUDGET, Date.now(), store.budget);
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
    /** Base units this request minted; `"0"` when the balance already met the target or the faucet is off. */
    mintedBase: string;
    /** The balance the faucet tops up to, in base units; `"0"` when the faucet is off. */
    targetBase: string;
    network: typeof GIWA_SEPOLIA_CAIP2;
}

/** What one mint attempt came to. `minted` is `0n` unless the receipt confirmed it. */
interface Funding {
    hash?: Hex;
    minted: bigint;
    charged: bigint;
}

const NOT_FUNDED: Funding = {minted: 0n, charged: 0n};

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
        const funded = await topUp(validated.account);
        return {
            status: "already_deployed",
            account: validated.account,
            fundingTransaction: funded.hash,
            mintedBase: String(funded.minted),
            targetBase: String(FAUCET_TARGET),
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

        // The same plan as the recovery path: a counterfactual address can already hold
        // tokens, so a fresh deploy tops up the shortfall rather than minting a fixed grant.
        // Anything the plan refuses is not a refusal of *this* request — the account is
        // deployed, which is what the caller asked for — so it is reported as "0 minted".
        let funded = NOT_FUNDED;
        const plan = await planFaucet(validated.account, Date.now());
        if (plan.kind === "mint") {
            funded = await fund(validated.account, plan.amount, mintReservation);
            charged += funded.charged;
        }

        return {
            status: "deployed",
            account: validated.account,
            transaction: hash,
            fundingTransaction: funded.hash,
            mintedBase: String(funded.minted),
            targetBase: String(FAUCET_TARGET),
            network: GIWA_SEPOLIA_CAIP2,
        };
    } finally {
        budget.settle(reservation, charged, Date.now());
    }
}

type FaucetPlan =
    | {kind: "off"}
    /** The token balance could not be read; nothing is decided, and nothing is minted. */
    | {kind: "unreadable"}
    /** The balance already meets the target. */
    | {kind: "satisfied"}
    /** The account drew its top-up within the last window. */
    | {kind: "recently_used"}
    | {kind: "mint"; amount: bigint};

/**
 * What the faucet policy says about `account` right now.
 *
 * One reading for both branches, so a fresh deploy and a returning account cannot drift
 * about what "topped up" means. The gate is consulted only once a shortfall exists — an
 * account at its target is never told to wait, because it was never going to be minted to.
 */
async function planFaucet(account: Address, now: number): Promise<FaucetPlan> {
    if (!FAUCET_ENABLED) return {kind: "off"};
    let balance: bigint;
    try {
        balance = await publicClient.readContract({
            address: MOCK_USDC.address,
            abi: BALANCE_ABI,
            functionName: "balanceOf",
            args: [account],
        });
    } catch (error) {
        console.warn(`[bootstrap] balance read failed, no top-up — ${redactForLog(error)}`);
        return {kind: "unreadable"};
    }
    const amount = planTopUp({balance, target: FAUCET_TARGET});
    if (amount === 0n) return {kind: "satisfied"};
    if (!faucetGate.allows(account, now)) return {kind: "recently_used"};
    return {kind: "mint", amount};
}

/**
 * Bring a deployed account back up to the target.
 *
 * This is the branch Studio's "get testnet balance" button lands on, and the retry path
 * for a mint that failed after a successful deploy — the payer holds no ETH by design, so
 * it has no way to fund itself. `MockUSDC.mint` is permissionless, so this grants no
 * authority the caller lacks; it spends our gas, bounded by the per-account window and
 * the daily budget, and the mint costs a quarter of the deploy the caller could already
 * ask for.
 *
 * Here the top-up *is* the request, so what the deploy branch reports as "0 minted" is
 * refused out loud: a closed window is a 429 the user can read as "tomorrow", and a budget
 * or sponsor that cannot pay is the same refusal a deploy would get.
 */
async function topUp(account: Address): Promise<Funding> {
    const now = Date.now();
    const plan = await planFaucet(account, now);
    switch (plan.kind) {
        case "off":
        case "satisfied":
            return NOT_FUNDED;
        case "unreadable":
            throw new Refused("bootstrap_unavailable", 503);
        case "recently_used":
            throw new Refused("faucet_recently_used", 429);
        case "mint":
            break;
    }

    const reservation = MAX_MINT_GAS * MAX_FEE_PER_GAS;
    const sponsorBalance = await publicClient.getBalance({address: sponsor.address});
    if (sponsorBalance < MIN_SPONSOR_BALANCE + reservation) throw new Refused("sponsor_unfunded", 503);
    if (!budget.reserve(reservation, now)) throw new Refused("budget_exhausted", 503);
    let charged = 0n;
    try {
        const funded = await fund(account, plan.amount, reservation);
        charged = funded.charged;
        if (funded.hash === undefined) throw new Refused("bootstrap_unavailable", 502);
        return funded;
    } finally {
        budget.settle(reservation, charged, Date.now());
    }
}

/**
 * Mint `amount` to the account, and never let the attempt's failure escape.
 *
 * On the deploy path the deploy is the expensive, irreversible half: throwing from here
 * used to turn a mined account into a 502, and the retry then took the `already_deployed`
 * path — which is what {@link topUp} now handles on purpose. So this reports rather than
 * throws, and the caller decides what a mint that did not land means for its request.
 *
 * The per-account window opens only on a confirmed receipt. Opening it at broadcast would
 * lock an account out for a day after a reverted or unobserved mint, which on a testnet is
 * the one outcome worse than minting twice.
 */
async function fund(account: Address, amount: bigint, reservation: bigint): Promise<Funding> {
    let charged = 0n;
    try {
        const hash = await sponsorClient.sendTransaction({
            to: MOCK_USDC.address,
            data: encodeFunctionData({
                abi: MINT_ABI,
                functionName: "mint",
                args: [account, amount],
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
        // would tell the user their account is funded while the balance is unchanged.
        if (receipt.status !== "success") return {minted: 0n, charged};
        faucetGate.record(account, Date.now());
        return {hash, minted: amount, charged};
    } catch (error) {
        console.warn(`[bootstrap] faucet leg failed — ${redactForLog(error)}`);
        return {minted: 0n, charged};
    }
}

const app = new Hono();

app.use("*", async (c, next) => {
    const decision = judgeCorsRequest(c.req.header("origin"), CORS_POLICY);
    if (!decision.allowed) {
        return refuse(c, "origin_refused", 403);
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
    const now = Date.now();
    faucetGate.sweep(now);
    return c.json({
        ok: ENABLED,
        enabled: ENABLED,
        network: GIWA_SEPOLIA_CAIP2,
        sponsor: sponsor.address,
        faucet: FAUCET_ENABLED,
        faucetTargetBase: String(FAUCET_TARGET),
        faucetAccountsInWindow: faucetGate.size,
        budgetRemainingWei: String(budget.remaining(now)),
        spentTodayWei: String(budget.spentToday(now)),
    });
});

app.post("/bootstrap", async (c) => {
    if (!ENABLED) return refuse(c, "bootstrap_disabled", 503);

    // No per-IP gate: it bounded the wrong thing. Keypairs are free and IPs are shared, so
    // it neither stopped a griefer nor let a shared office onboard twice in an hour. The
    // request costs nothing on chain until it proves it owns an account, and after that
    // the per-account faucet window and the daily gas budget are the bounds.
    faucetGate.sweep(Date.now());

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
            `[bootstrap] ${response.status} account=${response.account} tx=${response.transaction ?? "-"} minted=${response.mintedBase}`,
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
console.log(`  faucet    ${FAUCET_ENABLED} (target ${FAUCET_TARGET} base, one top-up per account per day)`);
console.log(`  daily     ${DAILY_BUDGET} wei`);
console.log(`  store     ${STORE_PATH}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
