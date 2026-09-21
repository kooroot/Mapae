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
 * unconfirmed* payment from 504 to a 402 that re-issues the offer — from "you may have
 * been charged" to "pay again". That is the bug that told a caller `PAYMENT_REJECTED`
 * while GIWA tx
 * `0x533c5cb2…9964c` had already moved 1.00 mUSDC out of the payer.
 *
 * The word is x402 v2's (§9 `settlement_pending`), and the spec binds it to a
 * non-empty `transaction`. Under its old name (*unconfirmed*) the hash was optional,
 * because one producer had none: an unreadable recovery journal. That case
 * is not a payment in doubt — the request examined nothing and charged nothing — and
 * is answered not-ready ({@link FACILITATOR_NOT_READY}) instead. Every remaining
 * producer computes the hash before the broadcast, so a pending answer without one no
 * longer exists.
 */
export const SETTLEMENT_PENDING = "settlement_pending";

/**
 * The header a seller forwards the buyer's `CF-Connecting-IP` in. The facilitator
 * rate-limits `/verify` and `/settle` per client address, and a seller on the same
 * machine reaches it over loopback, where no `CF-Connecting-IP` exists — without the
 * forwarded name every buyer of that seller was one unlimited caller. The facilitator
 * reads it only when `CF-Connecting-IP` itself is absent, so a request through the
 * tunnel cannot use it to be counted as somebody else.
 */
export const CLIENT_IP_HEADER = "x-mapae-client-ip";

/**
 * The facilitator's per-address limit refused the request before reading it. Both
 * routes answer it as a 200 carrying this reason — a non-2xx from `/settle` reads as
 * "the answer was lost" on the seller side, and a request that was never read cannot
 * have charged anybody. The seller reads it as `unavailable`: retry later, on both
 * routes, never a rejected delegation and never a possibly-charged payment.
 */
export const RATE_LIMITED = "rate_limited";

/**
 * The facilitator's readiness probe failed for the caller that shared it, so no verdict
 * was formed. `/verify` answers it as a 503 — the seller reads any non-2xx there as
 * unavailable, and so does anyone else's client. `/settle` cannot use a status code
 * for it, since a non-2xx there means "the answer was lost"; it answers a 200 carrying
 * this reason. Both bodies carry it, and the seller reads it on both routes as it
 * reads {@link RATE_LIMITED} — whatever status it arrived under: nothing was examined,
 * nothing was charged, try again later.
 */
export const FACILITATOR_NOT_READY = "facilitator_not_ready";

/**
 * §9's word for a payment whose text could not be read at all: oversized
 * `Payment-Signature`, bytes that are not base64 UTF-8 JSON, a payload that is not an
 * ERC-7710 delegation. The seller answers those 400 and names this word in the receipt.
 *
 * Named here, beside the other words both ends of this wire read, because both ends do
 * read it: the seller writes it and `payment-client.ts` matches it as a §9 refusal. A word
 * spelled out twice is a word that can be renamed on one side only.
 *
 * The seller reaches it on its own, before any facilitator call, and there the receipt names
 * no payer. But it is not a word that belongs to that rung: the facilitator produces it too
 * — `apps/facilitator-erc7710/routes.ts` for a body it cannot read, `x402.ts` for an
 * `accepted` block that disagrees with the offer or a delegator that is not the signed root
 * — and it is a member of {@link KNOWN_REFUSAL_REASONS}, so {@link foldRefusalReason} passes
 * it through and the same word arrives on a 402 that re-issues the offer, with a payer. Both
 * ends reaching one word for two different rungs is the reason it is declared here; the rung
 * itself is read from the status, never from the word.
 */
export const INVALID_PAYLOAD = "invalid_payload";

/**
 * The Mapae profile's one refusal word outside the x402 §9 vocabulary: the facilitator
 * examined the delegation against live state and the chain would not redeem it — the
 * simulation reverted, or the redemption priced above its gas cap. Neither is a defect
 * in the request's text (§9 has words for those) nor an unexpected failure of ours; it
 * is the verdict the delegation earned, and the seller answers it with a fresh 402 so
 * the buyer can sign a new leaf. The reason stays this one word on purpose — the revert
 * text names the caveat that fired, which is the caller's boundary to probe.
 *
 * It lives here rather than in the facilitator, beside the other words both ends of this
 * wire read, because the seller now branches on it: a word declared twice is a word that
 * can be renamed on one side only.
 */
export const DELEGATION_REJECTED = "delegation_rejected";

/**
 * The redemption was mined and moved the asset, but the seller's `payTo` is not what it
 * credited. The one failure word that must not be answered with a re-issued offer: the
 * buyer's balance is gone, so inviting a second payment charges them twice for a sale
 * this wire cannot refund.
 */
export const VENDOR_NOT_CREDITED = "vendor_not_credited";

/** A mined redemption that reverted: broadcast, gas spent by the facilitator, nothing transferred. */
export const SETTLEMENT_REVERTED = "settlement_reverted";

/**
 * 같은 `payment-identifier`에 다른 결제가 왔다 — 판매자의 409.
 *
 * §9에 없는 이 프로필의 두 번째 낱말이고, {@link DELEGATION_REJECTED}와 달리
 * **facilitator가 만들지 않는다**: 확장의 바인딩은 자원 서버가 쥔 약속이고, 퍼실리테이터는
 * id를 보지도 않는다. 그래서 {@link KNOWN_REFUSAL_REASONS}에 넣지 않았다 — 그 집합은
 * 퍼실리테이터의 낱말을 통과시키는 필터이고, 이 낱말이 거기 있으면 퍼실리테이터가 남의
 * 약속을 대신 깼다고 주장하는 답이 402로 그대로 흘러나간다.
 *
 * 여기 선언하는 이유는 {@link INVALID_PAYLOAD}와 같다: 판매자가 쓰고
 * `payment-client.ts`가 읽는다(닫힌 집합에서 `PAYMENT_REJECTED`로 분류한다 — 같은 id로는
 * 다시 시도해서는 안 되는 실패다). 한쪽에만 적힌 낱말은 한쪽에서만 이름이 바뀔 수 있다.
 *
 * 근거는 사양의 "Idempotency Behavior" 표다: 같은 id에 다른 요청이 오면 캐시된 결과를
 * 주지도, 두 번째 연산을 하지도 말고 409로 실패해야 한다. 서버가 안전하게 고를 수 있는
 * 답이 없다 — 클라이언트가 스스로 한 멱등성 약속을 깬 것이기 때문이다.
 */
export const PAYMENT_IDENTIFIER_CONFLICT = "payment_identifier_conflict";

/**
 * §9's words for a failure that is ours rather than the request's, one per route.
 *
 * Neither is a verdict, so neither reaches the seller as one. `unexpected_verify_error` is
 * {@link VerificationOutcome} `unavailable` — nothing about the delegation was decided,
 * and `/verify` never broadcasts, so nothing is in doubt either (see
 * {@link decideVerification}).
 *
 * `unexpected_settle_error` is {@link SettlementOutcome} `unknown`. "An unexpected error
 * while settling" is, by its own name, a failure whose place in the sequence is not known,
 * and a wire that cannot say whether it broadcast cannot claim nobody was charged. This
 * facilitator raises it only before the broadcast — `guards.ts` `describeFailure`, always
 * with `transaction: ""` — but `@mapae/seller` is pointed at whichever facilitator its
 * operator configured, and the cheap mistake on this rung is a lookup while the expensive
 * one is a second payment.
 */
export const UNEXPECTED_VERIFY_ERROR = "unexpected_verify_error";
export const UNEXPECTED_SETTLE_ERROR = "unexpected_settle_error";

/**
 * Every refusal word this profile knows, as a closed allow-list.
 *
 * A facilitator's reason is a free string on the wire, and the seller now re-emits it to
 * the buyer in `Payment-Response`. Re-emitting it verbatim would make a facilitator's
 * prose part of the seller's answer — the rule this repository has kept since the
 * facilitator stopped putting revert text on the wire. So a word is passed through only
 * when it is one of these, and anything else folds to {@link DELEGATION_REJECTED}.
 *
 * Deliberately absent, each because it is classified before the fold is reached and
 * because a refusal wearing it would be read as something else entirely by the buyer's
 * client: {@link SETTLEMENT_PENDING} (money may have moved), {@link RATE_LIMITED} and
 * {@link FACILITATOR_NOT_READY} (nothing was examined, retry later), and
 * {@link UNEXPECTED_VERIFY_ERROR} / {@link UNEXPECTED_SETTLE_ERROR} (no verdict at all,
 * and on `/settle` no claim about the broadcast either). {@link PAYMENT_IDENTIFIER_CONFLICT}
 * is absent for a different reason: no facilitator produces it, because the
 * `payment-identifier` binding is a promise the resource server keeps on its own.
 *
 * Every word admitted here is answered with a 402 that re-issues the offer, the five that
 * name a defect in the request's own text included (`unsupported_scheme`, `invalid_network`,
 * {@link INVALID_PAYLOAD}, `invalid_payment_requirements`, `invalid_x402_version`). That is
 * deliberate rather than an oversight of the spec's 400 mapping: 400 is this profile's
 * answer to a payment it could not *read*, and a payload that parsed but disagrees with
 * the offer is fixed by reading the offer that comes back with the 402 — which is exactly
 * what a buyer who signed against a stale or misread offer needs. The seller's docs state
 * the rung, so a client that loops on 402 loops against a corrected offer, not a blank one.
 *
 * {@link INVALID_PAYLOAD} is in that list, so one word spans two rungs: the seller's own 400
 * for a header it could not read, and this fold's 402 for a facilitator that read the body
 * and refused its text. A client reads the rung off the status, never off the word.
 */
const KNOWN_REFUSAL_REASONS: ReadonlySet<string> = new Set([
    // x402 v2 §9, every word that names a refusal formed before any broadcast.
    "insufficient_funds",
    "invalid_scheme",
    "unsupported_scheme",
    "invalid_network",
    INVALID_PAYLOAD,
    "invalid_payment_requirements",
    "invalid_x402_version",
    "invalid_transaction_state",
    // This profile's own. The budget words are `@mapae/store`'s
    // (`SettlementBudgetExceeded`); they are admitted here and nothing branches on them,
    // so a rename there costs a pass-through, never a wrong status.
    DELEGATION_REJECTED,
    "payer_budget_exhausted",
    "budget_exhausted",
    // Mined failures, classified from the receipt by the facilitator's settlement.ts.
    SETTLEMENT_REVERTED,
    VENDOR_NOT_CREDITED,
]);

/**
 * The two words that name a failure formed *after* the broadcast: the only ones a body
 * naming a transaction hash may wear and still have settled the question of who was
 * charged. Everything else in {@link KNOWN_REFUSAL_REASONS} — and everything the fold
 * turns into {@link DELEGATION_REJECTED} — claims a refusal formed before any broadcast,
 * which a named hash contradicts. See {@link decideSettlement}.
 */
const MINED_REFUSAL_REASONS: ReadonlySet<string> = new Set([SETTLEMENT_REVERTED, VENDOR_NOT_CREDITED]);

/** The facilitator's word if we know it, {@link DELEGATION_REJECTED} if we do not. */
function foldRefusalReason(value: unknown): string {
    return typeof value === "string" && KNOWN_REFUSAL_REASONS.has(value)
        ? value
        : DELEGATION_REJECTED;
}

export interface Erc7710VerifyResponse {
    isValid: boolean;
    payer?: Address;
    invalidReason?: string;
}

export interface Erc7710SettleResponse {
    success: boolean;
    /**
     * Always present, as x402 v2 requires: the hash of the redemption, or `""` when
     * nothing was broadcast. A `SETTLEMENT_PENDING` body never carries `""`.
     */
    transaction: Hex | "";
    network: typeof GIWA_SEPOLIA_CAIP2;
    payer?: Address;
    /**
     * `SETTLEMENT_PENDING` means the transaction named above is not yet resolved;
     * otherwise it is why the settlement failed — a word of
     * {@link KNOWN_REFUSAL_REASONS} for every refusal this profile produces, and a free
     * string as far as this type is concerned, which is why the seller folds it before
     * putting it on its own wire.
     */
    errorReason?: string;
    /**
     * Present when this call is not the one that performed the answer it carries: a
     * journal row for the intent already existed when it began — terminal or not, and
     * at most it re-sent the very bytes that row already named, which can only ever
     * produce the same hash — or it was coalesced into a concurrent call's operation.
     * Absent, this call is the one that settled the intent, or failed before
     * broadcasting anything.
     *
     * So at most one answer per intent is unmarked, and a recovered settlement is
     * otherwise the same body as a fresh one. It is not a delivery gate by itself: when
     * a first attempt ends `settlement_pending` and a later call finishes the claim,
     * every successful answer is marked. A seller that ships once per sale dedupes on
     * its own record of the payment intent id and reads this as what it says — "some
     * other call did this".
     */
    replayed?: true;
}

/**
 * What the seller learned by asking the facilitator to settle.
 *
 * Deliberately not a boolean. `failed` and `unknown` are opposite claims about the
 * payer's balance, and collapsing them is the whole failure this type exists to prevent
 * — a rejection invites a retry, and retrying an `unknown` can pay twice. `unavailable`
 * is the facilitator refusing to look at the request at all — its rate limit fired
 * before the body was read, or its readiness probe failed — so nothing was charged and
 * nothing is in doubt: the buyer may present the same payment again later, which
 * neither of the other two may say.
 *
 * Verification refusal is not one of them. It is a boolean answered before settlement is
 * ever attempted, so giving this union a `rejected` variant would add a case no producer
 * can reach and no test can reach either.
 *
 * `settled.replayed` is the facilitator's own word: true only when the body said so,
 * i.e. the answer is a recorded earlier settlement rather than one this call performed.
 *
 * `unavailable` and `failed` each carry the word the seller puts in its own
 * `Payment-Response`: the facilitator's, when it is one of {@link KNOWN_REFUSAL_REASONS},
 * and never its free text. `failed.transaction` is the hash the body named, and only a
 * mined failure ({@link MINED_REFUSAL_REASONS}) reaches `failed` with one — a body that
 * names a hash under any other word is `unknown`, because the word claims a refusal formed
 * before the broadcast and the hash says something was broadcast anyway.
 */
export type SettlementOutcome =
    | {kind: "unavailable"; errorReason: typeof RATE_LIMITED | typeof FACILITATOR_NOT_READY}
    | {kind: "unknown"; transaction?: Hex}
    | {kind: "failed"; errorReason: string; transaction?: Hex}
    | {kind: "settled"; transaction?: Hex; replayed: boolean};

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A hash, or nothing — the wire's `""` and anything else that is not a hash read alike. */
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
 *
 * There is no `unknown` here. `/verify` never broadcasts, and the one answer that used
 * to carry the pending sentinel — an unreadable recovery journal — is not-ready now,
 * which is `unavailable`.
 *
 * Both refusals carry the word the seller re-emits in `Payment-Response`. `unavailable`
 * carries only the two that mean "no verdict, nothing charged, try again" — a 503 the
 * buyer's client reads as retryable must not wear a word that says anything else — and
 * `rejected` carries one of {@link KNOWN_REFUSAL_REASONS}, never the facilitator's prose.
 */
export type VerificationOutcome =
    | {kind: "unavailable"; errorReason: typeof RATE_LIMITED | typeof FACILITATOR_NOT_READY}
    | {kind: "rejected"; errorReason: string}
    | {kind: "accepted"; payer: Address};

/**
 * Map a `/verify` call onto the three outcomes. `reachable: false` — connection refused,
 * non-2xx, unparseable JSON, timeout — is `unavailable`, never `rejected`: the seller
 * could not obtain a verdict, which is not the same as obtaining a "no". So is a body
 * saying the facilitator refused to form one ({@link RATE_LIMITED},
 * {@link FACILITATOR_NOT_READY}): the delegation was not examined, and blaming it would
 * send the buyer to re-sign what nothing refused.
 *
 * {@link UNEXPECTED_VERIFY_ERROR} is the third answer that is not a verdict, and it is
 * read the same way. It is §9's word for a throw of ours before the broadcast: nobody was
 * charged *and* nothing about the delegation was decided. Read as `rejected` it would
 * send the buyer to sign a new leaf because our own RPC call raised — so it reports as
 * not-ready, which is what the seller's 503 says, and the facilitator's own word for it
 * stays in the facilitator's log.
 */
export function decideVerification(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): VerificationOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unavailable", errorReason: FACILITATOR_NOT_READY};
    }
    const {invalidReason} = response.body as Erc7710VerifyResponse;
    if (invalidReason === RATE_LIMITED) return {kind: "unavailable", errorReason: RATE_LIMITED};
    if (invalidReason === FACILITATOR_NOT_READY || invalidReason === UNEXPECTED_VERIFY_ERROR) {
        return {kind: "unavailable", errorReason: FACILITATOR_NOT_READY};
    }
    if (!isVerificationAccepted(response.body, expectedPayer)) {
        return {kind: "rejected", errorReason: foldRefusalReason(invalidReason)};
    }
    return {kind: "accepted", payer: expectedPayer};
}

/**
 * Map a `/settle` call onto the four outcomes.
 *
 * `reachable: false` covers every way the call did not produce a body we can read —
 * connection refused, non-2xx, unparseable JSON. All of them are `unknown` rather than
 * `failed`, because none of them distinguishes "the request never landed" from "it
 * landed, broadcast, and the answer was lost on the way back". A body that says the
 * request was refused unexamined ({@link RATE_LIMITED}, {@link FACILITATOR_NOT_READY})
 * is the one answer that rules both out, and is `unavailable`.
 *
 * On a `success: false` body the hash outranks the word. Every word that can reach
 * `failed` claims a refusal formed before any broadcast — {@link foldRefusalReason} turns
 * an unrecognised one into {@link DELEGATION_REJECTED}, which is such a claim — so a body
 * that names a mined transaction under one of them is contradicting itself, and believing
 * the word answers "nobody was charged, pay again" while holding the evidence that
 * something went out. Only {@link MINED_REFUSAL_REASONS} settles the question with a hash
 * attached; anything else that names one is `unknown`, and the seller answers 504 with the
 * hash rather than re-issuing the offer. Our own facilitator cannot produce that shape
 * (`describeFailure` writes `""` on every rejection), which is the point: this is the rung
 * a third-party facilitator, or a post-broadcast word added on that side alone, arrives on.
 */
export function decideSettlement(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): SettlementOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unknown"};
    }
    const body = response.body as Erc7710SettleResponse;
    if (body.errorReason === RATE_LIMITED) return {kind: "unavailable", errorReason: RATE_LIMITED};
    if (body.errorReason === FACILITATOR_NOT_READY) {
        return {kind: "unavailable", errorReason: FACILITATOR_NOT_READY};
    }
    if (body.errorReason === SETTLEMENT_PENDING || body.errorReason === UNEXPECTED_SETTLE_ERROR) {
        return {kind: "unknown", transaction: readTransaction(body.transaction)};
    }
    if (body.success !== true) {
        const transaction = readTransaction(body.transaction);
        const errorReason = foldRefusalReason(body.errorReason);
        if (transaction !== undefined && !MINED_REFUSAL_REASONS.has(errorReason)) {
            return {kind: "unknown", transaction};
        }
        return {kind: "failed", errorReason, transaction};
    }
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
    return {kind: "settled", transaction: readTransaction(body.transaction), replayed: body.replayed === true};
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
