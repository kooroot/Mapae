import type {Context, MiddlewareHandler} from "hono";
import {matchedRoutes} from "hono/route";
import type {RouterRoute} from "hono/types";
import {COMPOSED_HANDLER} from "hono/utils/constants";
import type {Address, Hex} from "viem";
import {getAddress, isAddress, isHex, sha256, stringToBytes, zeroAddress} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    PAYMENT_IDENTIFIER_EXTENSION,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X402_VERSION,
    buildErc7710PaymentRequirements,
    buildPaymentIdentifierOffer,
    decodePaymentHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
    fromTokenAmount,
    isLoopbackHost,
    readPaymentIdentifier,
    redactForLog,
    toTokenAmount,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type Erc7710SupportedPayload,
    type PaymentExtension,
    type PaymentRequired,
    type SettleResponse,
} from "@mapae/shared";
import {
    CLIENT_IP_HEADER,
    FACILITATOR_NOT_READY,
    INVALID_PAYLOAD,
    PAYMENT_IDENTIFIER_CONFLICT,
    SETTLEMENT_PENDING,
    VENDOR_NOT_CREDITED,
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
    /**
     * True when the facilitator answered out of its own record of this intent rather than
     * performing the settlement in this call — an earlier attempt's outcome, or a
     * concurrent call's, replayed onto this answer.
     *
     * **Not a delivery gate.** When a first attempt ends `settlement_pending` and a later
     * call finishes the claim, every successful answer for that intent is marked, so a
     * seller that refuses to ship a replay would refuse the sale it was paid for. Dedupe
     * on {@link SettlementReceipt.intent} instead — one row per intent, written where the
     * order is (the hosted shop's `orders` table does exactly this) — and read this field
     * as what it says: some other call did the work.
     */
    replayed: boolean;
}

/**
 * 왜 같은 id에 다른 결제가 오면 거절하는지 — {@link PaymentIdentifierBinding}이 답하는 것.
 *
 * `fingerprint`는 사양 "Request Binding"이 열거한 항목을 정규화해 접은 값이고,
 * `paymentIntentId`는 서명에서 파생된 이 결제의 고유 키다. 둘 다 비교하는 이유가 다르다:
 *
 * - 지문이 다르면 클라이언트가 같은 멱등성 키로 **다른 요청**을 했다. 사양이 409를 요구하는
 *   바로 그 경우다 — 캐시된 결과를 주면 사지 않은 것을 배송하는 것이고, 새로 정산하면 그
 *   id에 두 개의 결제가 생긴다.
 * - 지문이 같아도 intent가 다르면 **다른 leaf**다. 같은 상품을 같은 가격에 사려는 새 서명이고,
 *   앞선 시도의 정산 결과를 모르는 채 이것을 정산하면 두 번 청구된다. 첫 시도가
 *   `settlement_pending`으로 끝났을 때 정확히 이 모습이 온다 — 그 결제는 청구됐을 수 있고,
 *   그 사실을 아는 유일한 방법은 앞선 intent를 다시 물어보는 것이다. 그래서 이것도 conflict다.
 */
export type PaymentIdentifierConflict = "fingerprint" | "payment_intent";

/** 한 결제 식별자에 남은 정산 결과 — 저장된 영수증을 다시 세울 만큼만. */
export interface RecordedPayment {
    /** 퍼실리테이터가 확인한 지불자. 이 호출이 주장한 delegator가 아니다. */
    payer: Address;
    transaction?: Hex;
}

export type PaymentIdentifierBindResult =
    | {kind: "new"}
    | {kind: "settled"; settled: RecordedPayment}
    | {kind: "conflict"; reason: PaymentIdentifierConflict};

/**
 * 내구성 있는 (결제 식별자 → 결제) 바인딩. 주면 `payment-identifier` 확장이 살아난다.
 *
 * 프로세스 기억이 아니라 디스크여야 한다. 재시작으로 사라지는 가드는 가드가 아니고, 이
 * 바인딩이 막는 사고는 바로 재시작·타임아웃 뒤에 일어난다 — 첫 답을 못 받은 구매자가 다시
 * 내는 순간이다. `apps/delegated-seller`가 `@mapae/store`의 `payment_identifiers` 테이블로
 * 이것을 구현한다.
 *
 * 두 메서드는 한 결제의 앞과 뒤다. `bind`는 정산 **전에** 불려 그 id를 이 결제에
 * 못박고(그래서 동시에 도착한 다른 leaf가 곧바로 conflict가 된다), `record`는 정산이
 * 성공한 **뒤에** 결과를 그 행에 남긴다. 실패·미결에서는 기록하지 않는다: 그 id는 아직
 * 결과가 없고, 같은 헤더를 다시 제시하면 퍼실리테이터의 저널이 답한다.
 */
export interface PaymentIdentifierBinding {
    /**
     * 이 id를 이 결제에 묶는다.
     *
     * - `new` — 처음 보는 id이거나, 같은 결제인데 아직 결과가 없다. 지금 경로대로 정산한다.
     * - `settled` — 같은 결제가 이미 정산됐다. 다시 정산하지 말고 저장된 결과로 자원을 낸다.
     * - `conflict` — 같은 id에 다른 결제가 왔다. 409.
     *
     * `fingerprint`는 구현이 해석하지 않는 불투명한 문자열이다(판매자 쪽이 sha256 hex로
     * 만든다). 저장해 두고 다음에 같은지만 비교하면 된다.
     */
    bind(payment: {id: string; fingerprint: string; paymentIntentId: Hex}): PaymentIdentifierBindResult;
    /**
     * 정산이 끝난 결과를 그 id에 남긴다. `bind`가 `new`를 준 뒤에만 불린다.
     *
     * 영수증 전체가 아니라 이 두 칸만 받는다. 나머지(금액·자산·payTo·네트워크·intent)는
     * 페이월 자신의 오퍼와 `bind`에 준 값이고, 같은 사실을 두 곳에 적어 두면 어긋날 수
     * 있다 — 지문이 일치했다는 것이 곧 그 값들이 그대로라는 뜻이다.
     */
    record(settlement: {id: string} & RecordedPayment): void;
}

/** What every paywall made by one {@link createMapae} shares. */
export interface MapaeOptions {
    /** Facilitator base URL. Defaults to {@link DEFAULT_FACILITATOR_URL}; HTTPS unless loopback. */
    facilitator?: string;
    /** Injected transport, for tests. Defaults to the global `fetch`. */
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    /**
     * The origin buyers reach this server at — `https://shop.example`, with no path,
     * query or trailing slash. When set, a 402's `resource.url` is `baseUrl` plus the
     * request's path (query dropped) instead of the URL the request arrived on, so a
     * server behind a tunnel or a reverse proxy advertises its public address rather
     * than `http://127.0.0.1:3000/…`.
     */
    baseUrl?: string;
}

/** One paywall: one price, one receiving address. */
export interface PaywallOptions {
    /** Your receiving address. Public — never a private key. */
    payTo: string;
    /** Price in tUSDC as a decimal string, e.g. `"0.01"`. Positive, at most 6 fractional digits. */
    price: string;
    /** Human-readable label the buyer's agent sees in the 402 offer and in the manifest. */
    description: string;
    /**
     * Runs before the protected handler on every answer that delivers a settled payment —
     * the one this call settled, or one an earlier call settled that this call replayed out
     * of {@link PaywallOptions.paymentIdentifiers}. Money has moved by then, so a throw is
     * logged and the buyer is still served — write your ledger here, keyed on
     * {@link SettlementReceipt.intent}, which is one row per payment however many answers
     * quote it.
     */
    onSettled?: (receipt: SettlementReceipt) => void | Promise<void>;
    /**
     * x402 extensions to publish, keyed by extension name. Each one is the spec's
     * envelope: `info` is what your extension declares, `schema` an optional JSON Schema
     * for what a client echoes back. They go in the 402 body's `extensions` slot — and
     * therefore in the `Payment-Required` header too, which encodes the same document.
     * Absent, the slot stays absent. It travels in a header on every unpaid request, so
     * keep it small.
     *
     * `payment-identifier` is not yours to publish: it is the paywall's own, advertised
     * exactly when {@link PaywallOptions.paymentIdentifiers} can honour it, and an entry
     * under that name here fails the boot rather than promising two things at once.
     */
    extensions?: Record<string, PaymentExtension>;
    /**
     * Durable (payment identifier → payment) binding. Given, the paywall advertises the
     * x402 `payment-identifier` extension and enforces it: a buyer's `id` is bound to this
     * request's normalised fingerprint and to the payment intent derived from its signature,
     * a second payment under the same `id` is refused **409**, and a repeat of the same
     * payment is answered from the stored result instead of settling twice.
     *
     * Absent, the extension is neither advertised nor read — an `id` in a payment is one
     * more envelope entry nobody named. That is the whole rule: a seller that cannot keep
     * the promise does not make it, and does not enforce a promise it never made either.
     */
    paymentIdentifiers?: PaymentIdentifierBinding;
}

/** Options of the one-liner {@link mapaePaywall}: a paywall plus the settings it is made with. */
export interface MapaePaywallOptions extends MapaeOptions, PaywallOptions {}

/** Hono environment the paywall populates: `c.get("mapaeReceipt")` is set once payment settled. */
export type MapaeEnv = {Variables: {mapaeReceipt: SettlementReceipt}};

/** One paywalled route, as the manifest reads it off the app. */
export interface MapaeManifestEndpoint {
    /** Hono's method name — `GET`, `POST`, …, or `ALL` for a paywall mounted with `app.use`. */
    method: string;
    /** The route pattern as mounted, e.g. `/reports/:id` or `/api/*`, base path included. */
    path: string;
    /** Price in tUSDC as a decimal string. */
    price: string;
    description: string;
    /** Checksummed receiving address of this endpoint. */
    payTo: Address;
}

/** The document served at {@link MAPAE_MANIFEST_PATH}. */
export interface MapaeManifest {
    version: 1;
    name: string;
    chain: "eip155:91342";
    asset: Address;
    facilitator: string;
    /** Sorted by path, then method. */
    endpoints: MapaeManifestEndpoint[];
}

export interface ManifestOptions {
    name: string;
    /** The app whose mounted paywalls the manifest lists — a Hono instance. */
    app: {routes: readonly RouterRoute[]};
}

/** Options of {@link mapaeManifest}: the manifest plus the facilitator it advertises. */
export interface MapaeManifestOptions extends ManifestOptions {
    /** Facilitator base URL. Defaults to {@link DEFAULT_FACILITATOR_URL}; HTTPS unless loopback. */
    facilitator?: string;
}

/** What {@link createMapae} returns: paywalls and a manifest bound to one facilitator. */
export interface MapaeSeller {
    /** The facilitator every paywall from this instance talks to, normalised. */
    readonly facilitator: string;
    /**
     * Settle-before-serve paywall for one price.
     *
     * Without a payment header the request is answered with a 402 carrying the x402 v2
     * offer (header and body). With one, the facilitator is asked to `/verify` and then
     * `/settle`, and only a confirmed settlement lets the next handler run:
     *
     * - 400 `malformed_payment` — the header is not a usable ERC-7710 payment, or its
     *   `payment-identifier` is not 16–128 characters of `[A-Za-z0-9_-]`. The receipt names
     *   `invalid_payload`, and no payer unless the header parsed far enough to name one.
     * - 409 `payment_identifier_conflict` — a second, different payment arrived under a
     *   `payment-identifier` this server has already bound. Nothing was charged and no offer
     *   is re-issued: this `id` can never mean anything else, and a buyer who wants to pay
     *   presents a fresh one.
     * - 503 `facilitator_unavailable` — `/supported` or `/verify` could not be reached,
     *   or the facilitator refused to look at the payment (its per-address rate limit,
     *   or a readiness check it failed). Nothing was charged; the buyer may retry later
     *   with the same payment.
     * - 402 with the offer re-issued — the facilitator examined the delegation and refused
     *   it, or the settlement failed without charging anybody. Nothing was charged and a
     *   new leaf can pay, which is what 402 means; the offer rides along so the buyer's
     *   agent does not have to ask for it again.
     * - 504 `settlement_unknown` — the facilitator broadcast but no receipt was seen, or
     *   the answer was lost. The buyer may have been charged and must not re-sign blindly.
     * - 502 `settlement_misdirected` — the redemption was mined and credited someone who
     *   is not this `payTo`. The buyer's balance may be gone, so no offer is re-issued.
     *
     * On success the receipt rides in `Payment-Response`, `c.get("mapaeReceipt")` holds
     * it, and `onSettled` has run. A payment this server has already settled under the
     * same `payment-identifier` is answered the same way out of the stored result, with
     * no facilitator call and `replayed: true`.
     *
     * Every one of those answers also carries `Cache-Control: no-store` and
     * `Vary: Payment-Signature`, and every refusal that read a payment carries the x402 v2
     * `SettleResponse` in `Payment-Response` — `success: false` plus the §9 word for why,
     * and the payer whenever the header parsed far enough to name one. Two answers carry no
     * receipt: a request that sent no payment header, which is no payment for one to be
     * about, and the 404 below, which leaves before the header is read at all.
     *
     * The facilitator rate-limits `/verify` and `/settle` per client address, and reads
     * `X-Mapae-Client-IP` only from a caller whose own address it cannot see — one on
     * loopback. So when this instance's facilitator is loopback and the buyer's request
     * carries `CF-Connecting-IP`, that value is forwarded on both calls under that name
     * and the buyer is counted rather than this server. A remote facilitator is told
     * nothing about the buyer.
     *
     * Mount it as a middleware in front of a handler. When it is the last matched route
     * it answers 404 without pricing anything — a buyer never pays for a route nothing
     * serves.
     */
    paywall(options: PaywallOptions): MiddlewareHandler<MapaeEnv>;
    /**
     * Handler for `GET /.well-known/mapae.json`, listing every paywall mounted on `app`
     * with its method, path, price, description and receiving address. The app is read
     * once, on the first request — after every route has been mounted, whichever order
     * they were written in — and the result is kept: Hono's router refuses a new route
     * once the first request has been matched, so what that request saw is what the
     * server has.
     */
    manifest(options: ManifestOptions): (c: Context) => Response;
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

/** An origin and nothing else, so `baseUrl` plus a request path is always a well-formed URL. */
function parseBaseUrl(value: string): string {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("baseUrl must be an absolute HTTP(S) origin without credentials");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("baseUrl must be an origin — scheme://host[:port] — with no path, query or fragment");
    }
    return url.origin;
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
 * What a payment call says about the buyer. `clientIp` is the buyer's `CF-Connecting-IP`
 * as the paywall received it; the client forwards it in {@link CLIENT_IP_HEADER} when its
 * facilitator is one that reads it, so the per-address limit counts the buyer and not
 * this server. Absent, no header is sent and the facilitator counts whoever it can see.
 */
interface BuyerContext {
    clientIp: string | undefined;
}

/**
 * The three facilitator calls, with the one rule they share: `reachable: false` is every
 * way a call did not yield a body — refused connection, non-2xx, unparseable JSON,
 * timeout. It deliberately does not distinguish them. For `/settle` they are all the
 * same claim, that we do not know whether money moved.
 */
class FacilitatorClient {
    #cached?: {kind: FacilitatorKind; expiresAt: number};
    #discovering?: Promise<FacilitatorKind | undefined>;
    /**
     * Whether the buyer is named to this facilitator. It reads {@link CLIENT_IP_HEADER}
     * only from a caller whose address it cannot see, and with the tunnel as its one
     * public path those callers are the ones on loopback — so loopback is this side's
     * stand-in for that rule, and the only facilitator the header goes to. A remote one
     * sees this server's address and ignores the header; sending it there would carry
     * the buyer's address across the internet for nothing.
     */
    readonly #namesBuyer: boolean;

    constructor(
        readonly baseUrl: string,
        readonly fetchImpl: NonNullable<MapaeOptions["fetch"]>,
    ) {
        this.#namesBuyer = isLoopbackHost(new URL(baseUrl).hostname);
    }

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

    verify(request: Erc7710FacilitatorRequest, buyer: BuyerContext): Promise<FacilitatorAnswer> {
        return this.#call("/verify", {request, buyer}, VERIFY_TIMEOUT_MS);
    }

    settle(request: Erc7710FacilitatorRequest, buyer: BuyerContext): Promise<FacilitatorAnswer> {
        return this.#call("/settle", {request, buyer}, SETTLE_TIMEOUT_MS);
    }

    async #call(
        path: "/supported" | "/verify" | "/settle",
        payment: {request: Erc7710FacilitatorRequest; buyer: BuyerContext} | undefined,
        timeoutMs: number,
    ): Promise<FacilitatorAnswer> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: payment ? "POST" : "GET",
                ...(payment
                    ? {
                          headers: {
                              "content-type": "application/json",
                              ...(this.#namesBuyer && payment.buyer.clientIp !== undefined
                                  ? {[CLIENT_IP_HEADER]: payment.buyer.clientIp}
                                  : {}),
                          },
                          body: JSON.stringify(payment.request),
                      }
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
        decoded = decodePaymentHeader(header);
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
 * What a paywall middleware says about itself. The manifest reads it off `app.routes`, so
 * the list of what a server sells is the list of what it actually guards — a route that
 * was never mounted cannot be advertised, and one that was cannot be left out.
 */
type PaywallDescriptor = Pick<MapaeManifestEndpoint, "price" | "description" | "payTo">;

const PAYWALL = Symbol("mapae.paywall");

function paywallDescriptor(handler: unknown): PaywallDescriptor | undefined {
    if (typeof handler !== "function") return undefined;
    const own = (handler as {[PAYWALL]?: PaywallDescriptor})[PAYWALL];
    if (own) return own;
    // `app.route()` wraps a sub-app's handlers in that sub-app's own `onError` when it
    // has one, and keeps the original where Hono's own tooling looks for it.
    return paywallDescriptor((handler as {[COMPOSED_HANDLER]?: unknown})[COMPOSED_HANDLER]);
}

/**
 * Write the failure receipt: the same x402 v2 `SettleResponse` document a success carries,
 * on the failure side of that union, so every refusal of an attempted payment says why in
 * a field rather than in prose.
 *
 * The word is never the facilitator's text — `@mapae/delegation`'s outcome ladder folds
 * what it received onto a closed vocabulary first, and only that reaches the buyer.
 *
 * `payer` is left out when the header never parsed, because an unreadable header names
 * nobody. The receipt still goes out: the buyer's agent has to decide whether to fix the
 * header or sign a new leaf, and that is a decision it makes by machine.
 *
 * Two rungs carry no receipt. The request that sent no payment header at all — see the
 * `/supported` branch below — and the 404, which leaves before this middleware reads the
 * header, so a request that did carry one is answered without a receipt too. That is the
 * 404's own rule rather than an exception to this one: no route would have served the
 * payment either way, so nothing here priced it and nothing can be the receipt of it.
 */
function writeFailureReceipt(
    c: Context<MapaeEnv>,
    errorReason: string,
    payer: Address | undefined,
    transaction: Hex | "" = "",
): void {
    const receipt: SettleResponse = {
        success: false,
        errorReason,
        network: NETWORK,
        ...(payer === undefined ? {} : {payer}),
        transaction,
    };
    c.header(PAYMENT_RESPONSE_HEADER, encodePaymentResponseHeader(receipt));
}

/**
 * 지문 목록의 버전. 항목이 늘거나 순서가 바뀌면 같은 요청이 다른 지문을 내므로, 옛 행과
 * 새 행이 맞지 않는다 — 그때 조용히 "같은 결제"로 읽히는 대신 409로 떨어지도록 태그를
 * 함께 접는다. 태그를 올리는 것이 마이그레이션이다.
 */
const FINGERPRINT_VERSION = "mapae.x402.payment-identifier.fingerprint.v1";

/**
 * 사양 "Request Binding"의 정규화된 요청 지문. 아래 순서로 한 줄에 이어 sha256으로 접는다:
 *
 *   1. {@link FINGERPRINT_VERSION}  이 목록의 버전
 *   2. scheme                      오퍼의 것 — 이 레일에서는 언제나 `exact`
 *   3. network                     CAIP-2
 *   4. asset                       체크섬 주소
 *   5. amount                      최소 단위 정수 문자열
 *   6. payTo                       체크섬 주소
 *   7. 자원 경로                   요청이 온 그대로의 pathname, 쿼리 없이
 *   8. 메서드                      대문자
 *
 * 사양이 함께 적은 "애플리케이션 식별자"는 경로가 대신한다: 이 미들웨어는 자기 뒤에 무엇이
 * 팔리는지 모르고, 호스팅 상점의 상품 키는 경로 안에 있다. 쿼리를 빼는 것은 오퍼가 값을
 * 매기는 단위가 경로이기 때문이다 — 같은 경로의 다른 쿼리는 같은 402를 받는다.
 *
 * 구분자는 줄바꿈이고, 위 값들 중 줄바꿈을 담을 수 있는 것은 없다(주소·정수·CAIP-2·
 * 퍼센트 인코딩된 경로·메서드). 그래서 이어 붙인 문자열이 항목 경계를 잃지 않는다.
 */
function requestFingerprint(
    requirements: Erc7710PaymentRequirements,
    path: string,
    method: string,
): string {
    const canonical = [
        FINGERPRINT_VERSION,
        requirements.scheme,
        requirements.network,
        requirements.asset,
        requirements.amount,
        requirements.payTo,
        path,
        method.toUpperCase(),
    ].join("\n");
    // 0x 접두사를 떼어 64자 소문자 hex로 — 저장소의 해시 칸이 그 모습을 요구한다.
    return sha256(stringToBytes(canonical)).slice(2);
}

function buildPaywall(
    facilitator: FacilitatorClient,
    baseUrl: string | undefined,
    options: PaywallOptions,
): MiddlewareHandler<MapaeEnv> {
    const payTo = parsePayTo(options.payTo);
    const amount = parsePrice(options.price);
    const {description, onSettled, extensions, paymentIdentifiers} = options;
    if (!description.trim()) throw new Error("description must not be empty");
    // Serialised once here, so a value JSON cannot carry fails the boot, not a buyer's 402.
    if (extensions !== undefined) JSON.stringify(extensions);
    if (extensions !== undefined && PAYMENT_IDENTIFIER_EXTENSION in extensions) {
        throw new Error(
            `${PAYMENT_IDENTIFIER_EXTENSION} is published by the paywall itself — pass paymentIdentifiers instead of declaring it`,
        );
    }
    // 광고는 지킬 수 있을 때만 한다. 바인딩이 없으면 이 항목은 없고, 읽는 쪽도 없다.
    const advertised: Record<string, PaymentExtension> | undefined =
        paymentIdentifiers === undefined
            ? extensions
            : {...extensions, [PAYMENT_IDENTIFIER_EXTENSION]: buildPaymentIdentifierOffer()};

    const paywall: MiddlewareHandler<MapaeEnv> = async (c, next) => {
        // Every answer below turns on whether this request carried a payment, so a shared
        // cache must never hand one of them to the other request: `no-store` keeps a paid
        // body out of a cache at all, and `Vary` keys whatever a cache does keep on the
        // payment header. Set before the first branch — the 404 rung included, so that
        // "every answer" is a claim about every answer and not about most of them.
        c.header("Cache-Control", "no-store");
        c.header("Vary", PAYMENT_SIGNATURE_HEADER);

        // Never price, let alone settle, a route nothing will serve. When this
        // middleware is the last matched route, `next()` would be a 404 — a buyer
        // must not pay for one. This leaves before the header is read, so a request that
        // did carry a payment gets no receipt here either: the receipt is written by the
        // rung that priced the payment, and this rung never priced anything.
        if (c.req.routeIndex === matchedRoutes(c).length - 1) return c.notFound();

        // Whatever is wrong with the header itself is answered before the facilitator
        // is involved: a bad header costs nobody a network call.
        const header = c.req.header(PAYMENT_SIGNATURE_HEADER);
        // The claimed delegator is what every facilitator answer is cross-checked
        // against, and what a receipt names, so it is derived the moment the header
        // parses. The facilitator itself binds that claim to the signed root, so an
        // answer naming anyone else is an answer about some other payment.
        let payment: {payload: Erc7710PaymentPayload; payer: Address} | undefined;
        /** 이 결제가 실어 온 멱등성 키. 확장을 읽는 판매자가, 실려 온 경우에만. */
        let identifier: string | undefined;
        if (header !== undefined) {
            // A payment was attempted and this side could not read it. The receipt names
            // the §9 word for that and no payer — the name was in the text that did not
            // parse — while `detail` keeps the prose for a human reading the body. What a
            // buyer's agent acts on is the word.
            if (header.length > MAX_PAYMENT_HEADER_LENGTH) {
                writeFailureReceipt(c, INVALID_PAYLOAD, undefined);
                return c.json({error: "malformed_payment", detail: "header too large"}, 400);
            }
            const decoded = readDelegatedPayment(header);
            if (!decoded.ok) {
                writeFailureReceipt(c, INVALID_PAYLOAD, undefined);
                return c.json({error: "malformed_payment", detail: decoded.detail}, 400);
            }
            payment = {payload: decoded.payload, payer: getAddress(decoded.payload.payload.delegator)};
            // 확장은 바인딩과 함께 산다: 광고하지 않는 판매자는 읽지도 않는다. 읽는
            // 판매자에게 형식이 어긋난 id는 400이다 — 그 결제는 우리가 지킬 수 없는
            // 약속을 걸었고, 조용히 무시하면 구매자는 멱등성이 걸린 줄 알고 다시 낸다.
            // 퍼실리테이터를 부르기 전에 답한다: 나쁜 헤더는 아무에게도 네트워크 호출을
            // 물리지 않는다. 여기서는 지불자를 댈 수 있다 — 헤더가 그 이름까지는 읽혔다.
            if (paymentIdentifiers) {
                const read = readPaymentIdentifier(decoded.payload);
                if (read.kind === "malformed") {
                    writeFailureReceipt(c, INVALID_PAYLOAD, payment.payer);
                    return c.json(
                        {
                            error: "malformed_payment",
                            detail: `${PAYMENT_IDENTIFIER_EXTENSION} must be 16–128 characters of [A-Za-z0-9_-]`,
                        },
                        400,
                    );
                }
                if (read.kind === "present") identifier = read.id;
            }
        }

        const kind = await facilitator.kind();
        if (!kind) {
            // `/supported` never looked at a payment, so there is no word from the
            // facilitator to carry: not-ready is this side's own reading.
            //
            // The condition is `payment`, not its payer: a request that sent no
            // `Payment-Signature` asked what this resource costs, and a settlement receipt
            // for a settlement nobody attempted is an invention — there is no payment for
            // it to be the receipt *of*. Every rung that does answer an attempted payment
            // carries one, whether or not the payer's name survived.
            if (payment) writeFailureReceipt(c, FACILITATOR_NOT_READY, payment.payer);
            return c.json({error: "facilitator_unavailable"}, 503);
        }
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

        /**
         * The 402 and its offer, in a header and a body alike. Both the unpaid request and
         * a payment that failed without charging anybody are answered with it: the second
         * one is a payment the buyer may make again with a new leaf, and re-issuing the
         * offer is what spares their agent a round trip to ask for it.
         */
        const offer = (): Response => {
            // Behind `baseUrl` the resource is the public origin plus the path exactly as
            // it arrived — still percent-encoded, query dropped — so it stays a URL a
            // buyer can call, not the decoded form `c.req.path` carries.
            const url = baseUrl ? `${baseUrl}${new URL(c.req.url).pathname}` : c.req.url;
            const body: PaymentRequired<Erc7710PaymentRequirements> = {
                x402Version: X402_VERSION,
                resource: {url, description},
                accepts: [requirements],
                ...(advertised === undefined ? {} : {extensions: advertised}),
            };
            // v2 transport puts the offer in a Payment-Required header; the JSON body
            // stays as well, and a client honours whichever of the two it understands.
            c.header(PAYMENT_REQUIRED_HEADER, encodePaymentRequiredHeader(body));
            return c.json(body, 402);
        };

        if (!payment) return offer();
        const {payload, payer} = payment;
        // 파생은 여기 한 번이다. 바인딩의 판정과 성공 영수증이 같은 값을 써야 한다 —
        // 두 번 계산하면 두 곳에서 서로 다른 오퍼를 읽게 될 여지가 생긴다.
        const intent = derivePaymentIntentId({
            network: requirements.network,
            asset: requirements.asset,
            amount,
            payTo,
            delegationManager: getAddress(payload.payload.delegationManager),
            permissionContext: payload.payload.permissionContext,
        });

        /**
         * 정산이 끝난 결제를 자원으로 바꾸는 한 곳. 이 호출이 정산한 결제와, 앞선 호출이
         * 정산해 바인딩에 남긴 결제가 같은 길을 지난다 — 구매자 쪽에서 둘은 구별되지
         * 않아야 하고(같은 200, 같은 영수증 헤더), 판매자의 장부도 같은 intent 한 건을
         * 두 번 받는 것으로만 보아야 한다.
         */
        const deliver = async (receipt: SettlementReceipt): Promise<void> => {
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

            // Again after the handler, and deliberately the paywall's word rather than the
            // handler's: a paid body in a shared cache is a resource served to whoever asks
            // next, and a handler returning its own Response would otherwise carry neither.
            c.header("Cache-Control", "no-store");
            c.header("Vary", PAYMENT_SIGNATURE_HEADER);
            // Built from fields this middleware validated — a CAIP-2 constant, a checksummed
            // address, a hex hash already matched against /^0x[0-9a-fA-F]{64}$/ — not by
            // echoing the facilitator's body.
            c.header(
                PAYMENT_RESPONSE_HEADER,
                encodePaymentResponseHeader({
                    success: true,
                    network: requirements.network,
                    payer: receipt.payer,
                    // The spec writes "no hash" as `""`, not as a missing field: a
                    // counterparty validating the reference schema needs the key present.
                    transaction: receipt.transaction ?? "",
                }),
            );
        };

        // 멱등성 판정은 퍼실리테이터보다 먼저다. 사양의 표가 그렇게 요구하고("같은 id에
        // 다른 요청이면 캐시된 결과를 주지도, 두 번째 연산을 하지도 말 것"), 정산은 그
        // "두 번째 연산"이다.
        if (paymentIdentifiers && identifier !== undefined) {
            const bound = paymentIdentifiers.bind({
                id: identifier,
                // 쿼리를 뺀 경로 — 오퍼가 값을 매기는 단위이고, `resource.url`이 쓰는 것과
                // 같은 값이다.
                fingerprint: requestFingerprint(
                    requirements,
                    new URL(c.req.url).pathname,
                    c.req.method,
                ),
                paymentIntentId: intent,
            });
            if (bound.kind === "conflict") {
                writeFailureReceipt(c, PAYMENT_IDENTIFIER_CONFLICT, payer);
                // 오퍼를 다시 싣지 않는다. 402는 "이대로 다시 내라"는 말이고, 이 id로는
                // 무엇을 내도 같은 409다 — 낼 뜻이 있는 구매자는 새 id를 들고 온다.
                return c.json({error: PAYMENT_IDENTIFIER_CONFLICT, detail: bound.reason}, 409);
            }
            if (bound.kind === "settled") {
                // 프로세스와 함께 죽지 않는 재생 가드: 정산을 다시 하지 않고 저장된
                // 결과로 답한다. 지불자는 저장된 값이다 — 이 호출이 주장한 delegator가
                // 아니라 퍼실리테이터가 확인한 이름이고, intent는 delegator를 포함하지
                // 않으므로 그 둘이 다를 수 있다.
                await deliver({
                    intent,
                    payer: bound.settled.payer,
                    amount: fromTokenAmount(amount),
                    asset: requirements.asset,
                    payTo,
                    network: NETWORK,
                    ...(bound.settled.transaction === undefined
                        ? {}
                        : {transaction: bound.settled.transaction}),
                    // 이 호출은 정산하지 않았다 — `replayed`가 말하는 것이 정확히 그것이다.
                    replayed: true,
                });
                return;
            }
        }

        const request: Erc7710FacilitatorRequest = {
            x402Version: X402_VERSION,
            paymentPayload: payload,
            paymentRequirements: requirements,
        };
        // Only the address Cloudflare wrote on the buyer's request. An `X-Mapae-Client-IP`
        // the buyer sent themselves is never passed through: a request through the tunnel
        // always carries `CF-Connecting-IP`, and one that does not carry it came from
        // somewhere the facilitator would not count anyway.
        const buyer: BuyerContext = {clientIp: c.req.header("cf-connecting-ip")};

        // "Could not be reached" and "refused this delegation" are different claims.
        // Nothing is charged at /verify, so 503 is a safe, honest "retry later".
        const verification = decideVerification(await facilitator.verify(request, buyer), payer);
        if (verification.kind === "unavailable") {
            writeFailureReceipt(c, verification.errorReason, payer);
            return c.json({error: "facilitator_unavailable"}, 503);
        }
        if (verification.kind === "rejected") {
            // A refused delegation is not the end of the sale. The buyer can sign another
            // leaf and pay again, and 402 is the status the spec keeps for "pay (again) to
            // proceed" — a 403 said "this identity may not have it", which was never true
            // of a payment that was simply not accepted yet.
            writeFailureReceipt(c, verification.errorReason, payer);
            return offer();
        }

        // "Did not succeed" and "is not known to have succeeded" are different claims
        // too. A transport failure, or a facilitator that broadcast without seeing a
        // receipt, leaves the payer possibly charged — 402 would invite a second payment.
        const outcome = decideSettlement(await facilitator.settle(request, buyer), payer);
        if (outcome.kind === "unavailable") {
            writeFailureReceipt(c, outcome.errorReason, payer);
            return c.json({error: "facilitator_unavailable"}, 503);
        }
        if (outcome.kind === "unknown") {
            // The hash rides along whenever the facilitator named one: it is the buyer's
            // only way to find out for themselves whether they were charged.
            writeFailureReceipt(c, SETTLEMENT_PENDING, payer, outcome.transaction ?? "");
            return c.json({error: "settlement_unknown"}, 504);
        }
        if (outcome.kind === "failed") {
            writeFailureReceipt(c, outcome.errorReason, payer, outcome.transaction ?? "");
            // A mined redemption that credited someone else moved the buyer's balance. No
            // offer goes back with it: answering "pay again" to a buyer who has already
            // paid once is how one sale takes two payments, and this wire cannot refund
            // the first.
            if (outcome.errorReason === VENDOR_NOT_CREDITED) {
                return c.json({error: "settlement_misdirected"}, 502);
            }
            // Everything still here charged nobody. That is not read off this one word:
            // `decideSettlement` only reaches `failed` with a hash for a word that names a
            // mined failure, and turns any other answer carrying one into `unknown` above.
            // So the offer is never re-issued alongside evidence of a broadcast, whatever
            // the facilitator called it.
            return offer();
        }

        const receipt: SettlementReceipt = {
            intent,
            payer,
            amount: fromTokenAmount(amount),
            asset: requirements.asset,
            payTo,
            network: NETWORK,
            transaction: outcome.transaction,
            replayed: outcome.replayed,
        };
        if (paymentIdentifiers && identifier !== undefined) {
            // 기록은 정산이 성공한 뒤에만이다. 미결(504)이나 실패에서 남기면 다음 호출이
            // "이미 낸 결제"라며 자원을 내주는데, 정말 냈는지는 아무도 모른다.
            try {
                paymentIdentifiers.record({
                    id: identifier,
                    payer,
                    ...(outcome.transaction === undefined
                        ? {}
                        : {transaction: outcome.transaction}),
                });
            } catch (error) {
                // 돈은 이미 옮겨졌다. 여기서 500을 내면 구매자의 클라이언트는 그것을
                // "아무것도 청구되지 않았다"로 읽고 다시 낸다 — 기록을 잃는 것이 결제를
                // 두 번 받는 것보다 낫다. 대신 판매자가 로그에서 보게 한다.
                console.error(
                    `[mapae] payment identifier record failed for intent ${receipt.intent} — ${redactForLog(error)}`,
                );
            }
        }
        await deliver(receipt);
    };
    const descriptor: PaywallDescriptor = {price: options.price.trim(), description, payTo};
    return Object.assign(paywall, {[PAYWALL]: descriptor});
}

function compareEndpoints(a: MapaeManifestEndpoint, b: MapaeManifestEndpoint): number {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return 0;
}

function describeRoutes(routes: readonly RouterRoute[]): MapaeManifestEndpoint[] {
    const endpoints: MapaeManifestEndpoint[] = [];
    for (const route of routes) {
        const paywall = paywallDescriptor(route.handler);
        if (paywall) endpoints.push({method: route.method, path: route.path, ...paywall});
    }
    return endpoints.sort(compareEndpoints);
}

function buildManifest(options: ManifestOptions, facilitator: string): (c: Context) => Response {
    const name = options.name.trim();
    if (!name) throw new Error("manifest name must not be empty");
    const {app} = options;
    let document: MapaeManifest | undefined;
    return (c) => {
        document ??= {
            version: 1,
            name,
            chain: NETWORK,
            asset: MOCK_USDC.address,
            facilitator,
            endpoints: describeRoutes(app.routes),
        };
        return c.json(document);
    };
}

/**
 * One facilitator client — one `/supported` cache, one set of timeouts — for every
 * paywall and the manifest of a server. Everything is validated here, so a bad
 * facilitator or `baseUrl` fails the process at boot rather than a buyer at runtime.
 */
export function createMapae(options: MapaeOptions = {}): MapaeSeller {
    const facilitator = parseFacilitatorUrl(options.facilitator ?? DEFAULT_FACILITATOR_URL);
    const client = new FacilitatorClient(
        facilitator,
        options.fetch ?? ((input, init) => fetch(input, init)),
    );
    const baseUrl = options.baseUrl === undefined ? undefined : parseBaseUrl(options.baseUrl);
    return {
        facilitator,
        paywall: (paywall) => buildPaywall(client, baseUrl, paywall),
        manifest: (manifest) => buildManifest(manifest, facilitator),
    };
}

/**
 * The one-liner: `createMapae(options).paywall(options)`. Each call makes its own
 * facilitator client; a server with several paywalls shares one through
 * {@link createMapae}. See {@link MapaeSeller.paywall} for the responses.
 */
export function mapaePaywall(options: MapaePaywallOptions): MiddlewareHandler<MapaeEnv> {
    return createMapae(options).paywall(options);
}

/**
 * Handler for `GET /.well-known/mapae.json`, derived from the paywalls mounted on `app`.
 * See {@link MapaeSeller.manifest}.
 */
export function mapaeManifest(options: MapaeManifestOptions): (c: Context) => Response {
    return buildManifest(options, parseFacilitatorUrl(options.facilitator ?? DEFAULT_FACILITATOR_URL));
}
