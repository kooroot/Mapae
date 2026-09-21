import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X402_VERSION,
    buildErc7710PaymentPayload,
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentHeader,
    redactForLog,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {
    DELEGATION_REJECTED,
    FACILITATOR_NOT_READY,
    INVALID_PAYLOAD,
    RATE_LIMITED,
    SETTLEMENT_PENDING,
    UNEXPECTED_SETTLE_ERROR,
    UNEXPECTED_VERIFY_ERROR,
} from "./facilitator-contract.js";
import {getAddress, isAddress, zeroAddress, type Address, type Hex} from "viem";

/**
 * The outermost layer of the four-stack settlement budget, and the single source for it.
 *
 * The stack must grow outward so the innermost hop is not the first to give up:
 *   facilitator receipt wait  <  seller→facilitator settle  <  seller idle timeout  <
 *   this client request timeout
 *
 * It was 15_000 here — shorter than the seller's own 45 s idle timeout — so any caller
 * omitting `timeoutMs` (the CLI delegated agent did) inverted the stack: the client hung
 * up while the facilitator was still waiting for a receipt, turning a settled payment into
 * a reported failure. The MCP server already used 50_000; this makes that the default so a
 * caller cannot silently inherit the inversion again.
 */
export const AGENT_REQUEST_TIMEOUT_MS = 50_000;
const DEFAULT_TIMEOUT_MS = AGENT_REQUEST_TIMEOUT_MS;

/**
 * Reason an autonomous delegated payment did not complete. Returned instead of
 * thrown so the MCP server (D5) surfaces a cause rather than dying silently.
 */
export type DelegatedPaymentFailureCode =
    | "NOT_PAYMENT_REQUIRED"
    | "UNSUPPORTED_X402_VERSION"
    | "SELLER_OFFER_INVALID"
    | "FACILITATOR_UNTRUSTED"
    | "MANAGER_MISMATCH"
    /** The on-chain period cap cannot cover this payment. */
    | "LIMIT_EXCEEDED"
    /**
     * 이 에이전트 런타임의 지출 정책이 거절했다 — 호출당 상한, 세션 누적 상한, 또는
     * 수취처 허용목록.
     *
     * `LIMIT_EXCEEDED`와 일부러 다른 코드다. 그것은 체인의 회계가 말하는 거절이라
     * 운영자를 체인으로 보내지만, 이것은 운영자 자신이 env에 적은 한도이고 체인에는
     * 아무 문제가 없다. 하나로 합치면 운영자가 정상인 기간 잔량을 들여다보게 된다.
     *
     * 허용목록 위반까지 이 코드에 담는 이유: 셋 모두 "운영자가 설정한 정책이 서명을
     * 막았다"는 같은 사실이고 대응도 같은 파일(`.env`)이다. `detail`이 어느 한도인지
     * 이름으로 말한다. 이름이 `..._EXCEEDED`가 아닌 것도 그래서다 — 허용목록 밖의
     * 수취처는 무엇을 초과한 것이 아니다.
     */
    | "SPEND_POLICY_REFUSED"
    /** The permission is revoked, expired, or not yet active. */
    | "PERMISSION_INACTIVE"
    /**
     * The permission context holds no delegations, so pre-flight read nothing.
     *
     * Deliberately not folded into `PERMISSION_INACTIVE`. That code sends an operator to
     * check revocation and expiry on chain, where they would find nothing wrong — the
     * fault is in the permission artifact, not in chain state.
     */
    | "PERMISSION_EMPTY"
    /** The leaf delegation could not be signed — e.g. the parent was revoked. */
    | "SIGNING_FAILED"
    | "PAYMENT_REJECTED"
    /**
     * The seller could not take the payment: its facilitator was unreachable, rate-limited
     * or not ready (`503 facilitator_unavailable`), or the seller itself throttled the call
     * (`429`). Nothing was examined and nothing was charged, so the same offer may be
     * retried later — unlike `PAYMENT_REJECTED`, whose "no" sends the caller to look at
     * the delegation, and unlike `SETTLEMENT_UNKNOWN`, whose money may have moved.
     */
    | "SELLER_UNAVAILABLE"
    /**
     * The payment header was delivered and the outcome is not known. **The payer may
     * already have been charged.**
     *
     * Separate from `PAYMENT_REJECTED` because the two demand opposite responses: a
     * rejection invites a retry, and retrying this one can pay twice. Measured on GIWA —
     * a settlement that outlived the seller's connection timeout was reported to the
     * caller as `PAYMENT_REJECTED` while the transfer had already been mined
     * (`0x533c5cb2…9964c`, block 31634935). Nothing about the reported code told the
     * caller that 1.00 mUSDC had moved. The 403 the seller answered it with that day is
     * gone from the ladder — an unsettled payment is 504 `settlement_unknown` now, and a
     * refused one a 402 that re-issues the offer — but the reading below is what keeps the
     * loss from returning under some other status.
     */
    | "SETTLEMENT_UNKNOWN"
    | "MALFORMED_RESOURCE"
    | "TRANSPORT_ERROR";

/**
 * Statuses that mean "the seller could not establish what happened", not "no".
 *
 * `504` is what `apps/delegated-seller` returns when its facilitator call does not answer
 * — it already draws this distinction correctly on its own side ("Did not succeed and is
 * not known to have succeeded are different claims"). The loss happened here, where every
 * non-2xx collapsed into one code. `408` and `425` are included because a gateway in front
 * of a seller produces them for the same reason.
 *
 * This set is the floor, not a fallback. A seller that names its reason in
 * `Payment-Response` is believed over its status where that adds caution — the status is
 * also whatever the proxies in between made of it — but never against this set: the
 * incident above arrived as a status, and a word that talked the caller out of it would
 * undo the reading it bought. See {@link SELLER_REFUSAL_CODES}.
 */
const SETTLEMENT_UNKNOWN_STATUSES = new Set([
    408, 425, 504,
    // Reverse-proxy origin-death codes. seller.mapae.io sits behind a Cloudflare Tunnel,
    // which answers 502 (upstream died mid-exchange) and 520-524 (origin error / origin
    // timeout / connection failures) when the seller or the connector drops after the
    // request was forwarded. This set is only consulted on the retry, once the payment
    // header is already on the wire, so under this ambiguity the safe reading is "may be
    // charged" — the cheap mistake is a manual check, the expensive one a double payment.
    502, 520, 521, 522, 523, 524,
]);

/**
 * Statuses that mean "the seller could not take the payment", not "no" and not "lost".
 *
 * `503` is `@mapae/seller`'s `facilitator_unavailable` rung: `/supported` or `/verify` out
 * of reach, or the facilitator refusing to look at the payment — its rate limit, or a
 * readiness probe it failed — on either call. `429` is a seller (or the edge in front of
 * it) throttling the call before any of that. In every case the payment reached no
 * verdict and no chain, so the same offer is safe to retry later; reporting it as a
 * rejection sent the caller to inspect a delegation nothing had refused.
 */
const SELLER_UNAVAILABLE_STATUSES = new Set([429, 503]);

/**
 * The words a seller may classify its own refusal with, and what each one means here.
 *
 * A failing retry used to be read from its status alone, and the status is the coarsest
 * thing about the answer: `@mapae/seller` answers a refused delegation and a settlement
 * that charged nobody with the same 402, and a proxy can rewrite any of them. The x402 v2
 * `SettleResponse` in `Payment-Response` says which it was, so it is read first.
 *
 * Closed on purpose, and small on purpose. Every key is either a constant of this
 * repository's own wire or one of §9's fixed words; a word outside the map changes
 * nothing and the status rules decide, because the safe reading of a word we do not know
 * is no reading at all. In particular `vendor_not_credited` and `settlement_reverted` are
 * deliberately absent: they are the two words a mined failure wears, the seller answers
 * them 502 and 402 respectively with the hash in the receipt, and the hash is what this end
 * reads — admitting either as a §9-shaped refusal would let the word say "nothing
 * happened, pay again" over its own evidence.
 *
 * What a word may do is bounded on purpose: it can make this end *more* careful than the
 * status, never less. See the classification in {@link payForDelegatedResource}.
 */
const X402_REFUSAL_WORDS = [
    "insufficient_funds",
    "invalid_scheme",
    "unsupported_scheme",
    "invalid_network",
    INVALID_PAYLOAD,
    "invalid_payment_requirements",
    "invalid_x402_version",
    "invalid_transaction_state",
] as const;

/** The three codes a seller's own word can select. Narrowed so the notes below are total. */
type SellerRefusalCode = Extract<
    DelegatedPaymentFailureCode,
    "SETTLEMENT_UNKNOWN" | "SELLER_UNAVAILABLE" | "PAYMENT_REJECTED"
>;

const SELLER_REFUSAL_CODES: ReadonlyMap<string, SellerRefusalCode> = new Map<string, SellerRefusalCode>([
    // Money may have moved, whatever status carried the word. The seller sends it with a
    // 504; a gateway that rewrote that must not cost the caller this reading.
    [SETTLEMENT_PENDING, "SETTLEMENT_UNKNOWN"],
    // §9's "an unexpected error occurred while settling" — a failure whose place in the
    // sequence the sender did not claim to know. `@mapae/seller` raises it only before the
    // broadcast and answers 504, but it is read from the word rather than from that, because
    // any other seller using §9's vocabulary has not promised as much.
    [UNEXPECTED_SETTLE_ERROR, "SETTLEMENT_UNKNOWN"],
    // Nothing was examined and nothing was charged: the same payment is safe to present
    // again later. `/verify` never broadcasts, so its unexpected error belongs here rather
    // than with the verdicts — the seller's own ladder reads it the same way.
    [RATE_LIMITED, "SELLER_UNAVAILABLE"],
    [FACILITATOR_NOT_READY, "SELLER_UNAVAILABLE"],
    [UNEXPECTED_VERIFY_ERROR, "SELLER_UNAVAILABLE"],
    // A verdict on the payment, formed before anything was broadcast.
    [DELEGATION_REJECTED, "PAYMENT_REJECTED"],
    ...X402_REFUSAL_WORDS.map((word): [string, SellerRefusalCode] => [word, "PAYMENT_REJECTED"]),
]);

/** What each of those codes means to whoever reads the reason. Our sentences, not the seller's. */
const REFUSAL_NOTE: Record<SellerRefusalCode, string> = {
    SETTLEMENT_UNKNOWN: "the payer may already be charged",
    SELLER_UNAVAILABLE: "nothing charged, retry later",
    PAYMENT_REJECTED: "no settlement was attempted",
};

/** Signs a payment-specific leaf delegation for a seller's ERC-7710 offer. */
export type DelegatedLeafProvider = (
    requirements: Erc7710PaymentRequirements,
) => Promise<{delegationManager: Address; permissionContext: Hex; delegator: Address}>;

/** Verdict from an optional check made before any payment is attempted. */
export type PreflightVerdict =
    | {ok: true}
    | {
          ok: false;
          code:
              | "LIMIT_EXCEEDED"
              | "PERMISSION_INACTIVE"
              | "PERMISSION_EMPTY"
              | "SPEND_POLICY_REFUSED";
          detail: string;
      };

export interface DelegatedPaymentConfig {
    provider: DelegatedLeafProvider;
    /** Expected DelegationManager from the verified deployment. */
    delegationManager: Address;
    /** Facilitator redeemer addresses this agent already trusts. */
    trustedFacilitators: Address[];
    /**
     * Optional check run before signing, against the enforcer's own accounting and
     * against whatever spending policy the agent's operator configured.
     *
     * The cap is enforced on-chain either way; this exists so an agent that cannot
     * afford the payment says so — `LIMIT_EXCEEDED` — instead of walking into a
     * seller's generic rejection and reporting a status code. Kept as a callback so
     * the payment core itself stays chain-independent and unit-testable.
     *
     * It receives the whole selected offer rather than its amount. A policy that has
     * anything to say about *who* is being paid — a recipient allowlist — cannot be
     * asked with a `bigint`, and a judgement that cannot be asked before signing is one
     * that arrives after the leaf is already a bearer authorization.
     */
    preflight?: (requirements: Erc7710PaymentRequirements) => Promise<PreflightVerdict>;
    /** Injectable for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

export type DelegatedPaymentResult =
    | {
          ok: true;
          amount: string;
          payTo: Address;
          transaction?: Hex;
          /**
           * The media type the seller labelled the resource with — `application/json`,
           * `text/plain` — when it sent one. Parameters are dropped and the bearer
           * values redacted, so this carries no seller prose.
           */
          contentType?: string;
          /** Parsed when the content type is JSON, the body text otherwise. */
          resource: unknown;
      }
    | {ok: false; code: DelegatedPaymentFailureCode; status?: number; detail: string};

/**
 * The rail this agent pays on: exact scheme, GIWA, ERC-7710 transfer. An offer past
 * this gate is one the seller meant for a delegated agent, whatever else is wrong with
 * it; one that fails it was meant for some other payer.
 */
function isExactErc7710OnGiwa(value: unknown): value is Erc7710PaymentRequirements {
    const req = value as Partial<Erc7710PaymentRequirements> | null | undefined;
    return (
        typeof req === "object" &&
        req !== null &&
        req.scheme === "exact" &&
        req.network === GIWA_SEPOLIA_CAIP2 &&
        req.extra?.assetTransferMethod === "erc7710"
    );
}

/**
 * Assert a seller's ERC-7710 offer is exactly what this agent is willing to pay.
 * Anything off — wrong scheme, network, asset, malformed amount, unsafe timeout, a
 * payment flow this rail cannot pay — throws, and the caller maps it to
 * `SELLER_OFFER_INVALID`.
 */
export function assertErc7710Offer(value: unknown): Erc7710PaymentRequirements {
    if (!isExactErc7710OnGiwa(value)) {
        throw new Error("seller did not offer exact ERC-7710 on GIWA");
    }
    const req = value;
    if (!isAddress(req.asset) || getAddress(req.asset) !== MOCK_USDC.address) {
        // Never interpolate the raw attacker-controlled value: this message becomes the
        // MCP tool `detail` returned to the driving agent, the one failure channel the
        // design otherwise keeps free of seller-supplied strings. A checksummed address
        // is the only safe form; a non-address is named without echoing it.
        throw new Error(
            isAddress(req.asset) ? `unexpected asset ${getAddress(req.asset)}` : "seller asset is not an address",
        );
    }
    if (!isAddress(req.payTo)) throw new Error("seller payTo is malformed");
    // The v1 EIP-3009 agent rejects the zero address explicitly; the ERC-7710 path must
    // too, or a leaf is signed for transfer(0x0, amount) that no enforcer refuses and
    // that OZ ERC20 would burn — an unsettleable bearer authorization minted for nothing.
    if (getAddress(req.payTo) === zeroAddress) throw new Error("seller payTo is the zero address");
    if (!/^[1-9]\d*$/.test(req.amount)) throw new Error("seller amount is malformed");
    // 스펙 §6.1의 결제 흐름 선언. 우리가 결제할 수 있는 흐름은 두 개다 — 이 레일의
    // `upfront`와 스펙 기본값 `authorization` — 이고, 선언의 부재와 `null`은 그 기본값을
    // 뜻한다(참조 구현 `@x402/core` 2.20.0의 스키마는 선택 칸의 null을 `.nullish()`로
    // 부재와 같이 접는다).
    //
    // `authorization`을 부재와 똑같이 통과시키는 이유: 그 흐름은 판매자가 먼저 자원을
    // 주고 나중에 정산하는 것이라 정산 위험을 판매자가 스스로 진다. 우리 에이전트가
    // 서명하는 일회용 leaf의 손실 가능성(금액·만료·redeemer)은 어느 쪽에서도 같으므로
    // 거절할 근거가 없다. 부재만 허용하고 명시를 거절한다면 판정 기준이 흐름이 아니라
    // "필드를 적었는지"가 되어, 같은 흐름을 성실히 선언한 판매자만 죽는다 — 그리고
    // 이 키를 아는 참조 구현이 아직 없으니(`@x402/core` 2.20.0·`@metamask/x402` 0.2.0
    // 어디에도 `paymentFlow` 문자열이 없다) 값을 싣는 쪽은 스펙을 직접 읽고 쓴
    // 카운터파티다. 부재가 흔한 것도 측정된 사실이다: `@metamask/x402` 0.2.0의
    // supportedKind 흐름은 우리 /supported의 `extra`에서 `facilitatorAddresses`만
    // 복사하므로, 그 경로로 만들어진 제3자 오퍼에는 선언이 아예 없다
    // (x402-conformance.test.ts가 고정한 측정값).
    //
    // 반면 `escrow`는 나중 청구라는 다른 흐름이고, 이 함수가 돌려주는 결과 유니온이
    // 그 사후 정산을 설명하지 못한다. 알 수 없는 값도 같은 이유로 거절한다.
    //
    // 타입은 좁지만 값은 아직 검증되지 않은 판매자 JSON이므로 `unknown`으로 읽는다.
    const declaredFlow: unknown = req.extra.paymentFlow;
    if (declaredFlow != null && declaredFlow !== "upfront" && declaredFlow !== "authorization") {
        // 판매자가 준 문자열을 메시지에 넣지 않는 이 파일의 규칙을 지킨다.
        throw new Error("seller declares an unsupported payment flow");
    }
    if (
        !Number.isInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds < 1 ||
        req.maxTimeoutSeconds > 300
    ) {
        throw new Error("seller timeout is unsafe");
    }
    // Validated here rather than at the comparison below: the field is attacker-
    // controlled JSON, and a bare string would make `.some` throw straight out of
    // a function whose whole contract is to return a reason instead of throwing.
    const facilitators = req.extra.facilitatorAddresses;
    if (facilitators != null && !Array.isArray(facilitators)) {
        throw new Error("seller facilitatorAddresses is not a list");
    }
    // Same reasoning: attacker-controlled JSON, and the comparison downstream calls
    // `getAddress`, which throws on garbage out of a function contracted to refuse.
    const advertisedManager = req.extra.delegationManager;
    if (advertisedManager != null && !isAddress(advertisedManager)) {
        throw new Error("seller delegationManager is malformed");
    }
    return req;
}

function failure(
    code: DelegatedPaymentFailureCode,
    detail: string,
    status?: number,
): DelegatedPaymentResult {
    return {ok: false, code, detail, status};
}

/**
 * Every failure `detail` this module produces passes through here, so this is the one
 * place the RPC credential has to be stopped.
 *
 * `detail` is not internal: it is re-thrown to stderr by `apps/delegated-agent`, returned
 * as MCP tool output by `apps/agent-mcp` (i.e. to whatever agent is driving), and printed
 * by the e2e runner. The preflight closure reads over `throttledHttp(rpcUrl)`, and viem
 * embeds the full transport URL in its error messages — `getUrl` strips only userinfo, so
 * a provider key in the path survives untouched.
 *
 * This file already scrubs the *other* secret class carefully (`redactBearerSecrets`);
 * the RPC endpoint was the gap.
 */
function errorMessage(error: unknown): string {
    return redactForLog(error);
}

export const BEARER_REDACTION = "[redacted: bearer payment authorization]";

/**
 * Replace the bearer values we sent wherever they appear in a seller's response.
 *
 * Serialising and splitting on the literal reaches any nesting depth, which a
 * hand-written walker would not, and both secrets are long opaque hex/base64
 * strings so a substring match cannot collide with real content.
 *
 * Hex secrets (the permission context) are matched case-insensitively and with the `0x`
 * prefix optional: EVM hex has no canonical case, so a seller echoing the same bytes
 * uppercased or `0x`-stripped is the same authorization and an exact split would miss it.
 * The base64 payment header is matched exactly — base64 is case-significant, so a
 * case-flip is a different string, not the same secret.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactBearerSecrets<T>(value: T, secrets: string[]): T {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return value;
    let cleaned = serialized;
    for (const secret of secrets) {
        if (secret.length < 32) continue;
        const hexBody = /^0x[0-9a-fA-F]+$/.test(secret) ? secret.slice(2) : undefined;
        if (hexBody && hexBody.length >= 32) {
            cleaned = cleaned.replace(
                new RegExp(`(?:0x)?${escapeRegExp(hexBody)}`, "gi"),
                BEARER_REDACTION,
            );
        } else {
            cleaned = cleaned.split(secret).join(BEARER_REDACTION);
        }
    }
    // Replacing secrets inside a JSON document leaves its shape untouched — a string
    // stays a string, an object keeps its keys — so the round-trip preserves `T`.
    return cleaned === serialized ? value : (JSON.parse(cleaned) as T);
}

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/** The hash a seller's own body names — the receipt the hosted shop's ticket carries. */
function extractTransaction(resource: unknown): Hex | undefined {
    if (resource && typeof resource === "object" && "receipt" in resource) {
        const tx = (resource as {receipt?: {transaction?: unknown}}).receipt?.transaction;
        if (typeof tx === "string" && TRANSACTION_HASH.test(tx)) return tx as Hex;
    }
    return undefined;
}

type OfferSelection =
    | {ok: true; accepted: Erc7710PaymentRequirements}
    | {
          ok: false;
          code: "SELLER_OFFER_INVALID" | "FACILITATOR_UNTRUSTED" | "MANAGER_MISMATCH";
          detail: string;
      };

/**
 * One candidate from `accepts`, judged the way a single offer always was: shape, then
 * facilitator overlap, then the advertised manager.
 */
function judgeOffer(
    candidate: unknown,
    config: Pick<DelegatedPaymentConfig, "trustedFacilitators" | "delegationManager">,
): OfferSelection {
    let accepted: Erc7710PaymentRequirements;
    try {
        accepted = assertErc7710Offer(candidate);
    } catch (error) {
        return {ok: false, code: "SELLER_OFFER_INVALID", detail: errorMessage(error)};
    }

    const advertised = accepted.extra.facilitatorAddresses ?? [];
    const overlaps = config.trustedFacilitators.some((trusted) =>
        advertised.some(
            (facilitator) =>
                typeof facilitator === "string" &&
                isAddress(facilitator) &&
                getAddress(facilitator) === trusted,
        ),
    );
    if (!overlaps) {
        return {
            ok: false,
            code: "FACILITATOR_UNTRUSTED",
            detail: "seller and trusted facilitator signer lists do not overlap",
        };
    }

    // The in-band manager advertisement is advisory — settlement authority stays with
    // the manager in the signed payload — but when it is present and disagrees with the
    // deployment this agent verified, every leaf we could sign is one the facilitator
    // must reject. Refuse before signing: a leaf that cannot settle is still a bearer
    // authorization, and the code should name the fault line, not a downstream symptom.
    const advertisedManager = accepted.extra.delegationManager;
    if (
        advertisedManager !== undefined &&
        getAddress(advertisedManager) !== getAddress(config.delegationManager)
    ) {
        return {
            ok: false,
            code: "MANAGER_MISMATCH",
            detail: "seller advertises a different DelegationManager than the verified deployment",
        };
    }
    return {ok: true, accepted};
}

/**
 * The first offer in `accepts` this agent can pay, in the seller's order — the spec's
 * rule (the client selects, from `accepts`, the requirements it supports), and what
 * lets a seller list EIP-3009 first for wallets and ERC-7710 second for delegated
 * agents without losing either payer.
 *
 * When nothing qualifies, the reason reported is the first candidate's that was on the
 * ERC-7710 rail at all: that is the offer the seller meant for this agent, so its fault
 * is the actionable one — an untrusted facilitator, a foreign manager, a malformed
 * field. A list with no such candidate is a seller that does not offer this rail.
 */
function selectOffer(
    accepts: unknown,
    config: Pick<DelegatedPaymentConfig, "trustedFacilitators" | "delegationManager">,
): OfferSelection {
    if (!Array.isArray(accepts) || accepts.length === 0) {
        return {ok: false, code: "SELLER_OFFER_INVALID", detail: "402 body has no accepts"};
    }
    let onRail: OfferSelection | undefined;
    for (const candidate of accepts) {
        const verdict = judgeOffer(candidate, config);
        if (verdict.ok) return verdict;
        if (onRail === undefined && isExactErc7710OnGiwa(candidate)) onRail = verdict;
    }
    return (
        onRail ?? {
            ok: false,
            code: "SELLER_OFFER_INVALID",
            detail: `no exact ERC-7710 offer on GIWA among ${accepts.length} accepts`,
        }
    );
}

/**
 * The media type a `Content-Type` names, without its parameters.
 *
 * Dropping the parameters is what keeps the header out of the result as a free-text
 * channel: `charset=utf-8` tells the caller nothing `second.text()` has not already
 * applied, and anything else a seller writes there is its own prose.
 */
function mediaType(contentType: string): string {
    return contentType.split(";")[0]!.trim().toLowerCase();
}

/** `application/json` and every `+json` structured syntax (`application/problem+json`, `…/ld+json`). */
function isJsonMediaType(type: string): boolean {
    return type === "application/json" || type.endsWith("+json");
}

/**
 * The settlement receipt in `Payment-Response`, when it is a receipt *of this payment*:
 * `success: true`, this network, and the payer the leaf was signed for. `transaction`
 * is the hash it names, or absent when the receipt names none (`""`, as the spec
 * writes it, or omitted).
 *
 * Anything else — no header, undecodable, `success: false`, another network or
 * payer, a transaction that is not a hash — is `undefined`, and the caller falls back
 * to the body. Deliberately not a failure: the seller served the resource with a 2xx,
 * so the payment went through and the resource is what the caller paid for; a header
 * that contradicts that is the seller disagreeing with itself, and a paid resource is
 * not thrown away over a diagnostic header. The header's own strings (`errorReason`
 * and the like) are seller-controlled and never reach the result.
 */
function readSettlementReceipt(
    header: string | null,
    delegator: Address,
): {transaction?: Hex} | undefined {
    if (header === null) return undefined;
    let decoded: unknown;
    try {
        decoded = decodePaymentResponseHeader(header);
    } catch {
        return undefined;
    }
    const receipt = decoded as
        | {success?: unknown; network?: unknown; payer?: unknown; transaction?: unknown}
        | null;
    if (
        receipt === null ||
        typeof receipt !== "object" ||
        receipt.success !== true ||
        receipt.network !== GIWA_SEPOLIA_CAIP2 ||
        typeof receipt.payer !== "string" ||
        !isAddress(receipt.payer) ||
        getAddress(receipt.payer) !== getAddress(delegator)
    ) {
        return undefined;
    }
    const transaction = receipt.transaction ?? "";
    if (transaction === "") return {};
    if (typeof transaction !== "string" || !TRANSACTION_HASH.test(transaction)) return undefined;
    return {transaction: transaction as Hex};
}

/** What a failing answer's `Payment-Response` declared about itself, of what we read of it. */
interface DeclaredRefusal {
    /** Our code for the word it used, when the word is one of {@link SELLER_REFUSAL_CODES}. */
    code?: SellerRefusalCode;
    /** That word itself. Repeatable in a `detail` because matching it made it ours. */
    reason?: string;
    /**
     * The hash it named.
     *
     * Evidence that something was broadcast, whatever the word claims: a failure receipt
     * naming a mined transaction is a payment in doubt even when its word asserts a verdict
     * formed before any broadcast, and this end cannot read the chain to settle which. The
     * seller puts it there for exactly that reason — it is the caller's only way to find out
     * for themselves whether they were charged — so it must not stop here.
     */
    transaction?: Hex;
}

/**
 * How the seller described its own failure, of the two fields we read.
 *
 * Only the header is read, never the body: a malicious seller can reflect
 * `Payment-Signature` back after we have sent a bearer permission context, and that rule
 * does not relax because the answer looks helpful. Of the header, only `errorReason` and
 * `transaction` are looked at — the word matched against our own constants, the hash
 * against a hex pattern — so everything that reaches the result is a word of ours or a
 * hash, and `errorMessage` or anything else the seller wrote goes nowhere.
 */
function readSellerRefusal(header: string | null): DeclaredRefusal {
    if (header === null) return {};
    let decoded: unknown;
    try {
        decoded = decodePaymentResponseHeader(header);
    } catch {
        return {};
    }
    const receipt = decoded as {errorReason?: unknown; transaction?: unknown} | null;
    const reason: unknown = receipt?.errorReason;
    const code = typeof reason === "string" ? SELLER_REFUSAL_CODES.get(reason) : undefined;
    const transaction: unknown = receipt?.transaction;
    return {
        ...(code === undefined ? {} : {code, reason: reason as string}),
        ...(typeof transaction === "string" && TRANSACTION_HASH.test(transaction)
            ? {transaction: transaction as Hex}
            : {}),
    };
}

/**
 * Autonomous ERC-7710 payment: GET → 402 → sign a payment-specific leaf → retry
 * with `Payment-Signature` → resource. This is the reusable core shared by the CLI
 * agent and the D5 MCP server; the caller owns env/file loading, deployment
 * verification, and provider construction.
 *
 * Security invariants (preserved from the CLI agent):
 * - On a failed retry the seller's body is neither read nor returned. A malicious
 *   seller can reflect `Payment-Signature` back after we send a bearer permission
 *   context.
 * - The signed permission context and signature are never put into the result by
 *   this function, and are stripped from everything the seller's 2xx contributes to
 *   it — the body and the content type alike — if it echoes them.
 * - Only a 2xx retry yields the resource body.
 */
export async function payForDelegatedResource(
    target: URL,
    config: DelegatedPaymentConfig,
): Promise<DelegatedPaymentResult> {
    const doFetch = config.fetchImpl ?? fetch;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let first: Response;
    try {
        first = await doFetch(target, {
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        return failure("TRANSPORT_ERROR", errorMessage(error));
    }
    if (first.status !== 402) {
        return failure(
            "NOT_PAYMENT_REQUIRED",
            `expected 402, received ${first.status}`,
            first.status,
        );
    }

    // v2 transport carries the offer in the Payment-Required header and may leave the
    // body empty; a JSON body alone is how this repo's own seller shipped first. Header
    // first, body as fallback — including when a header is present but unusable, which
    // mirrors the reference client (`x402-reqwest`) rather than failing a payment the
    // body can still carry.
    let body: PaymentRequired<Erc7710PaymentRequirements> | undefined;
    const offerHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
    if (offerHeader !== null) {
        try {
            body = decodePaymentRequiredHeader(
                offerHeader,
            ) as PaymentRequired<Erc7710PaymentRequirements>;
        } catch {
            body = undefined;
        }
    }
    if (body === undefined) {
        try {
            body = (await first.json()) as PaymentRequired<Erc7710PaymentRequirements>;
        } catch (error) {
            return failure(
                "SELLER_OFFER_INVALID",
                `402 offer is neither a Payment-Required header nor a JSON body: ${errorMessage(error)}`,
            );
        }
    }
    // `null` parses as valid JSON, so the try above does not catch it — and `typeof null`
    // is "object", so a plain typeof check would not either. A seller answering 402 with
    // a literal `null` body reached the version check and threw a TypeError out of a
    // function whose whole contract is to return a reason.
    if (body === null || typeof body !== "object") {
        return failure("SELLER_OFFER_INVALID", "402 body is not an object");
    }
    if (body.x402Version !== X402_VERSION) {
        return failure("UNSUPPORTED_X402_VERSION", `unsupported x402 version ${body.x402Version}`);
    }

    const selected = selectOffer(body.accepts, config);
    if (!selected.ok) return failure(selected.code, selected.detail);
    const {accepted} = selected;

    if (config.preflight) {
        let verdict: PreflightVerdict;
        try {
            verdict = await config.preflight(accepted);
        } catch (error) {
            return failure("TRANSPORT_ERROR", `preflight read failed: ${errorMessage(error)}`);
        }
        // Stop before signing: a leaf that cannot settle is still a bearer
        // authorization, and there is no reason to mint one.
        if (!verdict.ok) return failure(verdict.code, verdict.detail);
    }

    let leaf: Awaited<ReturnType<DelegatedLeafProvider>>;
    try {
        leaf = await config.provider(accepted);
    } catch (error) {
        // Not a transport problem: the agent reached everything it needed and the
        // delegation itself could not be produced. Collapsing this into
        // TRANSPORT_ERROR sends whoever reads the reason looking at the network.
        return failure("SIGNING_FAILED", `leaf signing failed: ${errorMessage(error)}`);
    }
    // `getAddress` throws on anything that is not an address, so checking the shape first
    // is what lets a malformed provider be reported rather than raised. A provider that
    // returns garbage is the same class of problem as one returning the wrong manager —
    // the leaf cannot be trusted — and both belong under one code the caller can act on.
    if (
        !isAddress(leaf.delegationManager) ||
        !isAddress(leaf.delegator) ||
        getAddress(leaf.delegationManager) !== getAddress(config.delegationManager)
    ) {
        return failure("MANAGER_MISMATCH", "provider returned an unexpected DelegationManager");
    }

    const payload = buildErc7710PaymentPayload({
        accepted,
        delegationManager: getAddress(leaf.delegationManager),
        permissionContext: leaf.permissionContext,
        delegator: getAddress(leaf.delegator),
    });

    const paymentHeader = encodePaymentHeader(payload);

    // One submission header, whichever way the offer arrived. An ERC-7710 payload
    // carries a full permission context, and the same value under a second header name
    // crossed the HTTP server's total-header limit: the seller answered 431 before its
    // own size check ran (measured on the fork e2e).
    let second: Response;
    try {
        second = await doFetch(target, {
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader},
        });
    } catch (error) {
        // The header is already on the wire. A connection that dies now says nothing
        // about whether the seller settled — reporting TRANSPORT_ERROR here would read
        // as "the request never landed", which is exactly the belief that makes a caller
        // retry a payment that already went through. The identical failure *before* the
        // header is sent is a genuine TRANSPORT_ERROR; the difference is the header.
        return failure("SETTLEMENT_UNKNOWN", `no answer after the payment was sent: ${errorMessage(error)}`);
    }
    if (!second.ok) {
        // Do not read the body: a malicious seller can reflect Payment-Signature after
        // we have sent a bearer permission context. The `Payment-Response` header is read
        // — two fields of it, a word matched against our own vocabulary and a hash — because
        // a seller that says which failure this was knows more than its status code does:
        // the same 402 covers a refused delegation and a settlement that charged nobody, and
        // any status is also whatever the proxies in between made of it.
        const refusal = readSellerRefusal(second.headers.get(PAYMENT_RESPONSE_HEADER));
        const byStatus: SellerRefusalCode = SETTLEMENT_UNKNOWN_STATUSES.has(second.status)
            ? "SETTLEMENT_UNKNOWN"
            : SELLER_UNAVAILABLE_STATUSES.has(second.status)
              ? "SELLER_UNAVAILABLE"
              : "PAYMENT_REJECTED";
        // What the answer says about itself may make this end more careful than its status
        // did; it may never make it less. A 504 and the origin-death codes beside it are the
        // reading that exists because of GIWA tx `0x533c5cb2…9964c` (see
        // `SETTLEMENT_UNKNOWN_STATUSES`), and no word overrides them — `unexpected_settle_error`
        // on a 504 is still a settlement in doubt, whatever the seller meant by it. A named
        // hash is the same rule read off the receipt rather than the status: something was
        // broadcast, so the answer is not "nothing happened, pay again" even when the word
        // says so. Upward it does move: `settlement_pending` on a 402 is a doubt the status
        // never carried.
        const code: SellerRefusalCode =
            byStatus === "SETTLEMENT_UNKNOWN" || refusal.transaction !== undefined
                ? "SETTLEMENT_UNKNOWN"
                : (refusal.code ?? byStatus);
        const what =
            refusal.reason !== undefined
                ? `seller reported ${refusal.reason} (${second.status})`
                : code === "SETTLEMENT_UNKNOWN"
                  ? `seller could not confirm settlement (${second.status})`
                  : code === "SELLER_UNAVAILABLE"
                    ? `seller could not take the payment (${second.status})`
                    : `seller rejected the payment (${second.status})`;
        // The hash is matched against a hex pattern before it gets here, so it is a hash and
        // not seller prose — and it is the one thing the caller can take to an explorer.
        const found = refusal.transaction === undefined ? "" : ` — transaction ${refusal.transaction}`;
        return failure(code, `${what} — ${REFUSAL_NOTE[code]}${found}`, second.status);
    }

    // A paid resource is whatever the seller serves — a ticket as JSON, a report as
    // text, a document as markdown. Only a body the seller labels JSON is parsed;
    // anything else comes back as the text it is, and either way it passes the
    // redaction below.
    //
    // `Content-Type` is seller-controlled text like the body, and it reaches the caller,
    // so it gets the same treatment: the bearer values are stripped first, then only the
    // media type is kept. Without both a seller could park an authorization in a
    // `Content-Type` parameter and have it land in MCP tool output.
    const secrets = [leaf.permissionContext, paymentHeader];
    const declared = second.headers.get("content-type");
    const contentType =
        declared === null ? undefined : mediaType(redactBearerSecrets(declared, secrets));
    let resource: unknown;
    try {
        resource =
            contentType !== undefined && isJsonMediaType(contentType)
                ? await second.json()
                : await second.text();
    } catch (error) {
        return failure("MALFORMED_RESOURCE", `resource could not be read: ${errorMessage(error)}`);
    }
    // The payment succeeded, so this body is what the caller paid for and has to
    // come back. It is still seller-controlled text that lands in MCP tool output
    // and agent transcripts, and a seller that echoes `Payment-Signature` — or the raw
    // permission context — would park a bearer authorization there. We know the
    // exact values, so strip them instead of trusting the seller not to send them.
    resource = redactBearerSecrets(resource, secrets);
    const receipt = readSettlementReceipt(
        second.headers.get(PAYMENT_RESPONSE_HEADER),
        payload.payload.delegator,
    );
    return {
        ok: true,
        amount: accepted.amount,
        payTo: getAddress(accepted.payTo),
        transaction: receipt ? receipt.transaction : extractTransaction(resource),
        ...(contentType === undefined ? {} : {contentType}),
        resource,
    };
}
