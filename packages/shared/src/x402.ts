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
     * 정산 순서 선언. 스펙 §6.1은 흐름이 `authorization`이 아니면 이 값을 반드시 싣게
     * 하는데, Mapae는 `/verify`와 `/settle`이 **모두** 성공한 뒤에야 자원을 넘기는
     * `upfront`다. 선언이 없으면 스펙을 읽는 클라이언트는 기본값 `authorization`
     * — 먼저 주고 나중에 정산 — 을 가정하고, 받을 시점을 잘못 계산한다.
     *
     * 이 저장소가 만드는 오퍼는 예외 없이 `"upfront"`를 싣고(빠뜨림은 `x402.test.ts`가
     * `extra` 정확 일치로 잡는다), 그래서 *쓰는* 쪽에는 사실상 리터럴이다. 그런데도
     * 타입이 선택이고 유니온인 것은 *읽는* 쪽의 사실을 적은 것이다 — 우리가 읽는
     * 오퍼에는 이 세 모습이 모두 실제로 온다:
     *
     *   - 부재: `@metamask/x402` 0.2.0의 supportedKind 흐름은 `/supported`의 `extra`에서
     *     `facilitatorAddresses`만 복사한다(`x402-conformance.test.ts`가 고정한 측정값).
     *   - `null`: 참조 구현은 선택 칸의 null을 부재와 같이 접는다(`@x402/core` 2.20.0의
     *     스키마는 `.nullish()`를 쓴다).
     *   - `"authorization"`: 기본값을 성실히 적은 판매자.
     *
     * `escrow`는 이 유니온에 없다. `assertErc7710Offer`와 `validateDelegatedPayment`가
     * 거절하는 값이라 검증을 통과한 오퍼에는 있을 수 없다.
     */
    paymentFlow?: "upfront" | "authorization" | null;
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

/**
 * One entry of the 402 body's `extensions` map, keyed by the extension's name.
 *
 * The spec's envelope is two slots, not an opaque blob: `info` is what the extension
 * itself declares, and `schema` is a JSON Schema describing the shape a client echoes
 * back in its payload. Mapae publishes `info` only — nothing it serves asks the client
 * to echo anything, so there is no shape to describe yet.
 */
export interface PaymentExtension {
    info: unknown;
    schema?: unknown;
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
    extensions?: Record<string, PaymentExtension>;
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
 *
 * Nor is there an `extensions` slot, because nothing here produces one: the spec has a
 * client echo the extensions it actually *used*, and no payer in this repo uses one. The
 * slot arrives together with the first extension that needs it; writing the echo before
 * then would be a guess about a shape no extension has asked for.
 *
 * The reference client is looser than that rule — `@x402/core` 2.20.0 `mergeExtensions`
 * (dist/esm/client/index.mjs:283) returns the seller's whole map when the client adds
 * nothing of its own, so a reference-stack payer paying our hosted shop echoes the
 * `mapae` entry back without ever using it. That reaches us as an unnamed key, and the
 * facilitator's validator compares the fields it names instead of enumerating the object,
 * so it is ignored rather than refused.
 */
export interface PaymentPayload {
    x402Version: typeof X402_VERSION;
    accepted: PaymentRequirements;
    payload: Eip3009Payload;
    resource?: ResourceInfo;
}

export interface Erc7710PaymentPayload {
    x402Version: typeof X402_VERSION;
    accepted: Erc7710PaymentRequirements;
    payload: Erc7710DelegationPayload;
    resource?: ResourceInfo;
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
            paymentFlow: "upfront",
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
            /**
             * 이 레일이 정산 후 제공임을 /supported에서도 선언한다. `@metamask/x402`
             * 0.2.0의 supportedKind 흐름은 `extra`에서 `facilitatorAddresses`만
             * 복사하므로 이 값은 제3자 판매자의 오퍼까지 전파되지 않는다 — 그래서
             * 실제 카운터파티가 만든 오퍼에는 선언이 빠져 있고, 읽는 쪽이 부재를
             * 허용해야 그 오퍼가 산다. 그래도 /supported는 통합자가 레일의 흐름을
             * 질의할 수 있는 유일한 문서다.
             */
            paymentFlow: "upfront";
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
                    paymentFlow: "upfront",
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
 * x402 v2 `SettleResponse`. `transaction` is required, and `""` when no on-chain
 * transaction can be named: a counterparty validating against the reference schema
 * rejects a receipt that simply omits the field.
 *
 * This is the shape we *write*. What arrives from someone else is `unknown` until the
 * reader has checked it, which is why the decoder below does not claim this type.
 */
export interface SettleResponse {
    success: boolean;
    network: string;
    payer: Address;
    transaction: Hex | "";
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

/**
 * A receipt is written by the counterparty, so the decoded value is `unknown`: the only
 * guarantee the codec gives is that the bytes were base64 UTF-8 JSON. The reader
 * (`readSettlementReceipt` in `@mapae/delegation`) decides field by field what it
 * believes, and casting to `SettleResponse` here would only hide that it has to.
 */
export function decodePaymentResponseHeader(header: string): unknown {
    return decodeBase64Json(header);
}
