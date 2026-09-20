/**
 * The guards in front of the facilitator's routes — every decision about a request that
 * is taken *before* the chain is touched, or that decides whether it is touched at all —
 * and, once a settlement has failed, the one classification that tells the wire and the
 * ledger what happened.
 *
 * `index.ts` boots against a signer, two artifacts and a live RPC, so no test can import
 * it. The decisions live here, where they are provable with a `Map` and a clock, and
 * `index.ts` only wires them into Hono.
 */
import {
    CLIENT_IP_HEADER,
    FACILITATOR_NOT_READY,
    FixedWindowLimiter,
    PaymentValidationError,
    RATE_LIMITED,
    SETTLEMENT_PENDING,
    ipBucket,
    isRateLimitError,
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import {SettlementBudgetExceeded} from "@mapae/store";
import type {MiddlewareHandler} from "hono";
import {
    ContractFunctionRevertedError,
    ExecutionRevertedError,
    HttpRequestError,
    TimeoutError,
    type Hex,
} from "viem";

// ── Per-IP rate limit ──────────────────────────────────────────────────────────────

export const RATE_WINDOW_MS = 3_600_000;
/**
 * Expired windows are dropped from the limiter's map every this-many limited requests
 * rather than on each one. `sweep` walks the whole map: measured at 6.1 ms per call with
 * 1,000,000 live keys (Bun 1.4.0), which a flood of distinct addresses would have put in
 * front of every payment for the rest of the hour. Amortised over 256 requests it is
 * 24 µs; the map still cannot outlive its windows by more than 255 requests.
 */
export const SWEEP_EVERY = 256;

/**
 * What a rate-limited request is answered with: a 200 with a refusal body, exactly like
 * every other refusal from these routes. The seller's client reads any non-2xx as "the
 * answer was lost" and tells the buyer the payment is *unknown*; a request that was
 * never read, let alone broadcast, must not be called that. The seller reads
 * `RATE_LIMITED` itself as *unavailable* on both routes — 503, retry later — so the
 * refusal is neither a rejected delegation nor a payment in doubt.
 */
export const VERIFY_RATE_LIMITED: Erc7710VerifyResponse = {
    isValid: false,
    invalidReason: RATE_LIMITED,
};
export const SETTLE_RATE_LIMITED: Erc7710SettleResponse = {
    success: false,
    transaction: "",
    network: GIWA_SEPOLIA_CAIP2,
    errorReason: RATE_LIMITED,
};

/**
 * Refuse the (limit + 1)th request from one address within the window, before the body
 * is read and before anything is enqueued toward the RPC — so a flood costs a Map lookup
 * and nothing else. Until this existed the only bound on an anonymous caller was the
 * day's gas budget: 1,500 self-paid redemptions with free testnet tUSDC, and every other
 * seller got `budget_exhausted` until UTC midnight.
 *
 * Cloudflare sets `CF-Connecting-IP` on everything that comes through the tunnel, and the
 * tunnel is the only public path. A request without it came over loopback, and loopback
 * has two kinds of caller: our own services, exempt, and the hosted shop on the same
 * machine (127.0.0.1:8081), whose buyers are the public internet too — it names the
 * buyer in {@link CLIENT_IP_HEADER} and that buyer is counted. Without the forwarded
 * name the shop was an unlimited path to `/verify`'s simulation for anyone who could
 * spell a delegation.
 *
 * The window is the client's network as `ipBucket` names it — the address for IPv4,
 * the /64 for IPv6 — the same key the sponsored services count on.
 */
export function rateLimitByIp(
    limiter: FixedWindowLimiter,
    refusal: Erc7710VerifyResponse | Erc7710SettleResponse,
    clock: () => number = Date.now,
): MiddlewareHandler {
    let counted = 0;
    return async (c, next) => {
        const ip = c.req.header("cf-connecting-ip") ?? c.req.header(CLIENT_IP_HEADER);
        if (ip === undefined) return next();
        const now = clock();
        counted += 1;
        if (counted % SWEEP_EVERY === 0) limiter.sweep(now);
        if (!limiter.tryConsume(`ip:${ipBucket(ip)}`, now)) return c.json(refusal);
        return next();
    };
}

// ── Readiness ──────────────────────────────────────────────────────────────────────

/** How a route answers a caller whose readiness probe failed: the status and the body. */
export interface NotReadyAnswer<Body extends Erc7710VerifyResponse | Erc7710SettleResponse> {
    status: 200 | 503;
    body: Body;
}

/**
 * What a caller whose readiness probe failed is answered with. No verdict was formed —
 * the delegation was never looked at — and until this existed both routes answered as
 * though one had been (`delegation_rejected`), which sent a buyer to re-sign a grant
 * nothing had refused whenever one RPC read timed out.
 *
 * `/verify` answers a 503: the seller reads any non-2xx there as *unavailable*, and so
 * does anyone else's x402 client. `/settle` cannot — a non-2xx there is "the answer was
 * lost", a payment in doubt — so it answers a 200 whose reason the seller's ladder reads
 * as unavailable, exactly like {@link SETTLE_RATE_LIMITED}.
 */
export const VERIFY_NOT_READY: NotReadyAnswer<Erc7710VerifyResponse> = {
    status: 503,
    body: {isValid: false, invalidReason: FACILITATOR_NOT_READY},
};
export const SETTLE_NOT_READY: NotReadyAnswer<Erc7710SettleResponse> = {
    status: 200,
    body: {success: false, transaction: "", network: GIWA_SEPOLIA_CAIP2, errorReason: FACILITATOR_NOT_READY},
};

/**
 * Refuse the request when the readiness probe fails, before the body is read. The probe
 * is shared per window (see {@link CachedProbe}), so a caller here either reads the
 * window's value or waits on the one probe in flight; it never adds a read of its own.
 * The probe logs its own failure, once; the caller's answer carries the closed reason
 * and nothing about why.
 */
export function requireReadiness(
    readiness: Pick<CachedProbe<unknown>, "read">,
    refusal: NotReadyAnswer<Erc7710VerifyResponse | Erc7710SettleResponse>,
): MiddlewareHandler {
    return async (c, next) => {
        try {
            await readiness.read();
        } catch {
            return c.json(refusal.body, refusal.status);
        }
        return next();
    };
}

// ── Gas budgets: the day's total and each payer's share of it ──────────────────────

// ── Settlement failures ─────────────────────────────────────────────────────────────

/**
 * Raised when the RPC stopped answering while the redemption was being simulated and
 * priced — before the reservation, before the broadcast. Nothing was charged and no
 * verdict on the delegation was formed: the readiness probe passed up to 5 s earlier,
 * and the transport dying one call later is the same non-answer. Both routes answer it
 * as they answer a failed probe, and `/settle` writes no ledger row for it, exactly as
 * the readiness middleware writes none. Until this existed `/settle` fell through to
 * `delegation_rejected` with a `rejected` row — a verdict nobody had formed, sending the
 * buyer to re-sign a grant nothing had refused.
 *
 * Only {@link beforeBroadcast} raises it, and only around the pre-broadcast stage. From
 * `sendRawTransaction` on, a transport failure is ambiguous — the node may have accepted
 * the transaction — and is {@link SettlementPending}, never this.
 *
 * The message is a constant; what died is the `cause`, and the operator's line is
 * written from that. Composing the cause's text in here spent a third of
 * `redactForLog`'s budget on this wrapper's name and redacted the RPC URL twice.
 */
export class RpcUnreachableBeforeBroadcast extends Error {
    constructor(cause: unknown) {
        super("RPC stopped answering before the redemption was broadcast", {cause});
        this.name = "RpcUnreachableBeforeBroadcast";
    }
}

/**
 * The settlement journal could not be read, or the claim could not be written durably.
 * No new send is allowed, and no verdict exists: the request examined nothing and
 * charged nothing, so both routes answer it as they answer a failed probe. Under the
 * old wire an unreadable journal was called *unconfirmed* without a hash — but the
 * journal records the hash before the broadcast, so a row that cannot be read is not a
 * payment in doubt, it is a facilitator that cannot look. Not-ready says exactly that,
 * and the seller already reads it as "try again later with the same header".
 */
export class SettlementStorageUnavailable extends Error {
    constructor(cause: unknown) {
        super("settlement storage unavailable", {cause});
        this.name = "SettlementStorageUnavailable";
    }
}

/**
 * Run one step of the stage before the broadcast — the simulation, the gas estimate, the
 * fee estimate — and raise a transport death inside it as
 * {@link RpcUnreachableBeforeBroadcast}. Every other throw (a revert, the gas cap) is a
 * verdict and passes through unchanged.
 */
export async function beforeBroadcast<T>(step: () => Promise<T>): Promise<T> {
    try {
        return await step();
    } catch (error) {
        throw isRpcUnreachable(error) ? new RpcUnreachableBeforeBroadcast(error) : error;
    }
}

/**
 * Raised when a redemption's claim is in the journal but its receipt was not seen — the
 * send answer was lost, the wait timed out, or the terminal write failed after mining.
 *
 * Distinct from every other settlement failure because the payer may well have been
 * charged. The caller needs the hash to find out, and must not be told the payment
 * was rejected. The hash is mandatory: x402 v2 binds `settlement_pending` to a
 * non-empty `transaction`, and the journal computes the hash before the broadcast, so
 * every producer has it. The one ambiguity that used to arrive without a hash — an
 * unreadable journal — is {@link SettlementStorageUnavailable}: that request charged
 * nothing and is answered not-ready.
 */
export class SettlementPending extends Error {
    constructor(readonly transaction: Hex) {
        super("redemption broadcast but not confirmed");
        this.name = "SettlementPending";
    }
}

/**
 * The Mapae profile's one refusal outside the x402 §9 vocabulary: the facilitator
 * examined the delegation against live state and the chain would not redeem it — the
 * simulation reverted, or the redemption priced above `MAX_REDEMPTION_GAS`. Neither is
 * a defect in the request's text (§9 has words for those) nor an unexpected failure of
 * ours; it is the verdict the delegation earned, and the seller reads it as a 403 for
 * the buyer to re-sign. The reason stays this one word on purpose — the revert text
 * names the caveat that fired, which is the caller's boundary to probe.
 */
export const DELEGATION_REJECTED = "delegation_rejected";

/** The redemption priced above the configured gas cap: a verdict, before the reservation. */
export class RedemptionRejected extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RedemptionRejected";
    }
}

/**
 * viem nests the error it decoded as the `cause` of the action that was running, so both
 * classifiers below walk the chain rather than read the top link. Eight is deeper than
 * any shape either side raises, and bounds a cause cycle.
 */
function* causeChain(error: unknown): Generator<Error> {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
        yield current;
        current = current.cause;
    }
}

/**
 * True when the chain itself answered "no" to the redemption. Deliberately not "any viem
 * error": `BaseError` covers our own encoding mistakes too, and calling one of those a
 * rejected delegation would send a buyer to re-sign a grant the chain never saw. Only a
 * decoded revert counts — with `ExecutionRevertedError` for the node that reports one
 * under a plain `-32000`, leaving viem no revert data to decode.
 */
function isRedemptionRevert(error: unknown): boolean {
    for (const link of causeChain(error)) {
        if (link instanceof ContractFunctionRevertedError || link instanceof ExecutionRevertedError) {
            return true;
        }
    }
    return false;
}

/**
 * What a failed attempt on either route says to the wire and to the ledger — one
 * classification for both consumers, so the two can never disagree about what happened.
 *
 * `rejected`: nobody was charged. The code is the §9 word a {@link PaymentValidationError}
 * carries, a budget's own code, {@link DELEGATION_REJECTED} for a simulation revert or
 * the gas cap, and the route's §9 `unexpected_verify_error` / `unexpected_settle_error`
 * for anything else — a bug of ours, and the only honest thing to call it: every throw
 * that reaches here happened before the broadcast, so the unexpected ones charged nobody
 * either, but nothing about them is a verdict on the delegation. Its `transaction` is the
 * wire's `""`.
 * `error`: the original transaction exists but its final result is unknown; the hash
 * always rides along. Mined failures are classified from the receipt by settlement.ts
 * and committed by the settlement journal, with their gas cost and transaction identity.
 * `not_ready`: no verdict at all ({@link RpcUnreachableBeforeBroadcast},
 * {@link SettlementStorageUnavailable}) — the answer is {@link SETTLE_NOT_READY} and
 * there is no row, because a row records a verdict.
 */
export type SettlementFailure =
    | {outcome: "not_ready"}
    | {outcome: "rejected"; errorCode: string; transaction: ""}
    | {outcome: "error"; errorCode: typeof SETTLEMENT_PENDING; transaction: Hex};

export function describeFailure(error: unknown, route: "verify" | "settle"): SettlementFailure {
    if (error instanceof RpcUnreachableBeforeBroadcast || error instanceof SettlementStorageUnavailable) return {outcome: "not_ready"};
    if (error instanceof SettlementPending) {
        return {outcome: "error", errorCode: SETTLEMENT_PENDING, transaction: error.transaction};
    }
    const rejected = (errorCode: string): SettlementFailure => ({outcome: "rejected", errorCode, transaction: ""});
    if (error instanceof PaymentValidationError) return rejected(error.reason);
    if (error instanceof SettlementBudgetExceeded) return rejected(error.errorCode);
    if (error instanceof RedemptionRejected || isRedemptionRevert(error)) return rejected(DELEGATION_REJECTED);
    return rejected(route === "verify" ? "unexpected_verify_error" : "unexpected_settle_error");
}

// ── /health ─────────────────────────────────────────────────────────────────────────

/**
 * Why the framework check failed, as a closed set. `/health` is public through the
 * tunnel, and the free text it used to carry (`redactForLog(error, 200)`) kept the RPC
 * hostname and viem's version banner — an oracle for anyone deciding what to attack.
 * The operator gets the redacted text in the log instead.
 */
export type FrameworkHealthError =
    | "framework_paused"
    | "owner_mismatch"
    | "rpc_unreachable"
    | "verification_failed";

/**
 * viem wraps a transport failure in `HttpRequestError` (or `TimeoutError`) and nests it
 * as the `cause` of whatever action was running, so the chain is walked. A rate-limit
 * answer that outlived the throttled transport's retries is the RPC refusing to answer,
 * which is the same thing from here — but that one is read from the error's text, and a
 * revert's text belongs to the contract: a delegation names its own caveat enforcers, so
 * a caller can make the simulation revert with "rate limit exceeded" and, until this
 * looked, was answered not-ready for a refusal — no ledger row, and an invitation to
 * retry. A `ContractFunctionRevertedError` anywhere in the chain is the RPC having
 * answered, whatever the reason says, and settles the question before the text is
 * consulted — as does viem's `ExecutionRevertedError`, the shape a revert takes when
 * the node reports it under a plain `-32000` instead of code `3`. {@link beforeBroadcast} asks the same question of the stage before the
 * broadcast on both routes: a transport death in there is no verdict on the delegation
 * either.
 */
export function isRpcUnreachable(error: unknown): boolean {
    for (const link of causeChain(error)) {
        if (link instanceof ContractFunctionRevertedError || link instanceof ExecutionRevertedError) {
            return false;
        }
        if (link instanceof HttpRequestError || link instanceof TimeoutError) return true;
    }
    return isRateLimitError(error);
}

/**
 * Map a `verifyFrameworkOperationalState` failure onto {@link FrameworkHealthError}.
 *
 * The verifier speaks in messages, not types. "active deployment admin identity
 * mismatch" is the artifact disagreeing with `FRAMEWORK_ADMIN_ADDRESS`; the live admin
 * state arrives as one of the three `assertFrameworkAdminActive` throws — "is paused",
 * "owner mismatch", "pending owner mismatch" — and the two owner cases are one code:
 * either way the manager is not under the admin the artifact names.
 */
export function classifyFrameworkError(error: unknown): FrameworkHealthError {
    if (isRpcUnreachable(error)) return "rpc_unreachable";
    const message = error instanceof Error ? error.message : "";
    if (/\bpaused\b/.test(message)) return "framework_paused";
    if (/owner mismatch|admin identity mismatch/.test(message)) return "owner_mismatch";
    return "verification_failed";
}

/**
 * `/health`'s `frameworkPaused`, from the classified failure rather than a live flag.
 * The verifier throws on the pause, so a check that passed proves `false` and a check
 * that failed returned no flag to read: the pause is known only through
 * {@link classifyFrameworkError}, and every other failure says nothing about it — `null`.
 * Before this the field was `null` for every failure, the pause included, and the one
 * state an operator pulls on purpose was the one the boolean never showed.
 */
export function frameworkPausedFrom(error: FrameworkHealthError | null): boolean | null {
    if (error === null) return false;
    return error === "framework_paused" ? true : null;
}

export interface CachedProbeOptions {
    ttlMs: number;
    /**
     * Whether a failed probe is the window's answer, or only the answer of the callers
     * that shared it. `/health`'s balance read says yes: the route has no rate limit, the
     * read is one `getBalance`, and under an outage a flood without a cached failure is
     * one probe per round trip, each queued ahead of the settlement whose receipt is
     * being awaited. The readiness gate says no: its probe is ten reads whose callers
     * are payments, and one timed-out read must not become five seconds of refusing
     * every seller — the next caller probes again, as the gate did before it was
     * generalised. The flood the gate is then open to is bounded by the rate limit, now
     * that the hosted shop's buyers are counted through it.
     */
    cacheFailures: boolean;
    clock?: () => number;
}

/**
 * One reading per window, shared by every caller that arrives while it is fresh or in
 * flight. The probe is what bounds the RPC work a flood of callers can cause: at most
 * one in flight, and at most one per window once it succeeded.
 */
export class CachedProbe<T> {
    #settled?: {until: number; outcome: {ok: true; value: T} | {ok: false; error: unknown}};
    #pending?: Promise<T>;
    readonly #ttlMs: number;
    readonly #cacheFailures: boolean;
    readonly #clock: () => number;

    constructor(
        private readonly probe: () => Promise<T>,
        options: CachedProbeOptions,
    ) {
        if (!Number.isInteger(options.ttlMs) || options.ttlMs < 1) {
            throw new Error("ttlMs must be a positive integer");
        }
        this.#ttlMs = options.ttlMs;
        this.#cacheFailures = options.cacheFailures;
        this.#clock = options.clock ?? Date.now;
    }

    /** Seed the cache with a reading taken elsewhere, so the first window issues no probe. */
    prime(value: T): void {
        this.#settled = {until: this.#clock() + this.#ttlMs, outcome: {ok: true, value}};
    }

    async read(): Promise<T> {
        const settled = this.#settled;
        if (settled && this.#clock() < settled.until) {
            if (settled.outcome.ok) return settled.outcome.value;
            throw settled.outcome.error;
        }
        this.#pending ??= this.#run();
        return this.#pending;
    }

    async #run(): Promise<T> {
        try {
            const value = await this.probe();
            this.#settled = {until: this.#clock() + this.#ttlMs, outcome: {ok: true, value}};
            return value;
        } catch (error) {
            if (this.#cacheFailures) {
                this.#settled = {until: this.#clock() + this.#ttlMs, outcome: {ok: false, error}};
            }
            throw error;
        } finally {
            this.#pending = undefined;
        }
    }
}
