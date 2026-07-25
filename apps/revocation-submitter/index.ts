import {Hono, type Context} from "hono";
import {
    PaymentIntentSingleFlight,
    judgeCorsRequest,
    judgeSubmissionReadiness,
    parseActiveDeploymentArtifactJson,
    parseCorsAllowlist,
    readRevocationPrefundState,
    throttledHttp,
    validateRevocationSubmission,
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
import {privateKeyToAccount} from "viem/accounts";

const MAX_BODY_CHARACTERS = 150_000;

function readPort(): number {
    const value = Number(process.env.PORT ?? 8082);
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

function readRelayerKey(): Hex {
    const value = process.env.RELAYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex private key");
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

function readPositiveInteger(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim() || String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw);
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

const relayer = privateKeyToAccount(readRelayerKey());
const expectedRelayer = readAddressEnv("RELAYER_ADDRESS");
if (relayer.address !== expectedRelayer) {
    throw new Error(`RELAYER_PRIVATE_KEY resolves to ${relayer.address}, expected ${expectedRelayer}`);
}

const deployment = await readDeployment();
const entryPoint = getAddress(deployment.environment.EntryPoint);

/**
 * Ceilings default to the exact values `buildRevocationUserOperation` emits.
 *
 * This is not the usual "generous cap with headroom". Everything this service accepts is
 * built by one function in this repo, so anything larger is a differently-shaped
 * operation, and the operator should have to say so out loud rather than discover it
 * from a gas bill.
 */
const policy: RevocationSubmissionPolicy = {
    payer: readAddressEnv("PAYER_ACCOUNT_ADDRESS"),
    maxCallGasLimit: readPositiveInteger("MAX_CALL_GAS_LIMIT", 300_000n),
    maxVerificationGasLimit: readPositiveInteger("MAX_VERIFICATION_GAS_LIMIT", 300_000n),
    maxPreVerificationGas: readPositiveInteger("MAX_PRE_VERIFICATION_GAS", 100_000n),
    maxFeePerGas: readPositiveInteger("MAX_FEE_PER_GAS", 1_000_000_000n),
};

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const relayerClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

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
    reason?: string;
    detail?: Record<string, string>;
}

const singleFlight = new PaymentIntentSingleFlight<RevokeResponse>();

/**
 * Raised for a refusal the owner can fix — an unarmed deposit above all.
 *
 * Deliberately not folded into the opaque rejection the facilitator uses. That service
 * answers an untrusted seller; this one answers the account's own owner, on loopback,
 * about their own kill switch. Telling them "rejected" when the answer is "you are
 * 0.0035 ETH short" would make the safety mechanism unusable.
 */
class SubmissionRefused extends Error {
    constructor(
        readonly reason: string,
        readonly detail: Record<string, string>,
    ) {
        super(reason);
        this.name = "SubmissionRefused";
    }
}

async function submit(submission: ValidatedRevocationSubmission): Promise<RevokeResponse> {
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
        baseFeePerGas: block.baseFeePerGas ?? 0n,
        maxFeePerGas: submission.gas.maxFeePerGas,
        relayerBalance,
    });
    if (!readiness.ok) {
        const {refusal} = readiness;
        throw new SubmissionRefused(
            refusal.reason,
            Object.fromEntries(
                Object.entries(refusal)
                    .filter(([key]) => key !== "reason")
                    .map(([key, value]) => [key, String(value)]),
            ),
        );
    }

    // Simulate before broadcasting. This is where an `AA24 signature error` surfaces —
    // the signature is deliberately not checked offline, because the account validates
    // through ERC-1271 and only the chain is authoritative about it.
    const simulation = await publicClient.simulateContract({
        address: entryPoint,
        abi: EntryPointAbi,
        functionName: "handleOps",
        args: [[submission.packed], relayer.address],
        account: relayer,
    });

    const hash = await relayerClient.writeContract({
        ...simulation.request,
        account: relayer,
        chain: giwaSepolia,
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
 * The console runs on a different port, so every revoke is cross-origin and — because it
 * sends `content-type: application/json` — is preceded by a preflight. Without an answer
 * to that preflight the browser drops the POST and the owner's signature never leaves the
 * page. The allowlist is loopback-only and never `*`; see `parseCorsAllowlist`.
 */
const CORS_POLICY = {
    allowedOrigins: parseCorsAllowlist(process.env.REVOCATION_CONSOLE_ORIGINS, isLoopbackHost, [
        // `vite` (pinned to 127.0.0.1:5173 in vite.config.ts) and `vite preview` (4173),
        // each under both spellings of loopback. A revoke button that works under `dev`
        // and dies under `preview` is the same split this whole fix exists to close.
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

app.get("/health", async (c) => {
    const relayerBalance = await publicClient
        .getBalance({address: relayer.address})
        .catch(() => undefined);
    const deposit = await publicClient
        .readContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "balanceOf",
            args: [policy.payer],
        })
        .then((value) => value as bigint)
        .catch(() => undefined);
    return c.json({
        ok: relayerBalance !== undefined && relayerBalance > 0n,
        network: GIWA_SEPOLIA_CAIP2,
        entryPoint,
        payer: policy.payer,
        submitter: relayer.address,
        relayerFunded: relayerBalance === undefined ? null : relayerBalance > 0n,
        // The kill switch's readiness, in the one place an operator will look for it.
        payerDeposit: deposit === undefined ? null : String(deposit),
    });
});

app.post("/revoke", async (c) => {
    let submission: ValidatedRevocationSubmission;
    try {
        submission = validateRevocationSubmission(await readJson(c), policy);
    } catch (error) {
        // Validation failures are the caller's own malformed request, on loopback. The
        // message is the fastest path to a working submission and leaks nothing the
        // caller did not already send.
        console.error(`[revoke] rejected — ${redactForLog(error)}`);
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
            return c.json(response, 409);
        }
        const response: RevokeResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            reason: "submission_failed",
            detail: {message: redactForLog(error, 200)},
        };
        return c.json(response, 502);
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

console.log(`revocation submitter listening on ${HOST}:${PORT}`);
console.log(`  network    ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  entryPoint ${entryPoint}`);
console.log(`  payer      ${policy.payer}`);
console.log(`  submitter  ${relayer.address}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
