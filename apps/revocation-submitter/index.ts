import {Hono, type Context} from "hono";
import {
    FRAMEWORK_COMPOSITION_ID,
    FixedWindowLimiter,
    PaymentIntentSingleFlight,
    SpendBudget,
    buildPrefundDepositCall,
    buildSponsoredRevocationApproval,
    costOfReceipt,
    isDelegationRevoked,
    judgeCorsRequest,
    judgeSubmissionReadiness,
    parseActiveDeploymentArtifactJson,
    parseBootstrapOrigins,
    parseCorsAllowlist,
    readRevocationPrefundState,
    throttledHttp,
    validateRevocationSubmission,
    verifyRevocationSignature,
    type RevocationSubmissionPolicy,
    type ValidatedRevocationSubmission,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    giwaSepolia,
    isLoopbackHost,
    parseNodeRpcUrl,
    redactForLog,
} from "@mapae/shared";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {
    createPublicClient,
    createWalletClient,
    encodeAbiParameters,
    getAddress,
    isAddress,
    keccak256,
    parseEventLogs,
    publicActions,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount, nonceManager} from "viem/accounts";

const MAX_BODY_CHARACTERS = 150_000;

/**
 * Every refusal this service can emit, as a closed set.
 *
 * In sponsored mode the body is one of these and the caller's own numbers, nothing else —
 * no `error.message`, no viem string. That mode answers the public internet through the
 * tunnel, `check:logging` covers `console.*` but not response bodies, and viem embeds the
 * whole transport URL (path key included) in its errors. The pinned loopback mode keeps a
 * verbose `detail.message` because it answers the account's own owner about their own kill
 * switch on the same machine — the split `apps/account-bootstrap` documents.
 */
type RevokeRefusal =
    | "origin_refused"
    | "invalid_submission"
    | "rate_limited"
    | "already_revoked"
    | "invalid_account_signature"
    | "sender_busy"
    | "budget_exhausted"
    | "sponsor_unfunded"
    | "prefund_short"
    | "base_fee_unreadable"
    | "fee_below_basefee"
    | "relayer_unfunded"
    | "submission_failed";

function readPort(): number {
    const value = Number(process.env.PORT ?? 8082);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return value;
}

function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    // Literal list, not `isLoopbackHost`: that helper accepts `0.0.0.0`, which is right
    // for a destination and is the one value a bind must refuse.
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; the Cloudflare Tunnel is the only public path");
    }
    return value;
}

function readKeyEnv(name: string): Hex {
    const value = process.env[name]?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${name} must be a 32-byte hex private key`);
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
const RECEIPT_TIMEOUT_MS = Number(readPositiveInteger("REVOCATION_RECEIPT_TIMEOUT_MS", 60_000n));
/**
 * The tip the relayer offers, clamped per broadcast to the operation's own fee.
 *
 * 1,000,000 wei is what GIWA suggests and what this repo's other sponsor already uses. It
 * is stated rather than estimated for the same reason the bootstrap sponsor states it:
 * viem's default is 1 gwei, which exceeds the sponsored fee ceiling outright and makes the
 * node refuse every broadcast with an error that reads like a node problem.
 */
const RELAYER_PRIORITY_FEE_WEI = readPositiveInteger("RELAYER_PRIORITY_FEE_WEI", 1_000_000n);

// `nonceManager` because this service is now multi-tenant: `inFlightSenders` serialises
// one account against itself and `singleFlight` coalesces identical operations, but two
// different owners revoking at the same moment both reach `handleOps`. Without it viem
// fills both nonces from `eth_getTransactionCount(pending)`, the node refuses the second,
// and that owner gets a 502 *after* the sponsor already paid their deposit.
const relayer = privateKeyToAccount(readKeyEnv("RELAYER_PRIVATE_KEY"), {nonceManager});
const expectedRelayer = readAddressEnv("RELAYER_ADDRESS");
if (relayer.address !== expectedRelayer) {
    throw new Error(`RELAYER_PRIVATE_KEY resolves to ${relayer.address}, expected ${expectedRelayer}`);
}

const deployment = await readDeployment();
const entryPoint = getAddress(deployment.environment.EntryPoint);
const delegationManager = getAddress(deployment.environment.DelegationManager);

/**
 * Which of the two shapes this process is.
 *
 * `PAYER_ACCOUNT_ADDRESS` set → **pinned**: the original loopback deployment that serves
 * exactly one account, funded by that account's own EntryPoint deposit, driven by the
 * console. Unset → **sponsored**: the public shape behind the tunnel, serving any account
 * revoking its own grant, with the sponsor arming the deposit at revoke time. The mode is
 * structural rather than a flag so that deleting one env var cannot silently turn the
 * single-payer service into an open one — sponsored mode refuses to boot without the kill
 * switch, the approval phrase, and a dedicated sponsor key below.
 */
const PINNED_PAYER = readOptionalAddressEnv("PAYER_ACCOUNT_ADDRESS");
const SPONSORED = PINNED_PAYER === undefined;

/**
 * Ceilings default to the exact values the matching builder profile emits.
 *
 * This is not the usual "generous cap with headroom". Everything this service accepts is
 * built by one function in this repo, so anything larger is a differently-shaped
 * operation, and the operator should have to say so out loud rather than discover it from
 * a gas bill. In sponsored mode the fee ceiling is 1% of the pinned one: the prefund is
 * the *sponsor's* exposure — the EntryPoint refunds the unused part into the requester's
 * own deposit, where their owner can withdraw it — so the ceiling is what turns a
 * per-request faucet into a number the daily budget can bound.
 */
const policy: RevocationSubmissionPolicy = {
    ...(PINNED_PAYER === undefined ? {} : {payer: PINNED_PAYER}),
    maxCallGasLimit: readPositiveInteger("MAX_CALL_GAS_LIMIT", 300_000n),
    maxVerificationGasLimit: readPositiveInteger("MAX_VERIFICATION_GAS_LIMIT", 300_000n),
    maxPreVerificationGas: readPositiveInteger("MAX_PRE_VERIFICATION_GAS", 100_000n),
    maxFeePerGas: readPositiveInteger("MAX_FEE_PER_GAS", SPONSORED ? 10_000_000n : 1_000_000_000n),
    // A floor as well as a ceiling, in sponsored mode only. Without it an operation signed
    // just above the base fee (267 wei measured on GIWA) is accepted, reimburses the
    // relayer at a fraction of the ~1,000,267 wei/gas it actually pays, and — because a
    // low fee also means a small prefund — barely touches the daily budget. Defaulting
    // both bounds to the same value states what this service already claims elsewhere:
    // everything it accepts is built by one function in this repo.
    ...(SPONSORED
        ? {minFeePerGas: readPositiveInteger("MIN_FEE_PER_GAS", 10_000_000n)}
        : {}),
};

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});

// The relayer is named as the handleOps beneficiary, so the EntryPoint pays it. If the
// relayer address carries code — an EIP-7702 designator most of all — `_compensate`
// pays into a contract that can do more than receive gas. This exact drain was measured
// on a GIWA fork and the e2e asserts against it; the production service must enforce it
// too, not just the test harness. A clean EOA returns undefined from getCode.
if ((await publicClient.getCode({address: relayer.address})) !== undefined) {
    throw new Error(
        "relayer address carries code (EIP-7702 designator?) — handleOps would compensate into it; use a clean EOA",
    );
}

const relayerClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

/**
 * Sponsored-mode configuration. Every read below happens only when SPONSORED, so a pinned
 * deployment needs none of these variables.
 */
function readSponsorConfig() {
    // The kill switch, default off — a deployment that merely *forgot* PAYER_ACCOUNT_ADDRESS
    // must fail loudly instead of becoming a public spender.
    if (!readFlag("REVOCATION_SPONSOR_ENABLED")) {
        throw new Error(
            "PAYER_ACCOUNT_ADDRESS is unset, which selects sponsored mode — it requires " +
                "REVOCATION_SPONSOR_ENABLED=true (or set PAYER_ACCOUNT_ADDRESS for the pinned mode)",
        );
    }
    const expectedApproval = buildSponsoredRevocationApproval(FRAMEWORK_COMPOSITION_ID);
    if (process.env.REVOCATION_SPONSOR_APPROVAL?.trim() !== expectedApproval) {
        throw new Error(
            `sponsored mode requires REVOCATION_SPONSOR_APPROVAL to match this composition; expected ${expectedApproval}`,
        );
    }

    const account = privateKeyToAccount(readKeyEnv("REVOCATION_SPONSOR_PRIVATE_KEY"), {
        nonceManager,
    });
    const expected = readAddressEnv("REVOCATION_SPONSOR_ADDRESS");
    if (account.address !== expected) {
        throw new Error(
            `REVOCATION_SPONSOR_PRIVATE_KEY resolves to ${account.address}, expected ${expected}`,
        );
    }
    // Key separation, enforced rather than remembered. The relayer already fronts
    // handleOps gas in this very process; sharing it would interleave two nonce streams
    // in one service. The facilitator relayer, deployer and bootstrap sponsor are the
    // other funded keys in this repo, each with its own consumer.
    if (account.address === relayer.address) {
        throw new Error("REVOCATION_SPONSOR_ADDRESS must differ from the relayer key");
    }
    for (const name of ["DEPLOYER_ADDRESS", "BOOTSTRAP_ADDRESS"] as const) {
        const other = readOptionalAddressEnv(name);
        if (other && other === account.address) {
            throw new Error(
                `REVOCATION_SPONSOR_ADDRESS must differ from ${name}; a shared nonce space would stall it`,
            );
        }
    }

    return {
        account,
        /** depositTo measured ~44k; larger is a different transaction. */
        depositGas: readPositiveInteger("REVOCATION_DEPOSIT_GAS", 60_000n),
        /** ~50x the measured 1,000,266 wei — same ceiling the bootstrap sponsor uses. */
        maxFeePerGas: readPositiveInteger("REVOCATION_SPONSOR_FEE_PER_GAS", 50_000_000n),
        priorityFeePerGas: readPositiveInteger("REVOCATION_SPONSOR_PRIORITY_FEE_WEI", 1_000_000n),
        minBalance: readPositiveInteger("REVOCATION_MIN_SPONSOR_BALANCE_WEI", 1_000_000_000_000n),
        /**
         * 0.0007 ETH — roughly 70 sponsored revocations at the worst case. Sized
         * independently of the bootstrap budget on purpose: one revocation's deposit
         * (0.000007 ETH) costs more than ten account deploys, because most of it is the
         * refundable-to-the-requester prefund rather than gas.
         */
        dailyBudget: readPositiveInteger("REVOCATION_DAILY_WEI", 700_000_000_000_000n),
        /**
         * Sized against the budget, not picked for feel.
         *
         * One sponsored request reserves shortfall (7e12) + deposit gas (3e12) = 1e13 wei,
         * so the 7e14 daily budget is 70 requests. At 10/hour a single IP could spend all
         * 70 in seven hours and leave every other owner with `budget_exhausted` — the kill
         * switch unavailable, which is the loss that matters here, the ETH being testnet.
         * At 2/hour one IP reaches 48/day, comfortably inside the budget.
         *
         * The same limit governs the per-sender bucket. Note what that bucket is *not*:
         * an identity that costs anything to mint. This repo's own `account-bootstrap`
         * deploys a real `HybridDeleGator` for any keypair at sponsor expense, and
         * `disableDelegation` accepts a hash that was never granted, so a fresh sender
         * with a genuine owner signature is free. The per-sender bucket shapes one
         * account's burst; the budget is what actually bounds the day.
         */
        ratePerHour: Number(readPositiveInteger("REVOCATION_RATE_PER_HOUR", 2n)),
    };
}

const sponsorConfig = SPONSORED ? readSponsorConfig() : undefined;
if (sponsorConfig) {
    if (sponsorConfig.priorityFeePerGas > sponsorConfig.maxFeePerGas) {
        throw new Error(
            "REVOCATION_SPONSOR_PRIORITY_FEE_WEI must not exceed REVOCATION_SPONSOR_FEE_PER_GAS; the node would refuse every broadcast",
        );
    }
    // Same EIP-7702 hazard as the relayer: the sponsor never receives handleOps
    // compensation, but a designator on a funded key is a drain either way.
    if ((await publicClient.getCode({address: sponsorConfig.account.address})) !== undefined) {
        throw new Error(
            "sponsor address carries code (EIP-7702 designator?) — use a clean, dedicated EOA",
        );
    }
}

const sponsorClient = sponsorConfig
    ? createWalletClient({
          account: sponsorConfig.account,
          chain: giwaSepolia,
          transport: throttledHttp(RPC_URL),
      }).extend(publicActions)
    : undefined;

const limiter = sponsorConfig ? new FixedWindowLimiter(sponsorConfig.ratePerHour, 3_600_000) : undefined;
const budget = sponsorConfig ? new SpendBudget(sponsorConfig.dailyBudget, Date.now()) : undefined;

/**
 * A stable identity for one signed operation.
 *
 * Only used to coalesce concurrent submissions of the same op — the chain's own nonce is
 * what actually prevents replay. Hashing the whole struct (rather than, say, the
 * signature alone) means two requests coalesce exactly when they would produce the same
 * transaction.
 */
function submissionKey(submission: ValidatedRevocationSubmission): Hex {
    const {packed} = submission;
    return keccak256(
        encodeAbiParameters(
            [
                {type: "address"},
                {type: "uint256"},
                {type: "bytes"},
                {type: "bytes32"},
                {type: "uint256"},
                {type: "bytes32"},
                {type: "bytes"},
            ],
            [
                packed.sender,
                packed.nonce,
                packed.callData,
                packed.accountGasLimits,
                packed.preVerificationGas,
                packed.gasFees,
                packed.signature,
            ],
        ),
    );
}

interface RevokeResponse {
    success: boolean;
    transaction?: Hex;
    delegationHash?: Hex;
    network: typeof GIWA_SEPOLIA_CAIP2;
    /** Present only on refusals the owner can act on; opaque otherwise. */
    reason?: RevokeRefusal;
    detail?: Record<string, string>;
}

const singleFlight = new PaymentIntentSingleFlight<RevokeResponse>();

/**
 * `submissionKey` coalesces identical operations, but two *different* signed ops for the
 * same account would each pass it and race the deposit leg — two sponsor deposits for one
 * revocation. One account revokes one grant at a time; the second caller is told so.
 */
const inFlightSenders = new Set<Address>();

/**
 * Raised for a refusal the owner can fix — an unarmed deposit above all.
 *
 * Deliberately not folded into the opaque rejection the facilitator uses. That service
 * answers an untrusted seller; this one answers an account's own owner about their own
 * kill switch. Telling them "rejected" when the answer is "you are 0.0007 ETH short"
 * would make the safety mechanism unusable. In sponsored mode the detail carries numbers
 * from the caller's own submission and public chain state, never an error string.
 */
class SubmissionRefused extends Error {
    constructor(
        readonly reason: RevokeRefusal,
        readonly detail: Record<string, string>,
        readonly httpStatus: number = 409,
    ) {
        super(reason);
        this.name = "SubmissionRefused";
    }
}

function refusalDetail(refusal: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(refusal)
            .filter(([key]) => key !== "reason")
            .map(([key, value]) => [key, String(value)]),
    );
}

async function submit(submission: ValidatedRevocationSubmission): Promise<RevokeResponse> {
    if (!SPONSORED) return submitPinned(submission);
    if (inFlightSenders.has(submission.sender)) {
        throw new SubmissionRefused("sender_busy", {sender: submission.sender});
    }
    inFlightSenders.add(submission.sender);
    try {
        return await submitSponsored(submission);
    } finally {
        inFlightSenders.delete(submission.sender);
    }
}

/** The original single-payer flow: the account's own deposit pays, nobody sponsors. */
async function submitPinned(submission: ValidatedRevocationSubmission): Promise<RevokeResponse> {
    const [prefund, block, relayerBalance] = await Promise.all([
        readRevocationPrefundState({
            publicClient,
            entryPoint,
            sender: submission.sender,
            requiredPrefund: submission.requiredPrefund,
        }),
        publicClient.getBlock({blockTag: "latest"}),
        publicClient.getBalance({address: relayer.address}),
    ]);

    const readiness = judgeSubmissionReadiness({
        deposit: prefund.deposit,
        requiredPrefund: submission.requiredPrefund,
        // Not `?? 0n`: a base fee we could not read must reach the judge as unknown.
        // Substituting zero makes `maxFeePerGas < baseFeePerGas` false for every input and
        // turns the guard that protects the relayer into a no-op.
        baseFeePerGas: block.baseFeePerGas ?? undefined,
        maxFeePerGas: submission.gas.maxFeePerGas,
        relayerBalance,
    });
    if (!readiness.ok) {
        const {refusal} = readiness;
        throw new SubmissionRefused(refusal.reason, refusalDetail(refusal));
    }
    return carry(submission);
}

/**
 * The sponsored flow. The ordering is the design:
 *
 * 1. `already_revoked` — the cheapest refusal, and what makes a replay of a successful
 *    revocation spend nothing.
 * 2. Judge the *non-deposit* conditions as if the deposit were already made. A fee below
 *    the base fee or an unfunded relayer refuses the operation regardless, so finding out
 *    after the deposit would gift the prefund for nothing.
 * 3. Only then, if the deposit is short: per-sender rate limit, then the account's own
 *    ERC-1271 answer. The EntryPoint checks the prefund before the signature (`AA21`
 *    precedes `AA24`), so simulation can never give a signature verdict on an unfunded
 *    account — these two reads are how the chain stays the authority without the sponsor
 *    paying to find out. A garbage signature refuses here, before any spend.
 * 4. Reserve against the daily budget, deposit exactly the shortfall, settle what the
 *    receipt says (pessimistically the reservation, never zero, if it cannot be read).
 * 5. Carry the operation exactly as the pinned mode would.
 */
async function submitSponsored(submission: ValidatedRevocationSubmission): Promise<RevokeResponse> {
    const config = sponsorConfig!;
    const client = sponsorClient!;

    if (
        await isDelegationRevoked({
            publicClient,
            delegationManager,
            delegation: submission.delegation,
        })
    ) {
        throw new SubmissionRefused("already_revoked", {delegationHash: submission.delegationHash});
    }

    const [prefund, block, relayerBalance] = await Promise.all([
        readRevocationPrefundState({
            publicClient,
            entryPoint,
            sender: submission.sender,
            requiredPrefund: submission.requiredPrefund,
        }),
        publicClient.getBlock({blockTag: "latest"}),
        publicClient.getBalance({address: relayer.address}),
    ]);

    const afterDeposit = judgeSubmissionReadiness({
        deposit: submission.requiredPrefund,
        requiredPrefund: submission.requiredPrefund,
        baseFeePerGas: block.baseFeePerGas ?? undefined,
        maxFeePerGas: submission.gas.maxFeePerGas,
        relayerBalance,
    });
    if (!afterDeposit.ok) {
        const {refusal} = afterDeposit;
        throw new SubmissionRefused(refusal.reason, refusalDetail(refusal));
    }

    if (prefund.shortfall > 0n) {
        if (!(await verifyRevocationSignature({publicClient, packed: submission.packed}))) {
            throw new SubmissionRefused(
                "invalid_account_signature",
                {sender: submission.sender},
                403,
            );
        }
        const now = Date.now();
        /**
         * Consumed *after* the signature check, not before.
         *
         * The root delegation's own signature is never verified on this path — it does not
         * need to be, because `disableDelegation` on a hash that was never granted is
         * harmless. But it means anyone who knows a victim's payer address can post a
         * forged delegation naming them as delegator with 65 random signature bytes: the
         * byte-equality callData check passes, and only the account's ERC-1271 refuses.
         * Consuming the victim's token before that refusal would let an attacker lock a
         * specific kill switch out of the sponsored path for a full window at the cost of
         * their own IP tokens. The check above is a free `eth_call`, and the per-IP limit
         * at the route already bounds volume, so the token belongs here.
         */
        if (!limiter!.tryConsume(`sender:${submission.sender}`, now)) {
            throw new SubmissionRefused("rate_limited", {}, 429);
        }

        const gasReservation = config.depositGas * config.maxFeePerGas;
        const reservation = prefund.shortfall + gasReservation;
        const sponsorBalance = await publicClient.getBalance({address: config.account.address});
        // The node's own upfront rule is `balance >= value + gasLimit * maxFeePerGas`;
        // checking only a floor leaves a band where every broadcast fails with an opaque
        // error instead of the refusal that tells the operator to top up.
        if (sponsorBalance < config.minBalance + reservation) {
            throw new SubmissionRefused("sponsor_unfunded", {}, 503);
        }
        if (!budget!.reserve(reservation, now)) {
            throw new SubmissionRefused("budget_exhausted", {}, 503);
        }

        let charged = 0n;
        try {
            const call = buildPrefundDepositCall({
                entryPoint,
                sender: submission.sender,
                amount: prefund.shortfall,
            });
            const hash = await client.sendTransaction({
                to: call.to,
                data: call.data,
                value: call.value,
                gas: config.depositGas,
                maxFeePerGas: config.maxFeePerGas,
                maxPriorityFeePerGas: config.priorityFeePerGas,
            });
            // The sponsor's ETH is committed the moment the node accepts this; anything
            // that throws below leaves a transaction that still mines, so the pessimistic
            // charge goes in now and the measured one replaces it.
            charged = reservation;
            const receipt = await publicClient.waitForTransactionReceipt({
                hash,
                confirmations: 1,
                timeout: RECEIPT_TIMEOUT_MS,
            });
            if (receipt.status !== "success") {
                // A reverted depositTo returned the value but still burned gas.
                charged = costOfReceipt(receipt, gasReservation);
                throw new Error("sponsor depositTo reverted");
            }
            charged = prefund.shortfall + costOfReceipt(receipt, gasReservation);
        } finally {
            budget!.settle(reservation, charged, Date.now());
        }
    }

    return carry(submission);
}

/** Simulate, broadcast, and prove the revocation actually executed. */
async function carry(submission: ValidatedRevocationSubmission): Promise<RevokeResponse> {
    // Simulate before broadcasting. For a funded account this is where an
    // `AA24 signature error` surfaces; for the sponsored path the signature was already
    // answered by the account itself, and this still catches nonce reuse (`AA25`).
    const simulation = await publicClient.simulateContract({
        address: entryPoint,
        abi: EntryPointAbi,
        functionName: "handleOps",
        args: [[submission.packed], relayer.address],
        account: relayer,
    });

    /**
     * Price the relayer's own transaction against the operation it is carrying.
     *
     * Left to viem this is `baseFee + eth_maxPriorityFeePerGas`, and GIWA suggests a
     * 1,000,000 wei tip over a 267 wei base fee — so the relayer routinely pays far more
     * per gas than the EntryPoint reimburses, which is `min(maxFeePerGas, tip + baseFee)`
     * of the *signed* operation. Capping our own fee at the operation's own
     * `maxFeePerGas` makes the reimbursement an upper bound on the spend rather than an
     * unrelated number. Safe because `judgeSubmissionReadiness` already refused anything
     * signed below the current base fee, so this cap is never under it.
     */
    const relayerPriority =
        RELAYER_PRIORITY_FEE_WEI < submission.gas.maxFeePerGas
            ? RELAYER_PRIORITY_FEE_WEI
            : submission.gas.maxFeePerGas;
    // The call is re-stated rather than spread from `simulation.request`: that object
    // carries viem's own fee shape (a legacy `gasPrice` and a `type` discriminant), which
    // cannot be merged with an explicit 1559 pair. The simulation above is still the gate
    // — its job is to surface `AA24`/`AA25` before anything is broadcast — and the
    // arguments below are the same ones it was given.
    const hash = await relayerClient.writeContract({
        address: entryPoint,
        abi: EntryPointAbi,
        functionName: "handleOps",
        args: [[submission.packed], relayer.address],
        account: relayer,
        chain: giwaSepolia,
        maxFeePerGas: submission.gas.maxFeePerGas,
        maxPriorityFeePerGas: relayerPriority,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: RECEIPT_TIMEOUT_MS,
    });
    if (receipt.status !== "success") throw new Error("handleOps transaction reverted");

    // A successful receipt is NOT proof the revocation happened. `EntryPoint.sol` catches
    // an inner-call revert, emits `UserOperationRevertReason`, and lets the transaction
    // succeed. `UserOperationEvent.success` is the only field that answers the question.
    const events = parseEventLogs({
        abi: EntryPointAbi,
        logs: receipt.logs,
        eventName: "UserOperationEvent",
    });
    const event = events[0];
    if (!event) throw new Error("no UserOperationEvent — the operation never executed");
    if (!(event.args as {success: boolean}).success) {
        throw new Error("UserOperationEvent.success is false — disableDelegation reverted inside");
    }

    return {
        success: true,
        transaction: hash,
        delegationHash: submission.delegationHash,
        network: GIWA_SEPOLIA_CAIP2,
    };
}

/**
 * Pinned mode keeps the loopback console allowlist; sponsored mode must admit the public
 * Studio origin, so it uses the bootstrap parser — which is exactly why its CORS list is
 * *not* access control there (a non-browser client sends no Origin at all). In sponsored
 * mode the budget, the rate limiter, the signature check and the ceilings are the entire
 * defense; the origin list only keeps a stray page from queueing work.
 */
const CORS_POLICY = {
    allowedOrigins: SPONSORED
        ? parseBootstrapOrigins(
              process.env.REVOCATION_ALLOWED_ORIGINS,
              [
                  "https://app.mapae.io",
                  "http://127.0.0.1:5173",
                  "http://localhost:5173",
                  "http://127.0.0.1:4173",
                  "http://localhost:4173",
              ],
              "REVOCATION_ALLOWED_ORIGINS",
          )
        : parseCorsAllowlist(process.env.REVOCATION_CONSOLE_ORIGINS, isLoopbackHost, [
              // `vite` (pinned to 127.0.0.1:5173 in vite.config.ts) and `vite preview`
              // (4173), each under both spellings of loopback. A revoke button that works
              // under `dev` and dies under `preview` is the same split this whole fix
              // exists to close.
              "http://127.0.0.1:5173",
              "http://localhost:5173",
              "http://127.0.0.1:4173",
              "http://localhost:4173",
          ]),
};

const app = new Hono();

app.use("*", async (c, next) => {
    const decision = judgeCorsRequest(c.req.header("origin"), CORS_POLICY);
    // A disallowed origin is refused here rather than being allowed to run and then
    // stripped of its header on the way out: the browser would block the response either
    // way, but only this order keeps an unauthorised page from spending relayer gas.
    if (!decision.allowed) {
        return c.json({success: false, network: GIWA_SEPOLIA_CAIP2, reason: "origin_refused"}, 403);
    }
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
});

// Hono has no implicit OPTIONS handler, so without this the preflight 404s and every
// header above is moot.
app.options("/revoke", (c) => {
    const decision = judgeCorsRequest(c.req.header("origin"), CORS_POLICY, true);
    if (!decision.allowed) return c.body(null, 403);
    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
    return c.body(null, 204);
});

/**
 * Operator-facing. The sponsored deployment must keep this off the tunnel ingress — it
 * names the sponsor, its remaining budget and the limiter load, a targeting oracle for
 * anyone deciding whether a griefing run is worth starting. The tunnel exposes
 * `POST /revoke` and nothing else.
 */
app.get("/health", async (c) => {
    const relayerBalance = await publicClient
        .getBalance({address: relayer.address})
        .catch(() => undefined);
    if (SPONSORED) {
        limiter!.sweep(Date.now());
        return c.json({
            ok: relayerBalance !== undefined && relayerBalance > 0n,
            network: GIWA_SEPOLIA_CAIP2,
            mode: "sponsored",
            entryPoint,
            submitter: relayer.address,
            sponsor: sponsorConfig!.account.address,
            relayerFunded: relayerBalance === undefined ? null : relayerBalance > 0n,
            budgetRemainingWei: String(budget!.remaining(Date.now())),
            spentTodayWei: String(budget!.spentToday(Date.now())),
            rateLimiterKeys: limiter!.size,
        });
    }
    const deposit = await publicClient
        .readContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "balanceOf",
            args: [PINNED_PAYER!],
        })
        .then((value) => value as bigint)
        .catch(() => undefined);
    return c.json({
        ok: relayerBalance !== undefined && relayerBalance > 0n,
        network: GIWA_SEPOLIA_CAIP2,
        mode: "pinned",
        entryPoint,
        payer: PINNED_PAYER!,
        submitter: relayer.address,
        relayerFunded: relayerBalance === undefined ? null : relayerBalance > 0n,
        // The kill switch's readiness, in the one place an operator will look for it.
        payerDeposit: deposit === undefined ? null : String(deposit),
    });
});

app.post("/revoke", async (c) => {
    if (SPONSORED) {
        // Rate limit before any chain read, so an unauthenticated flood costs us nothing.
        // Cloudflare sets `CF-Connecting-IP`; the tunnel is the only public path, so a
        // request arriving without it came over loopback.
        const requester = c.req.header("cf-connecting-ip") ?? "loopback";
        const now = Date.now();
        limiter!.sweep(now);
        if (!limiter!.tryConsume(`ip:${requester}`, now)) {
            return refuse(c, "rate_limited", 429);
        }
    }

    let submission: ValidatedRevocationSubmission;
    try {
        submission = validateRevocationSubmission(await readJson(c), policy);
    } catch (error) {
        console.error(`[revoke] rejected — ${redactForLog(error)}`);
        if (SPONSORED) return refuse(c, "invalid_submission", 400);
        // Pinned mode is loopback-only and answers the caller's own malformed request;
        // the message is the fastest path to a working submission and leaks nothing the
        // caller did not already send.
        const response: RevokeResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            reason: "invalid_submission",
            detail: {message: redactForLog(error, 200)},
        };
        return c.json(response, 400);
    }

    try {
        const response = await singleFlight.run(submissionKey(submission), () => submit(submission));
        console.log(`[revoked] delegation=${submission.delegationHash} tx=${response.transaction}`);
        return c.json(response);
    } catch (error) {
        console.error(`[revoke] failed — ${redactForLog(error)}`);
        if (error instanceof SubmissionRefused) {
            const response: RevokeResponse = {
                success: false,
                network: GIWA_SEPOLIA_CAIP2,
                reason: error.reason,
                detail: error.detail,
            };
            return c.json(response, error.httpStatus as never);
        }
        if (SPONSORED) return refuse(c, "submission_failed", 502);
        const response: RevokeResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            reason: "submission_failed",
            detail: {message: redactForLog(error, 200)},
        };
        return c.json(response, 502);
    }
});

function refuse(c: Context, reason: RevokeRefusal, status: number) {
    // `as never` narrows Hono's literal status union; every value used here is a real code.
    return c.json({success: false, network: GIWA_SEPOLIA_CAIP2, reason}, status as never);
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

console.log(`revocation submitter listening on ${HOST}:${PORT}`);
console.log(`  network    ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  mode       ${SPONSORED ? "sponsored" : "pinned"}`);
console.log(`  entryPoint ${entryPoint}`);
if (PINNED_PAYER) console.log(`  payer      ${PINNED_PAYER}`);
if (sponsorConfig) console.log(`  sponsor    ${sponsorConfig.account.address}`);
console.log(`  submitter  ${relayer.address}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
