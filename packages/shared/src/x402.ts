import type {Address, Hex} from "viem";
import {GIWA_SEPOLIA_CAIP2} from "./chain.js";
import {MOCK_USDC, type TransferAuthorization} from "./token.js";

/**
 * x402 **v2** wire types.
 *
 * Shapes below mirror the Rust structs the facilitator actually deserializes
 * (`x402_types::proto::v2`), not the v1 examples that circulate in most guides.
 * The two differ in ways that fail silently as `unsupported_scheme`:
 *
 *   v1 requirements: scheme, network(name), maxAmountRequired, resource,
 *                    description, mimeType, payTo, maxTimeoutSeconds, asset, extra?
 *   v2 requirements: scheme, network(CAIP-2), amount, payTo, maxTimeoutSeconds,
 *                    asset, extra
 *
 * `resource` and friends moved up to the 402 body; `maxAmountRequired` became
 * `amount`; `network` became a CAIP-2 id.
 */

export const X402_VERSION = 2 as const;

/* ------------------------------------------------------------------ *
 * Requirements
 * ------------------------------------------------------------------ */

/**
 * EIP-3009 domain parameters.
 *
 * The facilitator accepts three wire forms; this is the implicit one
 * (`{name, version}` with no `assetTransferMethod` tag), which it reads as EIP-3009.
 */
export interface Eip3009Extra {
    name: string;
    version: string;
}

/** ERC-7710 exact-EVM transfer metadata from the x402 v2 specification. */
export interface Erc7710Extra {
    [key: string]: unknown;
    assetTransferMethod: "erc7710";
    /**
     * Optional facilitator redeemer allowlist. A delegated agent intersects this
     * list with its own allowlist before signing a payment-specific leaf delegation.
     */
    facilitatorAddresses?: Address[];
}

interface ExactPaymentRequirements<TExtra> {
    scheme: "exact";
    /** CAIP-2 chain id, e.g. "eip155:91342". */
    network: string;
    /** Integer string in token base units — v1 called this `maxAmountRequired`. */
    amount: string;
    payTo: Address;
    maxTimeoutSeconds: number;
    asset: Address;
    extra: TExtra;
}

/** Backward-compatible name for the existing D2 EIP-3009 route. */
export interface PaymentRequirements {
    scheme: ExactPaymentRequirements<Eip3009Extra>["scheme"];
    network: ExactPaymentRequirements<Eip3009Extra>["network"];
    amount: ExactPaymentRequirements<Eip3009Extra>["amount"];
    payTo: ExactPaymentRequirements<Eip3009Extra>["payTo"];
    maxTimeoutSeconds: ExactPaymentRequirements<Eip3009Extra>["maxTimeoutSeconds"];
    asset: ExactPaymentRequirements<Eip3009Extra>["asset"];
    extra: ExactPaymentRequirements<Eip3009Extra>["extra"];
}

export type Erc7710PaymentRequirements = ExactPaymentRequirements<Erc7710Extra>;
export type AnyPaymentRequirements = PaymentRequirements | Erc7710PaymentRequirements;

/* ------------------------------------------------------------------ *
 * 402 response body
 * ------------------------------------------------------------------ */

export interface ResourceInfo {
    url?: string;
    description?: string;
    mimeType?: string;
}

/** The body a seller returns with HTTP 402. */
export interface PaymentRequired<
    TRequirements extends AnyPaymentRequirements = PaymentRequirements,
> {
    x402Version: typeof X402_VERSION;
    error?: string;
    /** Resource metadata lives here in v2, not inside each requirement. */
    resource?: ResourceInfo;
    accepts: TRequirements[];
    extensions?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Payment payload
 * ------------------------------------------------------------------ */

export interface Eip3009AuthorizationWire {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
}

export interface Eip3009Payload {
    signature: Hex;
    authorization: Eip3009AuthorizationWire;
}

/** Opaque, signed delegation chain carried by an ERC-7710 x402 payment. */
export interface Erc7710DelegationPayload {
    delegationManager: Address;
    permissionContext: Hex;
    /**
     * Claimed root smart account required by the ERC-7710 wire format.
     * A facilitator must bind it to the last/root delegation in permissionContext.
     */
    delegator: Address;
}

/**
 * v2 payload. Note there is no top-level `scheme`/`network`: the chosen
 * requirements are embedded under `accepted`, which is how the facilitator
 * resolves which scheme handler to use.
 */
export interface PaymentPayload {
    x402Version: typeof X402_VERSION;
    accepted: PaymentRequirements;
    payload: Eip3009Payload;
    resource?: ResourceInfo;
    extensions?: Record<string, unknown>;
}

export interface Erc7710PaymentPayload {
    x402Version: typeof X402_VERSION;
    accepted: Erc7710PaymentRequirements;
    payload: Erc7710DelegationPayload;
    resource?: ResourceInfo;
    extensions?: Record<string, unknown>;
}

export type AnyPaymentPayload = PaymentPayload | Erc7710PaymentPayload;

/** Envelope for POST /verify and POST /settle. */
export interface FacilitatorRequest<
    TPayload extends AnyPaymentPayload = PaymentPayload,
    TRequirements extends AnyPaymentRequirements = PaymentRequirements,
> {
    x402Version: typeof X402_VERSION;
    paymentPayload: TPayload;
    paymentRequirements: TRequirements;
}

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

/**
 * Build requirements for a resource. Asset and EIP-712 domain come from the
 * shared token constants so the seller's advertisement and the agent's signature
 * can never drift apart.
 */
export function buildPaymentRequirements(params: {
    payTo: Address;
    amount: bigint;
    maxTimeoutSeconds?: number;
}): PaymentRequirements {
    return {
        scheme: "exact",
        network: GIWA_SEPOLIA_CAIP2,
        amount: params.amount.toString(),
        payTo: params.payTo,
        maxTimeoutSeconds: params.maxTimeoutSeconds ?? 60,
        asset: MOCK_USDC.address,
        extra: {
            name: MOCK_USDC.eip712.name,
            version: MOCK_USDC.eip712.version,
        },
    };
}

export function buildErc7710PaymentRequirements(params: {
    payTo: Address;
    amount: bigint;
    facilitatorAddresses?: Address[];
    maxTimeoutSeconds?: number;
}): Erc7710PaymentRequirements {
    return {
        scheme: "exact",
        network: GIWA_SEPOLIA_CAIP2,
        amount: params.amount.toString(),
        payTo: params.payTo,
        maxTimeoutSeconds: params.maxTimeoutSeconds ?? 60,
        asset: MOCK_USDC.address,
        extra: {
            assetTransferMethod: "erc7710",
            ...(params.facilitatorAddresses
                ? {facilitatorAddresses: params.facilitatorAddresses}
                : {}),
        },
    };
}

export interface Erc7710SupportedPayload {
    kinds: Array<{
        x402Version: number;
        scheme: "exact";
        network: typeof GIWA_SEPOLIA_CAIP2;
        extra: {assetTransferMethod: "erc7710"; facilitatorAddresses: Address[]};
    }>;
    extensions: never[];
    signers: Record<string, Address[]>;
}

/**
 * The `/supported` document an ERC-7710 facilitator serves. The facilitator
 * identity is deliberately advertised twice: this repo's own seller and agent read
 * `signers`, while a third-party resource server copies `kinds[].extra` verbatim
 * into its offers (the supportedKind flow) — and the agent then refuses any offer
 * whose `facilitatorAddresses` does not overlap its trusted list. Building both
 * channels from one argument is what keeps them from drifting; an offer built from
 * either channel must pass the check that reads the other.
 */
export function buildErc7710SupportedPayload(params: {
    facilitatorAddresses: Address[];
}): Erc7710SupportedPayload {
    return {
        kinds: [
            {
                x402Version: X402_VERSION,
                scheme: "exact",
                network: GIWA_SEPOLIA_CAIP2,
                extra: {
                    assetTransferMethod: "erc7710",
                    facilitatorAddresses: params.facilitatorAddresses,
                },
            },
        ],
        extensions: [],
        signers: {[GIWA_SEPOLIA_CAIP2]: params.facilitatorAddresses},
    };
}

export function buildPaymentPayload(params: {
    accepted: PaymentRequirements;
    signature: Hex;
    authorization: TransferAuthorization;
}): PaymentPayload {
    return {
        x402Version: X402_VERSION,
        accepted: params.accepted,
        payload: {
            signature: params.signature,
            authorization: toWireAuthorization(params.authorization),
        },
    };
}

export function buildErc7710PaymentPayload(params: {
    accepted: Erc7710PaymentRequirements;
    delegationManager: Address;
    permissionContext: Hex;
    delegator: Address;
}): Erc7710PaymentPayload {
    return {
        x402Version: X402_VERSION,
        accepted: params.accepted,
        payload: {
            delegationManager: params.delegationManager,
            permissionContext: params.permissionContext,
            delegator: params.delegator,
        },
    };
}

/** bigint → decimal string, as the wire format expects. */
export function toWireAuthorization(auth: TransferAuthorization): Eip3009AuthorizationWire {
    return {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
    };
}

/* ------------------------------------------------------------------ *
 * Header codec
 * ------------------------------------------------------------------ */

/**
 * `btoa` is Latin-1 only — one character above U+00FF anywhere in the payload and it
 * throws a bare `DOMException: The string contains invalid characters.`
 *
 * That matters here more than it looks. The payload echoes the seller's own requirements
 * object back, so the offending byte is attacker-controlled, and on the agent's path this
 * call happens *after* the leaf delegation has been signed: the throw would leave a bearer
 * authorization in existence while the caller received an opaque DOM error naming neither
 * the seller nor the field. The seller already reasons about exactly this hazard on its
 * own side (`apps/delegated-seller/index.ts`, X-PAYMENT-RESPONSE).
 *
 * This guard is the backstop, not the fix — callers should refuse an unencodable offer
 * before they sign anything. It exists so that any *other* caller gets a message that
 * names the problem instead of a DOMException.
 */
export function encodePaymentHeader(payload: AnyPaymentPayload): string {
    const json = JSON.stringify(payload);
    if (!isLatin1(json)) {
        throw new Error(
            "payment payload is not Latin-1 encodable, so it cannot be base64 header-encoded",
        );
    }
    return btoa(json);
}

/**
 * Every code unit within `btoa`'s range. Surrogate halves are above U+00FF, so an emoji
 * or any astral character fails here rather than at the codec.
 */
export function isLatin1(value: string): boolean {
    // Written with explicit escapes: a literal range would put the very characters
    // this guards against into the file that defines the guard.
    return !/[^\u0000-\u00FF]/u.test(value);
}

export function decodePaymentHeader(header: string): PaymentPayload {
    return JSON.parse(atob(header)) as PaymentPayload;
}

export function decodeAnyPaymentHeader(header: string): AnyPaymentPayload {
    return JSON.parse(atob(header)) as AnyPaymentPayload;
}
