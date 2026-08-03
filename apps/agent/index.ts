import {createPublicClient, getAddress, http, isAddress, zeroAddress, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
    EIP3009_TYPES,
    LEGACY_PAYMENT_HEADER,
    MOCK_USDC,
    MOCK_USDC_ABI,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X402_VERSION,
    buildPaymentPayload,
    decodePaymentRequiredHeader,
    encodePaymentHeader,
    explorerTxUrl,
    fromTokenAmount,
    giwaSepolia,
    isLoopbackHost,
    redactForLog,
    toTokenAmount,
    type PaymentRequired,
    type PaymentRequirements,
    type TransferAuthorization,
} from "@mapae/shared";

/**
 * Agent — the payer side.
 *
 * Fetches a gated resource, receives 402, checks the demand against its spending
 * limit, signs an EIP-3009 authorization offchain, and retries. It never submits a
 * transaction and needs no gas: the facilitator broadcasts settlement.
 *
 * Run:  bun run index.ts [/deliverable/inv-001]
 */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function readPayerKey(): Hex {
    const raw = process.env.PAYER_PRIVATE_KEY?.trim() ?? "";

    if (!raw) {
        throw new Error("PAYER_PRIVATE_KEY is required — the paying wallet's private key");
    }
    if (isAddress(raw)) {
        throw new Error(
            "PAYER_PRIVATE_KEY holds an address, not a key. The agent has to sign, so it " +
                "needs the private key of the wallet that holds mUSDC.",
        );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
            `PAYER_PRIVATE_KEY is malformed — expected 0x followed by 64 hex characters, ` +
                `got ${raw.length} characters`,
        );
    }
    return raw as Hex;
}

const account = privateKeyToAccount(readPayerKey());
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_AUTHORIZATION_TIMEOUT_SECONDS = 300;

function readSellerUrl(): URL {
    const raw = process.env.SELLER_URL?.trim() || "http://localhost:3000";
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("SELLER_URL must be an absolute http(s) URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("SELLER_URL must use http(s) and must not contain credentials");
    }
    const loopback = isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error("SELLER_URL must use HTTPS unless it points to loopback");
    }
    return url;
}

function readResource(seller: URL): URL {
    const resource = process.argv[2] ?? "/deliverable/inv-001";
    if (!resource.startsWith("/") || resource.startsWith("//") || resource.includes("\\")) {
        throw new Error("resource must be an absolute path on SELLER_URL, not another origin");
    }

    const target = new URL(resource, seller);
    if (target.origin !== seller.origin) {
        throw new Error("resource resolved outside SELLER_URL");
    }
    return target;
}

const SELLER_URL = readSellerUrl();
const TARGET_URL = readResource(SELLER_URL);

/**
 * Local spending cap. In D3 this moves on-chain as an ERC-7710 `erc20PeriodTransfer`
 * caveat — the limit stops being a promise the agent makes to itself and becomes a
 * constraint the chain enforces.
 */
const MAX_PAYMENT = toTokenAmount(process.env.MAX_PAYMENT ?? "5.00");
if (MAX_PAYMENT <= 0n) throw new Error("MAX_PAYMENT must be greater than zero");

const publicClient = createPublicClient({chain: giwaSepolia, transport: http()});

/* ------------------------------------------------------------------ *
 * Flow
 * ------------------------------------------------------------------ */

async function main() {
    console.log(`agent  ${account.address}`);
    console.log(`target ${TARGET_URL}`);
    console.log(`limit  ${fromTokenAmount(MAX_PAYMENT)} mUSDC`);

    // 1. Ask for the resource with no payment attached.
    const first = await fetch(TARGET_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (first.status !== 402) {
        console.log(`\nno payment required (${first.status})`);
        console.log(await first.text());
        return;
    }

    // v2 transport: the offer rides in the Payment-Required header; the JSON body is
    // the v1-transport fallback. A present-but-unusable header downgrades to the body.
    let body: PaymentRequired | undefined;
    let offerFromHeader = false;
    const offerHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
    if (offerHeader !== null) {
        try {
            body = decodePaymentRequiredHeader(offerHeader) as PaymentRequired;
            offerFromHeader = true;
        } catch {
            body = undefined;
        }
    }
    body ??= (await first.json()) as PaymentRequired;
    if (body?.x402Version !== X402_VERSION) {
        throw new Error(`unsupported x402 version ${body?.x402Version}`);
    }
    const accepted = body.accepts?.[0];
    if (!accepted || typeof accepted !== "object") {
        throw new Error("402 body carried no payment requirements");
    }

    const amount = assertUsableRequirements(accepted);

    console.log(`\n402 → ${fromTokenAmount(amount)} mUSDC to ${accepted.payTo}`);
    console.log(`      asset  ${accepted.asset}`);
    console.log(`      domain ${accepted.extra.name} v${accepted.extra.version}`);

    // 2. Guard rails. Refuse before signing rather than after settling.
    if (amount > MAX_PAYMENT) {
        console.error(
            `\nREFUSED — ${fromTokenAmount(amount)} exceeds limit ${fromTokenAmount(MAX_PAYMENT)}`,
        );
        process.exit(1);
    }

    const balance = await publicClient.readContract({
        address: MOCK_USDC.address,
        abi: MOCK_USDC_ABI,
        functionName: "balanceOf",
        args: [account.address],
    });
    console.log(`      balance ${fromTokenAmount(balance)} mUSDC`);

    if (balance < amount) {
        console.error(
            `\nREFUSED — balance ${fromTokenAmount(balance)} < required ${fromTokenAmount(amount)}`,
        );
        process.exit(1);
    }

    // 3. Sign the authorization. Offchain only — no gas, no transaction.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const auth: TransferAuthorization = {
        from: account.address,
        to: getAddress(accepted.payTo),
        value: amount,
        // Must be strictly in the past: the contract rejects `block.timestamp <= validAfter`.
        // 60s of slack absorbs sequencer clock skew.
        validAfter: now - 60n,
        validBefore: now + BigInt(accepted.maxTimeoutSeconds),
        nonce: randomNonce(),
    };

    const signature = await account.signTypedData({
        // Domain comes from the seller's advertised `extra`; assertUsableRequirements has
        // already confirmed it matches the contract, so a divergence stops the run with a
        // named cause instead of an opaque signature failure.
        domain: {
            name: accepted.extra.name,
            version: accepted.extra.version,
            chainId: giwaSepolia.id,
            verifyingContract: getAddress(accepted.asset),
        },
        types: EIP3009_TYPES,
        primaryType: "TransferWithAuthorization",
        message: auth,
    });

    // v2 embeds the chosen requirements in the payload — that's how the facilitator
    // resolves which scheme handler to use. Omitting it reads as `unsupported_scheme`.
    const payload = buildPaymentPayload({accepted, signature, authorization: auth});

    // 4. Retry with the signed payload attached. The submission name is negotiated
    // from the 402's own transport, like the reference client: header-borne offer →
    // Payment-Signature, body-only offer → X-PAYMENT. Never both — duplicating the
    // payload across two names is what pushed the ERC-7710 flow over the server's
    // total-header limit (431).
    const submissionHeader = offerFromHeader ? PAYMENT_SIGNATURE_HEADER : LEGACY_PAYMENT_HEADER;
    const encodedPayment = encodePaymentHeader(payload);
    console.log(`\nsigned — retrying with ${submissionHeader}`);
    const second = await fetch(TARGET_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {[submissionHeader]: encodedPayment},
    });

    if (!second.ok) {
        // Never read or print the body on a rejected retry: the signed EIP-3009
        // authorization is a bearer credential, and a hostile seller can reflect the
        // submitted header straight back. Report the status class only.
        console.error(`\nFAILED ${second.status}`);
        process.exit(1);
    }

    // The resource was paid for and comes back, but it is seller-controlled text that a
    // seller could stuff with the reflected bearer values. Strip the ones we know before
    // printing — the encoded header and the raw signature.
    const text = (await second.text())
        .split(encodedPayment)
        .join("[redacted: payment header]")
        .split(signature)
        .join("[redacted: signature]");

    console.log(`\nOK ${second.status}`);
    console.log(text);

    const tx = (JSON.parse(text) as {receipt?: {transaction?: string}}).receipt?.transaction;
    if (tx) console.log(`\nexplorer ${explorerTxUrl(tx)}`);
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/**
 * A seller can advertise anything. Only sign for the asset we actually hold, paying an
 * address that is actually an address, on the chain we are configured for.
 */
function assertUsableRequirements(req: PaymentRequirements): bigint {
    if (req.scheme !== "exact") {
        throw new Error(`unexpected payment scheme ${req.scheme}`);
    }
    if (!isAddress(req.asset)) {
        throw new Error(`seller advertised a malformed asset: ${req.asset}`);
    }
    if (!isAddress(req.payTo)) {
        throw new Error(
            `seller advertised a malformed payTo: ${req.payTo} ` +
                `(${String(req.payTo ?? "").length} chars — an address is 42)`,
        );
    }
    if (getAddress(req.payTo) === zeroAddress) {
        throw new Error("seller advertised the zero address as payTo");
    }
    if (getAddress(req.asset) !== getAddress(MOCK_USDC.address)) {
        throw new Error(`unexpected asset ${req.asset} — expected ${MOCK_USDC.address}`);
    }
    if (req.network !== `eip155:${giwaSepolia.id}`) {
        throw new Error(`unexpected network ${req.network} — expected eip155:${giwaSepolia.id}`);
    }
    if (
        req.extra?.name !== MOCK_USDC.eip712.name ||
        req.extra?.version !== MOCK_USDC.eip712.version
    ) {
        throw new Error(
            `EIP-712 domain mismatch — seller says "${req.extra?.name}" v${req.extra?.version}, ` +
            `contract is "${MOCK_USDC.eip712.name}" v${MOCK_USDC.eip712.version}`,
        );
    }
    if (
        !Number.isInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds <= 0 ||
        req.maxTimeoutSeconds > MAX_AUTHORIZATION_TIMEOUT_SECONDS
    ) {
        throw new Error(
            `unsafe maxTimeoutSeconds ${req.maxTimeoutSeconds} — expected 1–` +
                MAX_AUTHORIZATION_TIMEOUT_SECONDS,
        );
    }
    if (typeof req.amount !== "string" || !/^(0|[1-9]\d*)$/.test(req.amount)) {
        throw new Error(`seller demanded a malformed integer amount: ${req.amount}`);
    }

    const amount = BigInt(req.amount);
    if (amount <= 0n) {
        throw new Error(`seller demanded a non-positive amount: ${req.amount}`);
    }
    return amount;
}

/** EIP-3009 nonces are random 32-byte values, not a counter. */
function randomNonce(): Hex {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

main().catch((err: unknown) => {
    // This file builds its client with `http()` and no URL, so today the message it
    // would print holds only the public GIWA endpoint. That is the whole reason this
    // line survived the sweep that fixed the same expression in fifteen other files —
    // and it is one `throttledHttp(readRpcUrl())` away from printing a path-embedded
    // API key. `scripts/check-logging.ts` is what now notices instead of a person.
    console.error(`\n${redactForLog(err)}`);
    process.exit(1);
});
