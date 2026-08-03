import {Hono} from "hono";
import {
    decideSettlement,
    decideVerification,
    parseActiveDeploymentArtifactJson,
    parseFrameworkDeploymentManifestJson,
    throttledHttp,
    validateDelegatedPayment,
    verifyActiveFrameworkDeployment,
    type Erc7710FacilitatorRequest,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    LEGACY_PAYMENT_RESPONSE_HEADER,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    X402_VERSION,
    buildErc7710PaymentRequirements,
    decodeAnyPaymentHeader,
    encodePaymentRequiredHeader,
    fromTokenAmount,
    giwaSepolia,
    parseNodeRpcUrl,
    readInboundPaymentHeader,
    toTokenAmount,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {
    createPublicClient,
    getAddress,
    isAddress,
    zeroAddress,
    type Address,
} from "viem";

const MAX_PAYMENT_HEADER_LENGTH = 150_000;

/**
 * Timeout budgets, and why they are ordered this way.
 *
 * Four timeouts stack on one payment, and they have to grow outward:
 *
 *   facilitator receipt wait  <  seller→facilitator settle  <  this server's idle
 *   timeout  <  the agent's own request timeout
 *
 * They were inverted. `Bun.serve`'s **default `idleTimeout` is 10 s**, which made the
 * outermost hop the shortest, while the facilitator waits up to 60 s for a receipt. On
 * GIWA that produced the worst available outcome: the transfer was mined
 * (`0x533c5cb2…9964c`, block 31634935, payer −1.00 mUSDC) and the agent was told the
 * payment had failed. An inverted budget does not lose a payment — it loses the *answer*
 * about a payment, which is harder to recover from.
 *
 * `idleTimeout` is in seconds and capped at 255 by Bun.
 */
const VERIFY_TIMEOUT_MS = 15_000;
/** Must exceed the facilitator's own `SETTLEMENT_RECEIPT_TIMEOUT_MS` (default 25 s). */
const SETTLE_TIMEOUT_MS = 35_000;
/** Must exceed SETTLE_TIMEOUT_MS, or this server hangs up on its own settlement. */
const IDLE_TIMEOUT_SECONDS = 45;

function readPayTo(): Address {
    const value = process.env.PAY_TO?.trim() ?? "";
    if (!isAddress(value)) {
        throw new Error("PAY_TO must be the public vendor address, never a private key");
    }
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("PAY_TO must not be zero");
    return address;
}

function readUrl(name: string, fallback: string): string {
    const value = process.env[name]?.trim() || fallback;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error(`${name} must use HTTPS unless it is loopback`);
    }
    return url.toString().replace(/\/$/, "");
}

function readPort(): number {
    const value = Number(process.env.PORT ?? 3001);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be between 1 and 65535");
    }
    return value;
}

async function readDeployment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`deployment artifact not found: ${path}`);
    return parseActiveDeploymentArtifactJson(await file.text());
}

async function readManifest() {
    const path =
        process.env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`Framework manifest not found: ${path}`);
    return parseFrameworkDeploymentManifestJson(await file.text());
}

function readRpcUrl(): string {
    return parseNodeRpcUrl(
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
}

function readFrameworkAdmin(): Address {
    const value = process.env.FRAMEWORK_ADMIN_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("FRAMEWORK_ADMIN_ADDRESS must be an address");
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("FRAMEWORK_ADMIN_ADDRESS must not be zero");
    return address;
}

async function readFacilitatorAddress(url: string): Promise<Address> {
    const response = await fetch(`${url}/supported`, {
        redirect: "error",
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`facilitator /supported returned ${response.status}`);
    const body = (await response.json()) as {signers?: Record<string, unknown>};
    const signers = body.signers?.[GIWA_SEPOLIA_CAIP2];
    if (
        !Array.isArray(signers) ||
        signers.length !== 1 ||
        typeof signers[0] !== "string" ||
        !isAddress(signers[0])
    ) {
        throw new Error("facilitator must advertise exactly one GIWA signer");
    }
    return getAddress(signers[0]);
}

const PAY_TO = readPayTo();
const BASE_URL = readUrl("BASE_URL", "http://127.0.0.1:3001");
const FACILITATOR_URL = readUrl("FACILITATOR_URL", "http://127.0.0.1:8081");
const HOST = process.env.HOST?.trim() || "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    throw new Error("HOST must be loopback");
}
const PORT = readPort();
const deployment = await readDeployment();
const manifest = await readManifest();
const publicClient = createPublicClient({
    chain: giwaSepolia,
    transport: throttledHttp(readRpcUrl()),
});
await verifyActiveFrameworkDeployment({
    publicClient,
    deployment,
    manifest,
    expectedFrameworkAdmin: readFrameworkAdmin(),
});
const facilitatorAddress = await readFacilitatorAddress(FACILITATOR_URL);

const DELIVERABLES: Record<
    string,
    {price: string; description: string; body: Record<string, unknown>}
> = {
    "inv-001": {
        price: "1.00",
        description: "Delegated design deliverable — invoice inv-001",
        body: {invoice: "inv-001", deliverable: "logo-final.svg"},
    },
    "inv-002": {
        price: "2.50",
        description: "Delegated translation deliverable — invoice inv-002",
        body: {invoice: "inv-002", deliverable: "spec-ko.md"},
    },
};

/**
 * No two deliverables may cost the same, and that is a security condition rather than a
 * catalogue preference.
 *
 * A payment is bound to its offer by `sameRequirement`, which compares network, asset,
 * amount, payTo and maxTimeoutSeconds. None of those is the resource: x402 v2 keeps
 * `resource` at the top level of the 402 body, so it never reaches the validator, and
 * `paymentIntentId` does not hash it either. Two entries at one price therefore produce
 * byte-identical requirements, and a header bought for one satisfies the offer for the
 * other. Nothing downstream catches it — this seller holds no record of which intent it
 * has already served, so it would ship both.
 *
 * The catalogue is safe today because 1.00 and 2.50 happen to differ. That is a
 * coincidence, not a mechanism, and the failure it prevents would arrive silently with
 * whoever adds a third item. Refusing to start converts it into something that cannot be
 * reintroduced without being noticed. Keyed on the encoded token amount rather than the
 * decimal string, because "1.0" and "1.00" are different strings and the same offer.
 */
const priceOwners = new Map<string, string>();
for (const [id, item] of Object.entries(DELIVERABLES)) {
    const amount = toTokenAmount(item.price).toString();
    const owner = priceOwners.get(amount);
    if (owner !== undefined) {
        throw new Error(
            `DELIVERABLES ${owner} and ${id} both cost ${item.price}; payment requirements ` +
                "carry no resource identity, so one payment would buy both",
        );
    }
    priceOwners.set(amount, id);
}

const app = new Hono();
app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

app.get("/health", (c) =>
    c.json({
        ok: true,
        network: GIWA_SEPOLIA_CAIP2,
        paymentMethod: "erc7710",
        payTo: PAY_TO,
        facilitator: facilitatorAddress,
    }),
);

app.get("/delegated/deliverable/:id", async (c) => {
    const id = c.req.param("id");
    const item = DELIVERABLES[id];
    if (!item) return c.json({error: "unknown deliverable"}, 404);

    const requirements = buildErc7710PaymentRequirements({
        payTo: PAY_TO,
        amount: toTokenAmount(item.price),
        facilitatorAddresses: [facilitatorAddress],
        // In-band manager discovery for third-party agents: their delegationProvider
        // receives this requirements object verbatim, and GIWA's manager is in no
        // public registry. Advisory — the facilitator allowlists the payload's manager
        // independently, and this seller validates against the same deployment below.
        delegationManager: getAddress(deployment.environment.DelegationManager),
    });
    const payment = readInboundPaymentHeader((name) => c.req.header(name));
    if (!payment) {
        const body: PaymentRequired<Erc7710PaymentRequirements> = {
            x402Version: X402_VERSION,
            resource: {
                url: `${BASE_URL}/delegated/deliverable/${id}`,
                description: item.description,
                mimeType: "application/json",
            },
            accepts: [requirements],
        };
        // v2 transport puts the offer in a Payment-Required header; the reference
        // implementation then sends an empty body. The JSON body stays anyway — it is
        // the transport every already-deployed agent of this repo reads, and a client
        // honours whichever of the two it understands.
        c.header(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(body));
        return c.json(body, 402);
    }
    if (payment.value.length > MAX_PAYMENT_HEADER_LENGTH) {
        return c.json({error: "malformed_payment", detail: "header too large"}, 400);
    }

    let payload: Erc7710PaymentPayload;
    try {
        const decoded = decodeAnyPaymentHeader(payment.value);
        if (
            !("assetTransferMethod" in decoded.accepted.extra) ||
            decoded.accepted.extra.assetTransferMethod !== "erc7710"
        ) {
            throw new Error("not ERC-7710");
        }
        payload = decoded as Erc7710PaymentPayload;
    } catch {
        return c.json({error: "malformed_payment", detail: "invalid base64 JSON"}, 400);
    }

    const request: Erc7710FacilitatorRequest = {
        x402Version: X402_VERSION,
        paymentPayload: payload,
        paymentRequirements: requirements,
    };
    let payer: Address;
    try {
        payer = validateDelegatedPayment(request, {
            delegationManager: getAddress(deployment.environment.DelegationManager),
            facilitator: facilitatorAddress,
        }).payer;
    } catch {
        return c.json({error: "malformed_payment", detail: "payment offer mismatch"}, 400);
    }

    // Split "the facilitator could not be reached" from "the facilitator refused this
    // delegation" (task #37). Nothing is charged at /verify, so 503 is a safe, honest
    // "retry later"; blaming the caller's delegation with 403 for our own outage is not.
    const verification = decideVerification(await callFacilitator("/verify", request), payer);
    switch (verification.kind) {
        case "unavailable":
            return c.json({error: "verifier_unavailable"}, 503);
        case "rejected":
            return c.json({error: "delegation_rejected"}, 403);
        case "accepted":
            break;
    }

    // "Did not succeed" and "is not known to have succeeded" are different claims.
    // A transport failure, or a facilitator that broadcast without seeing a receipt,
    // leaves the payer possibly charged — answering 422 would assert they were not.
    // The ladder itself lives in @mapae/delegation so it can be tested without a
    // facilitator, a chain, or a key; this switch is the only part that is HTTP.
    const outcome = decideSettlement(await callFacilitator("/settle", request), payer);
    switch (outcome.kind) {
        case "unknown":
            return c.json({error: "settlement_unknown"}, 504);
        case "failed":
            return c.json({error: "settlement_failed"}, 422);
        case "settled":
            break;
    }
    const {transaction} = outcome;

    // Built from the fields this seller validated, not by echoing the facilitator's
    // body. `btoa` throws on any non-Latin1 character, and that throw would land
    // *after* settlement — the buyer would have paid and received a 500. Every field
    // here is ASCII by construction: a CAIP-2 constant, a checksummed address, and a
    // hex hash already matched against /^0x[0-9a-fA-F]{64}$/.
    const receiptHeader = btoa(
        JSON.stringify({success: true, network: requirements.network, payer, transaction}),
    );
    c.header(PAYMENT_RESPONSE_HEADER, receiptHeader);
    c.header(LEGACY_PAYMENT_RESPONSE_HEADER, receiptHeader);
    return c.json({
        ...item.body,
        receipt: {
            method: "erc7710",
            amount: fromTokenAmount(BigInt(requirements.amount)),
            asset: requirements.asset,
            payTo: requirements.payTo,
            payer,
            network: requirements.network,
            transaction,
        },
    });
});

/**
 * `reachable: false` is every way the call did not yield a body — refused connection,
 * non-2xx, unparseable JSON, timeout. It deliberately does not distinguish them: for
 * `/settle` they are all the same claim, that we do not know whether money moved.
 */
async function callFacilitator(
    path: "/verify" | "/settle",
    request: Erc7710FacilitatorRequest,
): Promise<{reachable: boolean; body?: unknown}> {
    try {
        const response = await fetch(`${FACILITATOR_URL}${path}`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(request),
            redirect: "error",
            // `/verify` is a simulation and answers quickly; `/settle` broadcasts and
            // waits for a receipt. One shared budget meant the shorter of the two set
            // the deadline for the longer.
            signal: AbortSignal.timeout(
                path === "/settle" ? SETTLE_TIMEOUT_MS : VERIFY_TIMEOUT_MS,
            ),
        });
        if (!response.ok) return {reachable: false};
        return {reachable: true, body: (await response.json()) as unknown};
    } catch {
        return {reachable: false};
    }
}

console.log(`delegated seller listening on ${HOST}:${PORT}`);
console.log(`  payTo       ${PAY_TO}`);
console.log(`  facilitator ${FACILITATOR_URL} (${facilitatorAddress})`);
export default {
    hostname: HOST,
    port: PORT,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: app.fetch,
};
