import {Hono, type Context} from "hono";
import {getAddress, isAddress, isHex, zeroAddress, type Address} from "viem";
import {
    FACILITATOR_URL as DEFAULT_FACILITATOR_URL,
    GIWA_SEPOLIA_CAIP2,
    LEGACY_PAYMENT_RESPONSE_HEADER,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    X402_VERSION,
    buildPaymentRequirements,
    decodePaymentHeader,
    describe,
    encodePaymentRequiredHeader,
    explorerTxUrl,
    fromTokenAmount,
    httpStatusFor,
    readInboundPaymentHeader,
    toTokenAmount,
    type FacilitatorRequest,
    type PaymentPayload,
    type PaymentRequired,
    type PaymentRequirements,
    type SettlementError,
} from "@mapae/shared";

/**
 * Seller — the payee side of the demo.
 *
 * An overseas contractor gates a deliverable behind payment. The paying business's
 * agent fetches it, receives 402, signs an EIP-3009 authorization within its
 * delegated limit, and retries. The contractor never touches gas; the facilitator
 * broadcasts settlement.
 */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * PAY_TO is a public address. Receiving funds never requires a key, so a 32-byte
 * secret here is always a mistake — validate rather than cast, and name the mistake.
 */
function readPayTo(): Address {
    const raw = process.env.PAY_TO?.trim() ?? "";

    if (!raw) {
        throw new Error("PAY_TO is required — the payee (contractor) address");
    }
    if (!isAddress(raw)) {
        const hint =
            raw.length === 66
                ? "that is a 32-byte value — a private key, not an address. " +
                  "PAY_TO only ever holds a public address; receiving needs no key. " +
                  "If a key was pasted here, rotate it — it has been served in 402 responses."
                : `expected a 42-character 0x address, got ${raw.length} characters`;
        throw new Error(`PAY_TO is not a valid address — ${hint}`);
    }
    const address = getAddress(raw);
    if (address === zeroAddress) {
        throw new Error("PAY_TO must not be the zero address");
    }
    return address;
}

const PAY_TO = readPayTo();
const MAX_PAYMENT_HEADER_LENGTH = 16_384;
const FACILITATOR_TIMEOUT_MS = 10_000;
const MAX_CLOCK_SKEW_SECONDS = 30n;

function readHttpUrl(name: string, fallback: string): string {
    const raw = process.env[name]?.trim() || fallback;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${name} must be an absolute http(s) URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must use http(s) and must not contain credentials`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error(`${name} must use HTTPS unless it points to loopback`);
    }
    return url.toString().replace(/\/$/, "");
}

function readPort(): number {
    const value = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return value;
}

/**
 * The bind address, refused unless it is loopback.
 *
 * This seller holds no key, so the blast radius is not here — it is the facilitator this
 * process calls, which has no application authentication and is funded by the relayer's
 * key. Binding this port to a routable interface publishes a caller into that facilitator.
 *
 * Until 2026-07-28 this was `process.env.HOST?.trim() || "127.0.0.1"` with no check, the
 * only unguarded bind of the repository's four HTTP surfaces — `readHttpUrl` directly
 * above and `readPort` directly below both validate, and the three sibling services throw
 * on exactly this input. A safe default is not a guard: it holds only until someone sets
 * the variable.
 *
 * Deliberately a literal list rather than `isLoopbackHost` from @mapae/shared. That helper
 * answers "is this destination local", and returns true for `0.0.0.0` — correct for a
 * destination, and the precise value that must be refused for a bind.
 */
function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; put a TLS reverse proxy in front for remote access");
    }
    return value;
}

const BASE_URL = readHttpUrl("BASE_URL", "http://localhost:3000");
const FACILITATOR_URL = readHttpUrl("FACILITATOR_URL", DEFAULT_FACILITATOR_URL);
const HOST = readHost();
const PORT = readPort();

const DELIVERABLES: Record<
    string,
    {price: string; description: string; body: Record<string, unknown>}
> = {
    "inv-001": {
        price: "1.00",
        description: "Design deliverable — invoice inv-001",
        body: {invoice: "inv-001", deliverable: "logo-final.svg"},
    },
    "inv-002": {
        price: "2.50",
        description: "Translation deliverable — invoice inv-002",
        body: {invoice: "inv-002", deliverable: "spec-ko.md"},
    },
};

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const app = new Hono();

app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

app.get("/health", (c) => c.json({ok: true, network: GIWA_SEPOLIA_CAIP2, payTo: PAY_TO}));

app.get("/deliverable/:id", async (c) => {
    const id = c.req.param("id");
    const item = DELIVERABLES[id];
    if (!item) return c.json({error: "unknown deliverable"}, 404);

    const requirements = buildPaymentRequirements({
        payTo: PAY_TO,
        amount: toTokenAmount(item.price),
    });

    const payment = readInboundPaymentHeader((name) => c.req.header(name));

    // No payment attached → advertise what's required.
    // In v2 the resource metadata sits at the top level, not inside each requirement.
    if (!payment) {
        const body: PaymentRequired = {
            x402Version: X402_VERSION,
            resource: {
                url: `${BASE_URL}/deliverable/${id}`,
                description: item.description,
                mimeType: "application/json",
            },
            accepts: [requirements],
        };
        // v2 transport advertises the offer in a Payment-Required header; the JSON
        // body stays as the v1-transport form already-deployed agents read.
        c.header(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(body));
        return c.json(body, 402);
    }

    if (payment.value.length > MAX_PAYMENT_HEADER_LENGTH) {
        return fail(c, {
            _tag: "MalformedPayload",
            field: payment.name,
            detail: `exceeds ${MAX_PAYMENT_HEADER_LENGTH} characters`,
        });
    }

    let payload: PaymentPayload;
    try {
        payload = decodePaymentHeader(payment.value);
    } catch {
        return fail(c, {
            _tag: "MalformedPayload",
            field: payment.name,
            detail: "not valid base64 JSON",
        });
    }

    const shapeError = validatePayload(payload, requirements);
    if (shapeError) return fail(c, shapeError);

    const verified = await callFacilitator("/verify", payload, requirements);
    if (!verified.ok) return fail(c, verified.error);
    if (!verified.value.isValid) {
        return fail(c, {
            _tag: "InvalidSignature",
            expectedSigner: payload.payload.authorization.from,
        });
    }

    const settled = await callFacilitator("/settle", payload, requirements);
    if (!settled.ok) return fail(c, settled.error);
    if (!settled.value.success) {
        return fail(c, {_tag: "TxReverted", reason: settled.value.errorReason});
    }

    const txHash =
        typeof settled.value.transaction === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(settled.value.transaction)
            ? settled.value.transaction
            : undefined;
    console.log(
        `[settled] ${id} ${fromTokenAmount(BigInt(requirements.amount))} mUSDC`,
        txHash ? explorerTxUrl(txHash) : "(no hash returned)",
    );

    const receiptHeader = btoa(JSON.stringify(settled.value));
    c.header(PAYMENT_RESPONSE_HEADER, receiptHeader);
    c.header(LEGACY_PAYMENT_RESPONSE_HEADER, receiptHeader);
    return c.json({
        ...item.body,
        receipt: {
            amount: fromTokenAmount(BigInt(requirements.amount)),
            asset: requirements.asset,
            payTo: requirements.payTo,
            from: payload.payload.authorization.from,
            network: requirements.network,
            transaction: txHash,
            explorer: txHash ? explorerTxUrl(txHash) : undefined,
        },
    });
});

/* ------------------------------------------------------------------ *
 * Payload checks
 * ------------------------------------------------------------------ */

/**
 * Reject obviously wrong payloads before spending a facilitator round trip. These are
 * the cases where the facilitator's error would be less specific than ours — a
 * mismatched recipient surfaces downstream as "invalid signature", which sends you
 * looking in the wrong place.
 */
function validatePayload(
    payload: PaymentPayload,
    req: PaymentRequirements,
): SettlementError | null {
    if (!payload || typeof payload !== "object") {
        return {_tag: "MalformedPayload", field: "payload", detail: "expected an object"};
    }
    if (payload.x402Version !== X402_VERSION) {
        return {
            _tag: "MalformedPayload",
            field: "x402Version",
            detail: `got ${payload.x402Version}, expected ${X402_VERSION}`,
        };
    }

    const auth = payload.payload?.authorization;

    if (!auth || !payload.payload?.signature || !isHex(payload.payload.signature)) {
        return {
            _tag: "MalformedPayload",
            field: "payload",
            detail: "missing or malformed signature/authorization",
        };
    }
    if (!payload.accepted) {
        return {
            _tag: "MalformedPayload",
            field: "accepted",
            detail: "v2 payloads must embed the chosen requirements",
        };
    }
    if (!isAddress(auth.from)) {
        return {_tag: "MalformedPayload", field: "authorization.from", detail: auth.from};
    }
    if (!isAddress(auth.to)) {
        return {_tag: "MalformedPayload", field: "authorization.to", detail: auth.to};
    }
    if (!isHex(auth.nonce) || auth.nonce.length !== 66) {
        return {
            _tag: "MalformedPayload",
            field: "authorization.nonce",
            detail: "expected 32-byte hex",
        };
    }
    if (getAddress(auth.to) !== getAddress(req.payTo)) {
        return {
            _tag: "MalformedPayload",
            field: "authorization.to",
            detail: `pays ${auth.to}, expected ${req.payTo}`,
        };
    }
    if (
        payload.accepted.scheme !== req.scheme ||
        payload.accepted.network !== req.network ||
        payload.accepted.amount !== req.amount ||
        payload.accepted.maxTimeoutSeconds !== req.maxTimeoutSeconds ||
        !isAddress(payload.accepted.payTo) ||
        getAddress(payload.accepted.payTo) !== getAddress(req.payTo) ||
        !isAddress(payload.accepted.asset) ||
        getAddress(payload.accepted.asset) !== getAddress(req.asset) ||
        payload.accepted.extra?.name !== req.extra.name ||
        payload.accepted.extra?.version !== req.extra.version
    ) {
        return {
            _tag: "MalformedPayload",
            field: "accepted",
            detail: "embedded requirements do not exactly match the seller offer",
        };
    }

    if (typeof auth.value !== "string" || !/^(0|[1-9]\d*)$/.test(auth.value)) {
        return {_tag: "MalformedPayload", field: "authorization.value", detail: auth.value};
    }
    const value = BigInt(auth.value);
    if (value !== BigInt(req.amount)) {
        return {
            _tag: "MalformedPayload",
            field: "authorization.value",
            detail: `got ${value}, expected ${req.amount}`,
        };
    }

    if (
        typeof auth.validAfter !== "string" ||
        !/^(0|[1-9]\d*)$/.test(auth.validAfter) ||
        typeof auth.validBefore !== "string" ||
        !/^(0|[1-9]\d*)$/.test(auth.validBefore)
    ) {
        return {
            _tag: "MalformedPayload",
            field: "authorization.validity",
            detail: "validAfter/validBefore must be unsigned decimal integers",
        };
    }

    const validAfter = BigInt(auth.validAfter);
    const validBefore = BigInt(auth.validBefore);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (validBefore <= now) {
        return {_tag: "AuthorizationExpired", validBefore, now};
    }
    if (validAfter >= now) {
        return {_tag: "AuthorizationNotYetValid", validAfter, now};
    }
    if (validBefore > now + BigInt(req.maxTimeoutSeconds) + MAX_CLOCK_SKEW_SECONDS) {
        return {
            _tag: "MalformedPayload",
            field: "authorization.validBefore",
            detail: "authorization outlives the advertised timeout",
        };
    }

    return null;
}

/* ------------------------------------------------------------------ *
 * Facilitator
 * ------------------------------------------------------------------ */

interface FacilitatorResult {
    isValid?: boolean;
    success?: boolean;
    transaction?: string;
    errorReason?: string;
    [k: string]: unknown;
}

type Attempt = {ok: true; value: FacilitatorResult} | {ok: false; error: SettlementError};

/**
 * The facilitator is the only network hop on this path, so its failures are the ones
 * most likely to surface mid-demo. Distinguish "unreachable" from "rejected" — the
 * first is ours to fix, the second is the caller's.
 */
async function callFacilitator(
    path: "/verify" | "/settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
): Promise<Attempt> {
    const body: FacilitatorRequest = {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
    };

    let res: Response;
    try {
        res = await fetch(`${FACILITATOR_URL}${path}`, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
        });
    } catch (cause) {
        return {ok: false, error: {_tag: "RpcUnavailable", url: FACILITATOR_URL + path, cause}};
    }

    const text = await res.text();

    if (res.status === 429) {
        return {ok: false, error: {_tag: "RpcRateLimited", url: FACILITATOR_URL + path}};
    }
    if (!res.ok) {
        // Never log the signature: until expiry it is a bearer authorization that can be
        // submitted by anyone, even though the signed recipient and amount cannot change.
        const auth = paymentPayload.payload.authorization;
        const safeResponse = text
            .slice(0, 500)
            .replace(/0x[0-9a-fA-F]{64,}/g, "<redacted-hex>");
        console.error(
            `[facilitator ${path}] ${res.status}: ${JSON.stringify(safeResponse)}`,
        );
        console.error(
            `[facilitator ${path}] request metadata:` +
                ` network=${paymentRequirements.network}` +
                ` asset=${paymentRequirements.asset}` +
                ` amount=${paymentRequirements.amount}` +
                ` from=${auth.from}` +
                ` to=${auth.to}` +
                ` nonce=${auth.nonce}`,
        );
        return {
            ok: false,
            error: {
                _tag: "MalformedPayload",
                field: path,
                detail: `${res.status} facilitator rejected request`,
            },
        };
    }

    try {
        return {ok: true, value: JSON.parse(text) as FacilitatorResult};
    } catch {
        return {
            ok: false,
            error: {_tag: "MalformedPayload", field: path, detail: "facilitator returned non-JSON"},
        };
    }
}

/** Never return a bare 500 — the tag and its description are what make a failed demo debuggable. */
function fail(c: Context, error: SettlementError) {
    console.error(`[${error._tag}] ${describe(error)}`);
    return c.json({error: error._tag, detail: describe(error)}, httpStatusFor(error) as 400);
}

/* ------------------------------------------------------------------ */

console.log(`seller listening on ${HOST}:${PORT}`);
console.log(`  payTo       ${PAY_TO}`);
console.log(`  network     ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  facilitator ${FACILITATOR_URL}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
