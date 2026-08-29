import type {Context, MiddlewareHandler} from "hono";
import type {Address, Hex} from "viem";
import {getAddress, isAddress, isHex, zeroAddress} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    LEGACY_PAYMENT_RESPONSE_HEADER,
    MOCK_USDC,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    X402_VERSION,
    buildErc7710PaymentRequirements,
    decodeAnyPaymentHeader,
    encodePaymentRequiredHeader,
    fromTokenAmount,
    isLoopbackHost,
    readInboundPaymentHeader,
    redactForLog,
    toTokenAmount,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type Erc7710SupportedPayload,
    type PaymentRequired,
} from "@mapae/shared";
import {
    decideSettlement,
    decideVerification,
    derivePaymentIntentId,
    type Erc7710FacilitatorRequest,
} from "@mapae/delegation/facilitator-contract";

/**
 * Mapae's public facilitator. It verifies and settles ERC-7710 delegated payments on
 * GIWA Sepolia without registration — any seller may point at it. Testnet only: the
 * asset is tUSDC, which is not money.
 */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.mapae.io";

/** Where a buyer's agent looks for a seller's manifest. */
export const MAPAE_MANIFEST_PATH = "/.well-known/mapae.json";

/**
 * What `onSettled` receives, and what `c.get("mapaeReceipt")` returns in the handler
 * the paywall let through.
 */
export interface SettlementReceipt {
    /**
     * Canonical idempotency key of this exact payment. The facilitator keys its replay
     * cache on the same value, so a ledger keyed on it never records one payment twice.
     */
    intent: Hex;
    /** The root delegator that paid, as confirmed by the facilitator. */
    payer: Address;
    /** Decimal tUSDC string, e.g. `"1.0"` for a price of `"1.00"`. */
    amount: string;
    /** The tUSDC contract on GIWA Sepolia. */
    asset: Address;
    /** Checksummed receiving address. */
    payTo: Address;
    network: "eip155:91342";
    /** GIWA transaction hash, when the facilitator reported one. */
    transaction?: Hex;
}

export interface MapaePaywallOptions {
    /** Your receiving address. Public — never a private key. */
    payTo: string;
    /** Price in tUSDC as a decimal string, e.g. `"0.01"`. Positive, at most 6 fractional digits. */
    price: string;
    /** Human-readable label the buyer's agent sees in the 402 offer. */
    description: string;
    /** Facilitator base URL. Defaults to {@link DEFAULT_FACILITATOR_URL}; HTTPS unless loopback. */
    facilitator?: string;
    /**
     * Runs once per settled payment, before the protected handler. Money has moved by
     * then, so a throw is logged and the buyer is still served — write your ledger here.
     */
    onSettled?: (receipt: SettlementReceipt) => void | Promise<void>;
    /** Injected transport, for tests. Defaults to the global `fetch`. */
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Hono environment the paywall populates: `c.get("mapaeReceipt")` is set once payment settled. */
export type MapaeEnv = {Variables: {mapaeReceipt: SettlementReceipt}};

export interface MapaeManifestEndpoint {
    /** Route path, starting with `/`. */
    path: string;
    /** Price in tUSDC as a decimal string. */
    price: string;
    description: string;
}

/** The document served at {@link MAPAE_MANIFEST_PATH}. */
export interface MapaeManifest {
    version: 1;
    name: string;
    chain: "eip155:91342";
    asset: Address;
    payTo: Address;
    facilitator: string;
    endpoints: MapaeManifestEndpoint[];
}

export interface MapaeManifestOptions {
    name: string;
    payTo: string;
    facilitator?: string;
    endpoints: MapaeManifestEndpoint[];
}

const NETWORK: MapaeManifest["chain"] = GIWA_SEPOLIA_CAIP2;

const MAX_PAYMENT_HEADER_LENGTH = 150_000;

/**
 * Timeout budgets. `/verify` is a simulation and answers quickly; `/settle` broadcasts
 * and waits for a receipt, so it must exceed the facilitator's own receipt wait
 * (25 s by default). Whatever serves this middleware needs an idle timeout above
 * `SETTLE_TIMEOUT_MS`, or the server hangs up on its own settlement — under Bun's server,
 * whose default is 10 s, that means setting `idleTimeout` explicitly.
 */
const VERIFY_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 35_000;
/** How long one `/supported` answer is trusted before it is re-fetched. */
const SUPPORTED_TTL_MS = 5 * 60_000;
/** How long a failed re-fetch keeps serving the last answer before asking again. */
const SUPPORTED_RETRY_MS = 30_000;

function parsePayTo(value: string): Address {
    const trimmed = value.trim();
    if (!isAddress(trimmed)) {
        throw new Error("payTo must be the public receiving address, never a private key");
    }
    const address = getAddress(trimmed);
    if (address === zeroAddress) throw new Error("payTo must not be the zero address");
    return address;
}

function parsePrice(value: string): bigint {
    const amount = toTokenAmount(value);
    if (amount <= 0n) throw new Error(`price must be positive, got "${value}"`);
    return amount;
}

function parseFacilitatorUrl(value: string): string {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("facilitator must be an absolute HTTP(S) URL without credentials");
    }
    if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
        throw new Error("facilitator must use HTTPS unless it is loopback");
    }
    if (url.search || url.hash) {
        throw new Error("facilitator must be a base URL without query or fragment");
    }
    return url.toString().replace(/\/$/, "");
}

/** The GIWA ERC-7710 kind a facilitator advertises — copied verbatim into every offer. */
interface FacilitatorKind {
    facilitatorAddresses: Address[];
    delegationManager?: Address;
}

function readSupportedKind(body: unknown): FacilitatorKind | undefined {
    const kinds = (body as Partial<Erc7710SupportedPayload> | null)?.kinds;
    if (!Array.isArray(kinds)) return undefined;
    for (const kind of kinds as Array<Partial<Erc7710SupportedPayload["kinds"][number]>>) {
        const extra: Partial<Erc7710SupportedPayload["kinds"][number]["extra"]> | undefined =
            kind?.extra;
        if (
            kind?.scheme !== "exact" ||
            kind.network !== NETWORK ||
            extra?.assetTransferMethod !== "erc7710"
        ) {
            continue;
        }
        const addresses: unknown = extra.facilitatorAddresses;
        if (
            !Array.isArray(addresses) ||
            addresses.length === 0 ||
            !addresses.every((address) => typeof address === "string" && isAddress(address))
        ) {
            return undefined;
        }
        const manager: unknown = extra.delegationManager;
        if (manager !== undefined && !(typeof manager === "string" && isAddress(manager))) {
            return undefined;
        }
        return {
            facilitatorAddresses: (addresses as string[]).map((address) => getAddress(address)),
            ...(typeof manager === "string" ? {delegationManager: getAddress(manager)} : {}),
        };
    }
    return undefined;
}

type FacilitatorAnswer = {reachable: boolean; body?: unknown};

/**
 * The three facilitator calls, with the one rule they share: `reachable: false` is every
 * way a call did not yield a body — refused connection, non-2xx, unparseable JSON,
 * timeout. It deliberately does not distinguish them. For `/settle` they are all the
 * same claim, that we do not know whether money moved.
 */
class FacilitatorClient {
    #cached?: {kind: FacilitatorKind; expiresAt: number};
    #discovering?: Promise<FacilitatorKind | undefined>;

    constructor(
        readonly baseUrl: string,
        readonly fetchImpl: NonNullable<MapaePaywallOptions["fetch"]>,
    ) {}

    /**
     * `/supported`, cached, coalesced and kept. A fresh answer is trusted for the TTL;
     * when a re-fetch then fails, the last answer keeps serving — the addresses are
     * advisory, and the facilitator enforces its own identity at `/verify`. Only a
     * facilitator that has never answered yields `undefined`, and that is not cached:
     * the next request asks again, so a facilitator that was briefly down at boot is
     * not remembered as down.
     */
    kind(): Promise<FacilitatorKind | undefined> {
        if (this.#cached && this.#cached.expiresAt > Date.now()) {
            return Promise.resolve(this.#cached.kind);
        }
        this.#discovering ??= this.#discover().finally(() => {
            this.#discovering = undefined;
        });
        return this.#discovering;
    }

    async #discover(): Promise<FacilitatorKind | undefined> {
        const answer = await this.#call("/supported", undefined, VERIFY_TIMEOUT_MS);
        const kind = answer.reachable ? readSupportedKind(answer.body) : undefined;
        if (kind) {
            this.#cached = {kind, expiresAt: Date.now() + SUPPORTED_TTL_MS};
            return kind;
        }
        // Space the retries out: a facilitator that hangs on /supported must not add
        // its whole timeout to every request that follows.
        if (this.#cached) this.#cached.expiresAt = Date.now() + SUPPORTED_RETRY_MS;
        return this.#cached?.kind;
    }

    verify(request: Erc7710FacilitatorRequest): Promise<FacilitatorAnswer> {
        return this.#call("/verify", request, VERIFY_TIMEOUT_MS);
    }

    settle(request: Erc7710FacilitatorRequest): Promise<FacilitatorAnswer> {
        return this.#call("/settle", request, SETTLE_TIMEOUT_MS);
    }

    async #call(
        path: "/supported" | "/verify" | "/settle",
        request: Erc7710FacilitatorRequest | undefined,
        timeoutMs: number,
    ): Promise<FacilitatorAnswer> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: request ? "POST" : "GET",
                ...(request
                    ? {headers: {"content-type": "application/json"}, body: JSON.stringify(request)}
                    : {}),
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) return {reachable: false};
            return {reachable: true, body: (await response.json()) as unknown};
        } catch {
            return {reachable: false};
        }
    }
}

type DecodedPayment = {ok: true; payload: Erc7710PaymentPayload} | {ok: false; detail: string};

/**
 * Structural checks only. The facilitator is the trust boundary: it decodes the signed
 * delegation chain, binds the claimed delegator to the signed root, and refuses an
 * `accepted` offer that differs from ours. What is checked here is the shape the ladder
 * below relies on before it forwards anything.
 */
function readDelegatedPayment(header: string): DecodedPayment {
    let decoded: unknown;
    try {
        decoded = decodeAnyPaymentHeader(header);
    } catch {
        return {ok: false, detail: "invalid base64 JSON"};
    }
    const candidate = decoded as Partial<Erc7710PaymentPayload> | null;
    const extra: unknown = candidate?.accepted?.extra;
    if (
        !extra ||
        typeof extra !== "object" ||
        (extra as {assetTransferMethod?: unknown}).assetTransferMethod !== "erc7710"
    ) {
        return {ok: false, detail: "not an ERC-7710 payment"};
    }
    const payload: Partial<Erc7710PaymentPayload["payload"]> | undefined = candidate?.payload;
    if (
        !payload ||
        typeof payload.delegationManager !== "string" ||
        !isAddress(payload.delegationManager) ||
        typeof payload.delegator !== "string" ||
        !isAddress(payload.delegator) ||
        typeof payload.permissionContext !== "string" ||
        !isHex(payload.permissionContext) ||
        payload.permissionContext.length <= 2
    ) {
        return {ok: false, detail: "invalid delegation payload"};
    }
    return {ok: true, payload: candidate as Erc7710PaymentPayload};
}

/**
 * Settle-before-serve paywall for one price.
 *
 * Without a payment header the request is answered with a 402 carrying the x402 v2
 * offer (header and body). With one, the facilitator is asked to `/verify` and then
 * `/settle`, and only a confirmed settlement lets the next handler run:
 *
 * - 503 `facilitator_unavailable` — `/supported` or `/verify` could not be reached.
 *   Nothing was charged; the buyer may retry.
 * - 400 `malformed_payment` — the header is not a usable ERC-7710 payment.
 * - 403 `delegation_rejected` — the facilitator examined the delegation and refused it.
 * - 504 `settlement_unknown` — the facilitator broadcast but no receipt was seen, or
 *   the answer was lost. The buyer may have been charged and must not re-sign blindly.
 * - 422 `settlement_failed` — the facilitator reports the transfer did not happen.
 *
 * On success the receipt rides in `Payment-Response` (and the legacy
 * `X-PAYMENT-RESPONSE`), `c.get("mapaeReceipt")` holds it, and `onSettled` has run.
 */
export function mapaePaywall(options: MapaePaywallOptions): MiddlewareHandler<MapaeEnv> {
    const payTo = parsePayTo(options.payTo);
    const amount = parsePrice(options.price);
    const facilitator = new FacilitatorClient(
        parseFacilitatorUrl(options.facilitator ?? DEFAULT_FACILITATOR_URL),
        options.fetch ?? ((input, init) => fetch(input, init)),
    );
    const {description, onSettled} = options;

    return async (c, next) => {
        // Never price, let alone settle, a route nothing will serve. When this
        // middleware is the last matched route, `next()` would be a 404 — a buyer
        // must not pay for one.
        if (c.req.routeIndex === c.req.matchedRoutes.length - 1) return c.notFound();

        // Whatever is wrong with the header itself is answered before the facilitator
        // is involved: a bad header costs nobody a network call.
        const payment = readInboundPaymentHeader((name) => c.req.header(name));
        let payload: Erc7710PaymentPayload | undefined;
        if (payment) {
            if (payment.value.length > MAX_PAYMENT_HEADER_LENGTH) {
                return c.json({error: "malformed_payment", detail: "header too large"}, 400);
            }
            const decoded = readDelegatedPayment(payment.value);
            if (!decoded.ok) {
                return c.json({error: "malformed_payment", detail: decoded.detail}, 400);
            }
            payload = decoded.payload;
        }

        const kind = await facilitator.kind();
        if (!kind) return c.json({error: "facilitator_unavailable"}, 503);
        // The facilitator's advertised kind is copied verbatim into the offer: the
        // buyer's agent refuses any offer whose facilitatorAddresses does not overlap
        // its trusted list, and its delegationProvider reads the in-band manager because
        // GIWA's is in no public registry.
        const requirements = buildErc7710PaymentRequirements({
            payTo,
            amount,
            facilitatorAddresses: kind.facilitatorAddresses,
            delegationManager: kind.delegationManager,
        });

        if (!payload) {
            const body: PaymentRequired<Erc7710PaymentRequirements> = {
                x402Version: X402_VERSION,
                resource: {url: c.req.url, description},
                accepts: [requirements],
            };
            // v2 transport puts the offer in a Payment-Required header; the JSON body
            // stays as well, and a client honours whichever of the two it understands.
            c.header(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(body));
            return c.json(body, 402);
        }
        const request: Erc7710FacilitatorRequest = {
            x402Version: X402_VERSION,
            paymentPayload: payload,
            paymentRequirements: requirements,
        };
        // The claimed delegator is what the facilitator's answer is cross-checked
        // against. The facilitator itself binds that claim to the signed root, so an
        // answer naming anyone else is an answer about some other payment.
        const payer = getAddress(payload.payload.delegator);

        // "Could not be reached" and "refused this delegation" are different claims.
        // Nothing is charged at /verify, so 503 is a safe, honest "retry later".
        const verification = decideVerification(await facilitator.verify(request), payer);
        if (verification.kind === "unavailable") {
            return c.json({error: "facilitator_unavailable"}, 503);
        }
        if (verification.kind === "rejected") return c.json({error: "delegation_rejected"}, 403);

        // "Did not succeed" and "is not known to have succeeded" are different claims
        // too. A transport failure, or a facilitator that broadcast without seeing a
        // receipt, leaves the payer possibly charged — 422 would assert they were not.
        const outcome = decideSettlement(await facilitator.settle(request), payer);
        if (outcome.kind === "unknown") return c.json({error: "settlement_unknown"}, 504);
        if (outcome.kind === "failed") return c.json({error: "settlement_failed"}, 422);

        const receipt: SettlementReceipt = {
            intent: derivePaymentIntentId({
                network: requirements.network,
                asset: requirements.asset,
                amount,
                payTo,
                delegationManager: getAddress(payload.payload.delegationManager),
                permissionContext: payload.payload.permissionContext,
            }),
            payer,
            amount: fromTokenAmount(amount),
            asset: requirements.asset,
            payTo,
            network: NETWORK,
            transaction: outcome.transaction,
        };
        c.set("mapaeReceipt", receipt);
        if (onSettled) {
            try {
                await onSettled(receipt);
            } catch (error) {
                // Money has moved. The callback losing it is the seller's bug to see,
                // not a reason to withhold what the buyer paid for.
                console.error(
                    `[mapae] onSettled threw for intent ${receipt.intent} — ${redactForLog(error)}`,
                );
            }
        }

        await next();

        // Built from fields this middleware validated, not by echoing the facilitator's
        // body. Every field is ASCII by construction — a CAIP-2 constant, a checksummed
        // address, a hex hash already matched against /^0x[0-9a-fA-F]{64}$/ — so `btoa`
        // cannot throw here, after settlement, where a throw would be a paid 500.
        const receiptHeader = btoa(
            JSON.stringify({
                success: true,
                network: requirements.network,
                payer,
                transaction: outcome.transaction,
            }),
        );
        c.header(PAYMENT_RESPONSE_HEADER, receiptHeader);
        c.header(LEGACY_PAYMENT_RESPONSE_HEADER, receiptHeader);
    };
}

/**
 * Handler for `GET /.well-known/mapae.json`. Everything is validated once, at
 * construction, so a bad price or address fails the process at boot rather than a
 * buyer at runtime.
 */
export function mapaeManifest(options: MapaeManifestOptions): (c: Context) => Response {
    const name = options.name.trim();
    if (!name) throw new Error("manifest name must not be empty");
    const manifest: MapaeManifest = {
        version: 1,
        name,
        chain: NETWORK,
        asset: MOCK_USDC.address,
        payTo: parsePayTo(options.payTo),
        facilitator: parseFacilitatorUrl(options.facilitator ?? DEFAULT_FACILITATOR_URL),
        endpoints: options.endpoints.map((endpoint) => {
            if (!endpoint.path.startsWith("/")) {
                throw new Error(`manifest endpoint path must start with "/": ${endpoint.path}`);
            }
            if (!endpoint.description.trim()) {
                throw new Error(`manifest endpoint ${endpoint.path} needs a description`);
            }
            parsePrice(endpoint.price);
            return {
                path: endpoint.path,
                price: endpoint.price.trim(),
                description: endpoint.description,
            };
        }),
    };
    return (c) => c.json(manifest);
}
