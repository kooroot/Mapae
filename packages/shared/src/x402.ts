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
    /**
     * Optional in-band advertisement of the DelegationManager this rail settles
     * through. The merged ERC-7710 scheme is registry-free and GIWA's manager is not
     * in `@metamask/delegation-deployments`, so the offer is the only place a
     * third-party agent's delegationProvider — which receives these requirements
     * verbatim — can learn which manager to build its leaf against. Advisory:
     * settlement authority stays with the manager named in the signed payload, which
     * the facilitator allowlists independently.
     */
    delegationManager?: Address;
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
    delegationManager?: Address;
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
            ...(params.delegationManager
                ? {delegationManager: params.delegationManager}
                : {}),
        },
    };
}

export interface Erc7710SupportedPayload {
    kinds: Array<{
        x402Version: number;
        scheme: "exact";
        network: typeof GIWA_SEPOLIA_CAIP2;
        extra: {
            assetTransferMethod: "erc7710";
            facilitatorAddresses: Address[];
            delegationManager?: Address;
        };
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
    /**
     * Discovery only. Measured against `@metamask/x402` 0.2.0: the supportedKind flow
     * copies just `facilitatorAddresses` into offers, so this does not propagate
     * through a third-party seller — but /supported stays the one queryable document
     * where an integrator can read which DelegationManager the rail settles through.
     * The load-bearing in-band channel is the seller's own offer extra.
     */
    delegationManager?: Address;
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
                    ...(params.delegationManager
                        ? {delegationManager: params.delegationManager}
                        : {}),
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
 * v2 transport headers
 * ------------------------------------------------------------------ */

/**
 * x402 v2 carries the whole exchange in HTTP headers: the 402 offer in
 * `Payment-Required`, the payment in `Payment-Signature`, the settlement receipt in
 * `Payment-Response`. Names and codec are the reference implementation's (`@x402/core`,
 * `x402-axum`/`x402-reqwest`), because the reference is what third-party counterparties
 * actually run. There is exactly one submission header: an ERC-7710 payload carries a
 * full permission context, and duplicating it under a second name crossed the HTTP
 * server's total-header limit (a 431 measured on the fork e2e) — and the v1 `X-PAYMENT`
 * transport it used to be duplicated into cannot carry an ERC-7710 offer at all, the
 * method being v2-only.
 */
export const PAYMENT_REQUIRED_HEADER = "Payment-Required";
export const PAYMENT_SIGNATURE_HEADER = "Payment-Signature";
export const PAYMENT_RESPONSE_HEADER = "Payment-Response";

/**
 * Settlement receipt a resource server returns in `Payment-Response` beside a 2xx — the
 * x402 v2 `SettleResponse`. The spec makes `transaction` required and `""` when no
 * on-chain transaction can be named; `@mapae/seller` still omits the field when its
 * facilitator reported none, and the agent reads both forms as "no hash".
 */
export interface SettleResponse {
    success: boolean;
    network: string;
    payer: Address;
    transaction?: Hex | "";
    errorReason?: string;
}

/* ------------------------------------------------------------------ *
 * Header codec
 * ------------------------------------------------------------------ */

/**
 * Base64 over UTF-8 bytes — the reference codec (`@x402/core` `safeBase64Encode`:
 * `TextEncoder` → `btoa`), shared by every header above. Not bare `btoa`, which encodes
 * Latin-1 and throws past U+00FF: the 402 offer carries human-facing text (Korean, em
 * dashes) and the payment payload echoes that offer back verbatim, so one codec for both
 * directions is what keeps a header this repo writes readable by a counterparty that is
 * not this repo.
 */
function encodeBase64Json(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * `fatal` matters: the default decoder swaps invalid sequences for U+FFFD and reports
 * success, which would hand the caller a plausibly-shaped value whose strings are
 * silently corrupted. A malformed header must be a refusal.
 */
function decodeBase64Json(text: string): unknown {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
}

export function encodePaymentRequiredHeader(
    body: PaymentRequired<AnyPaymentRequirements>,
): string {
    return encodeBase64Json(body);
}

export function decodePaymentRequiredHeader(
    header: string,
): PaymentRequired<AnyPaymentRequirements> {
    return decodeBase64Json(header) as PaymentRequired<AnyPaymentRequirements>;
}

export function encodePaymentHeader(payload: AnyPaymentPayload): string {
    return encodeBase64Json(payload);
}

export function decodePaymentHeader(header: string): AnyPaymentPayload {
    return decodeBase64Json(header) as AnyPaymentPayload;
}

export function encodePaymentResponseHeader(receipt: SettleResponse): string {
    return encodeBase64Json(receipt);
}

export function decodePaymentResponseHeader(header: string): SettleResponse {
    return decodeBase64Json(header) as SettleResponse;
}
