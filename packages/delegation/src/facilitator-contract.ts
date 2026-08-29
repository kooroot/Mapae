import type {Address, Hex} from "viem";
import {encodeAbiParameters, getAddress, isAddress, keccak256, toBytes} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type FacilitatorRequest,
} from "@mapae/shared";

/**
 * The seller→facilitator contract — request, both responses, the outcome ladder that
 * reads them, and the payment-intent key both sides derive from the same header.
 *
 * This module is deliberately free of the Smart Accounts Kit. `@mapae/seller` bundles
 * it, and a seller that only forwards a header to `/verify` and `/settle` must not
 * carry the delegation toolkit to do so. Everything that decodes a permission context
 * stays in `x402.ts`, which imports from here, never the other way round.
 */

export type Erc7710FacilitatorRequest = FacilitatorRequest<
    Erc7710PaymentPayload,
    Erc7710PaymentRequirements
>;

/**
 * Both halves of the wire in one place.
 *
 * The response half did not always live beside the request half: the facilitator
 * declared `VerifyResponse`/`SettleResponse` privately, the seller declared its own
 * all-optional `FacilitatorResponse`, and the sentinel below was a bare string literal
 * on each side. Two structurally unrelated types describing one wire is a contract
 * TypeScript cannot check — every field optional on the reading side means a producer
 * change type-checks clean on both sides and only shows up as behaviour.
 *
 * What that behaviour would be is known, because it already happened once. Renaming or
 * dropping this sentinel silently converts the seller's answer for a *broadcast but
 * unconfirmed* payment from 504 to 422 — from "you may have been charged" to "you were
 * not". That is the bug that told a caller `PAYMENT_REJECTED` while GIWA tx
 * `0x533c5cb2…9964c` had already moved 1.00 mUSDC out of the payer.
 */
export const SETTLEMENT_UNCONFIRMED = "settlement_unconfirmed";

export interface Erc7710VerifyResponse {
    isValid: boolean;
    payer?: Address;
    invalidReason?: string;
}

export interface Erc7710SettleResponse {
    success: boolean;
    transaction?: Hex;
    network: typeof GIWA_SEPOLIA_CAIP2;
    payer?: Address;
    /** `SETTLEMENT_UNCONFIRMED` means the redemption was broadcast; the receipt was not seen. */
    errorReason?: string;
}

/**
 * What the seller learned by asking the facilitator to settle.
 *
 * Deliberately three cases, not a boolean. `failed` and `unknown` are opposite claims
 * about the payer's balance, and collapsing them is the whole failure this type exists
 * to prevent — a rejection invites a retry, and retrying an `unknown` can pay twice.
 *
 * Verification refusal is not one of them. It is a boolean answered before settlement is
 * ever attempted, so giving this union a `rejected` variant would add a case no producer
 * can reach and no test can reach either.
 */
export type SettlementOutcome =
    | {kind: "unknown"; transaction?: Hex}
    | {kind: "failed"}
    | {kind: "settled"; transaction?: Hex};

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

function readTransaction(value: unknown): Hex | undefined {
    return typeof value === "string" && TRANSACTION_HASH.test(value) ? (value as Hex) : undefined;
}

/**
 * True only when the body claims validity *and* names the payer the seller itself
 * expects for this payment.
 *
 * The payer cross-check is not redundant with the facilitator's own validation: it is
 * what makes a facilitator that validated a *different* request than the one it was
 * handed fail closed rather than have its answer accepted for our payment.
 */
export function isVerificationAccepted(body: unknown, expectedPayer: Address): boolean {
    if (!body || typeof body !== "object") return false;
    const response = body as Erc7710VerifyResponse;
    if (response.isValid !== true) return false;
    return (
        typeof response.payer === "string" &&
        isAddress(response.payer) &&
        getAddress(response.payer) === expectedPayer
    );
}

/**
 * The verification counterpart of {@link SettlementOutcome}, and the reason it is not a
 * boolean: an outage on the `/verify` hop and a facilitator that examined the delegation
 * and refused it are different claims, and collapsing them blames the caller's delegation
 * for the seller's dependency being down (task #37). Nothing is charged at `/verify` — it
 * is a simulation — so `unavailable` is safe to retry, unlike a settlement `unknown`.
 */
export type VerificationOutcome =
    | {kind: "unavailable"}
    | {kind: "rejected"}
    | {kind: "accepted"; payer: Address};

/**
 * Map a `/verify` call onto the three outcomes. `reachable: false` — connection refused,
 * non-2xx, unparseable JSON, timeout — is `unavailable`, never `rejected`: the seller
 * could not obtain a verdict, which is not the same as obtaining a "no".
 */
export function decideVerification(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): VerificationOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unavailable"};
    }
    if (!isVerificationAccepted(response.body, expectedPayer)) {
        return {kind: "rejected"};
    }
    return {kind: "accepted", payer: expectedPayer};
}

/**
 * Map a `/settle` call onto the four outcomes.
 *
 * `reachable: false` covers every way the call did not produce a body we can read —
 * connection refused, non-2xx, unparseable JSON. All of them are `unknown` rather than
 * `failed`, because none of them distinguishes "the request never landed" from "it
 * landed, broadcast, and the answer was lost on the way back".
 */
export function decideSettlement(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): SettlementOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unknown"};
    }
    const body = response.body as Erc7710SettleResponse;
    if (body.errorReason === SETTLEMENT_UNCONFIRMED) {
        return {kind: "unknown", transaction: readTransaction(body.transaction)};
    }
    if (body.success !== true) return {kind: "failed"};
    // Success with a payer we did not derive is not a clean failure. The facilitator
    // said it broadcast, so money may well have moved; only the identity it reports is
    // inconsistent. Answering `failed` here would assert a balance nobody has checked.
    if (
        typeof body.payer !== "string" ||
        !isAddress(body.payer) ||
        getAddress(body.payer) !== expectedPayer
    ) {
        return {kind: "unknown", transaction: readTransaction(body.transaction)};
    }
    return {kind: "settled", transaction: readTransaction(body.transaction)};
}

/** The fields one exact payment is keyed on. Nothing else — no salt, no time, no resource. */
export interface PaymentIntent {
    network: string;
    asset: Address;
    amount: bigint;
    payTo: Address;
    delegationManager: Address;
    permissionContext: Hex;
}

const PAYMENT_INTENT_DOMAIN = keccak256(toBytes("mapae.erc7710.payment-intent.v1"));

/**
 * Canonical, off-chain idempotency key for one exact payment intent.
 *
 * Both ends of the wire compute it from the same header — the facilitator keys its
 * single-flight and replay cache on it, the seller hands it to `onSettled` — so it is
 * derived from nothing but the offer and the signed context. Addresses are ABI-encoded
 * as bytes, so the id is the same whichever case the header spelled them in.
 */
export function derivePaymentIntentId(intent: PaymentIntent): Hex {
    return keccak256(
        encodeAbiParameters(
            [
                {name: "domain", type: "bytes32"},
                {name: "network", type: "string"},
                {name: "asset", type: "address"},
                {name: "amount", type: "uint256"},
                {name: "payTo", type: "address"},
                {name: "delegationManager", type: "address"},
                {name: "permissionContextHash", type: "bytes32"},
            ],
            [
                PAYMENT_INTENT_DOMAIN,
                intent.network,
                intent.asset,
                intent.amount,
                intent.payTo,
                intent.delegationManager,
                keccak256(intent.permissionContext),
            ],
        ),
    );
}
