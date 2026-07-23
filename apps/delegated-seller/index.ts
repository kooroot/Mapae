import {Hono} from "hono";
import {
    parseDeploymentArtifactJson,
    validateDelegatedPayment,
    type Erc7710FacilitatorRequest,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    X402_VERSION,
    buildErc7710PaymentRequirements,
    decodeAnyPaymentHeader,
    fromTokenAmount,
    toTokenAmount,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {getAddress, isAddress, zeroAddress, type Address, type Hex} from "viem";

const MAX_PAYMENT_HEADER_LENGTH = 150_000;
const REQUEST_TIMEOUT_MS = 15_000;

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
    return parseDeploymentArtifactJson(await file.text());
}

async function readFacilitatorAddress(url: string): Promise<Address> {
    const response = await fetch(`${url}/supported`, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    });
    const header = c.req.header("X-PAYMENT");
    if (!header) {
        const body: PaymentRequired<Erc7710PaymentRequirements> = {
            x402Version: X402_VERSION,
            resource: {
                url: `${BASE_URL}/delegated/deliverable/${id}`,
                description: item.description,
                mimeType: "application/json",
            },
            accepts: [requirements],
        };
        return c.json(body, 402);
    }
    if (header.length > MAX_PAYMENT_HEADER_LENGTH) {
        return c.json({error: "malformed_payment", detail: "header too large"}, 400);
    }

    let payload: Erc7710PaymentPayload;
    try {
        const decoded = decodeAnyPaymentHeader(header);
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

    const verified = await callFacilitator("/verify", request);
    if (
        !verified.ok ||
        verified.value.isValid !== true ||
        !isCanonicalPayer(verified.value.payer, payer)
    ) {
        return c.json({error: "delegation_rejected"}, 403);
    }
    const settled = await callFacilitator("/settle", request);
    if (
        !settled.ok ||
        settled.value.success !== true ||
        !isCanonicalPayer(settled.value.payer, payer)
    ) {
        return c.json({error: "settlement_failed"}, 422);
    }

    const transaction =
        typeof settled.value.transaction === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(settled.value.transaction)
            ? (settled.value.transaction as Hex)
            : undefined;
    c.header("X-PAYMENT-RESPONSE", btoa(JSON.stringify(settled.value)));
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

type FacilitatorResponse = {
    isValid?: boolean;
    success?: boolean;
    transaction?: string;
    payer?: string;
};

function isCanonicalPayer(value: unknown, expected: Address): boolean {
    return typeof value === "string" && isAddress(value) && getAddress(value) === expected;
}

async function callFacilitator(
    path: "/verify" | "/settle",
    request: Erc7710FacilitatorRequest,
): Promise<{ok: true; value: FacilitatorResponse} | {ok: false}> {
    try {
        const response = await fetch(`${FACILITATOR_URL}${path}`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(request),
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return {ok: false};
        return {ok: true, value: (await response.json()) as FacilitatorResponse};
    } catch {
        return {ok: false};
    }
}

console.log(`delegated seller listening on ${HOST}:${PORT}`);
console.log(`  payTo       ${PAY_TO}`);
console.log(`  facilitator ${FACILITATOR_URL} (${facilitatorAddress})`);
export default {hostname: HOST, port: PORT, fetch: app.fetch};
