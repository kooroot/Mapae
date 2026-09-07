/**
 * The guards in front of the facilitator's routes — every decision about a request that
 * is taken *before* the chain is touched, or that decides whether it is touched at all.
 *
 * `index.ts` boots against a signer, two artifacts and a live RPC, so no test can import
 * it. The decisions live here, where they are provable with a `Map` and a clock, and
 * `index.ts` only wires them into Hono.
 */
import {
    CLIENT_IP_HEADER,
    FACILITATOR_NOT_READY,
    FixedWindowLimiter,
    RATE_LIMITED,
    SpendBudget,
    ipBucket,
    isRateLimitError,
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {Budget} from "@mapae/store";
import type {MiddlewareHandler} from "hono";
import {HttpRequestError, TimeoutError, type Address} from "viem";

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
    body: {success: false, network: GIWA_SEPOLIA_CAIP2, errorReason: FACILITATOR_NOT_READY},
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

/** How long a payer's budget stays in memory after its last redemption. */
export const PAYER_IDLE_MS = 24 * 3_600_000;

/**
 * One `SpendBudget` per payer, created on first sight and persisted through its own
 * series in the store (`payer:<address>`), beside the `total` series the day's ceiling
 * uses. A restart resumes each share as faithfully as it resumes the total.
 *
 * Entries idle for a full day are swept: a payer's budget is a day's number, so after
 * 24 h without a redemption nothing in memory is worth keeping, and a stream of
 * distinct payers must not grow the map without bound. Nothing is lost by evicting —
 * the next sight reloads the day's spend from the store.
 */
export class PayerBudgets {
    readonly #entries = new Map<string, {budget: SpendBudget; touchedAt: number}>();

    constructor(
        private readonly dailyLimitWei: bigint,
        private readonly series: Pick<Budget, "scoped">,
    ) {
        if (dailyLimitWei <= 0n) throw new Error("dailyLimitWei must be positive");
    }

    for(payer: Address, now: number): SpendBudget {
        const key = payer.toLowerCase();
        let entry = this.#entries.get(key);
        if (!entry) {
            entry = {
                budget: new SpendBudget(this.dailyLimitWei, now, this.series.scoped(`payer:${key}`)),
                touchedAt: now,
            };
            this.#entries.set(key, entry);
        }
        entry.touchedAt = now;
        return entry.budget;
    }

    sweep(now: number): void {
        const cutoff = now - PAYER_IDLE_MS;
        for (const [key, entry] of this.#entries) {
            if (entry.touchedAt <= cutoff) this.#entries.delete(key);
        }
    }

    get size(): number {
        return this.#entries.size;
    }
}

type BudgetExhaustedCode = "budget_exhausted" | "payer_budget_exhausted";

/**
 * Raised when a redemption has no room in the day's gas budget — the payer's share of it
 * or the whole of it. Nothing was broadcast and nobody was charged: a rejection like a
 * simulation revert, but with its own code so the operator can tell "the payer's grant
 * is bad" from "our wallet is done for the day" in the ledger, and the seller can tell
 * the buyer to try again later. The two codes are the same outcome; `payer_budget_
 * exhausted` says the day still has room for everybody else.
 */
export class BudgetExhausted extends Error {
    constructor(readonly errorCode: BudgetExhaustedCode) {
        super(
            errorCode === "payer_budget_exhausted"
                ? "payer's daily gas share exhausted"
                : "relayer daily gas budget exhausted",
        );
        this.name = "BudgetExhausted";
    }
}

/** Two reservations that must be released together. */
export interface GasHold {
    readonly amount: bigint;
    /** Charge `charged` to both budgets and release both holds. Exactly once, from a `finally`. */
    settle(charged: bigint, now: number): void;
}

/**
 * The relayer's gas as two ceilings that are reserved together: the payer's daily share
 * first, then the day's total. The share is what stops one payer with a valid grant from
 * spending the whole day — before it, every redemption was charged to a single global
 * figure, so one self-paying attacker locked every other seller out until UTC midnight.
 *
 * The share is asked first because its refusal is the cheaper one: it says nothing about
 * the day. When the total refuses after the share admitted, the share's hold is released
 * with a charge of `0n` so a refused redemption does not shrink the payer's day either.
 */
export class GasBudgets {
    constructor(
        private readonly total: SpendBudget,
        private readonly payers: PayerBudgets,
    ) {}

    reserve(payer: Address, amount: bigint, now: number): GasHold {
        this.payers.sweep(now);
        const share = this.payers.for(payer, now);
        const shareHold = share.reserve(amount, now);
        if (!shareHold) throw new BudgetExhausted("payer_budget_exhausted");
        const totalHold = this.total.reserve(amount, now);
        if (!totalHold) {
            share.settle(shareHold, 0n, now);
            throw new BudgetExhausted("budget_exhausted");
        }
        const total = this.total;
        return {
            amount,
            settle(charged, at) {
                // `SpendBudget.settle` throws on a non-bigint charge after charging the
                // reservation; the `finally` keeps the second hold from being stranded
                // by the first one's guard.
                try {
                    total.settle(totalHold, charged, at);
                } finally {
                    share.settle(shareHold, charged, at);
                }
            },
        };
    }
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
 * which is the same thing from here.
 */
function isRpcUnreachable(error: unknown): boolean {
    if (isRateLimitError(error)) return true;
    let current: unknown = error;
    let depth = 0;
    while (current instanceof Error && depth < 8) {
        if (current instanceof HttpRequestError || current instanceof TimeoutError) return true;
        current = current.cause;
        depth += 1;
    }
    return false;
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
