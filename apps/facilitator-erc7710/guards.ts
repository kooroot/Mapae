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
    FixedWindowLimiter,
    SpendBudget,
    isRateLimitError,
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {Budget} from "@mapae/store";
import type {MiddlewareHandler} from "hono";
import {HttpRequestError, TimeoutError, type Address} from "viem";

// ── Per-IP rate limit ──────────────────────────────────────────────────────────────

const RATE_LIMITED = "rate_limited";
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
 * never read, let alone broadcast, must not be called that. `rate_limited` is not a code
 * the seller enumerates — `isValid !== true` and `success !== true` are the generic
 * "refused" readings on that side, and an unknown code degrades to them.
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
 * The window a client address is counted in. An IPv6 client is counted on its /64:
 * Cloudflare forwards the full 128-bit address, the smallest allocation a residential or
 * VPS line gets is a /64, and rotating through its 2^64 addresses would make every
 * request a fresh key that never reaches the limit. An IPv4 address is one client and is
 * kept whole — as is the IPv4-mapped spelling (`::ffff:a.b.c.d`), whose "/64" would be
 * the same four zero groups for every IPv4 client there is.
 */
export function limiterKey(ip: string): string {
    if (!ip.includes(":") || ip.includes(".")) return `ip:${ip}`;
    const [head = "", tail = ""] = ip.split("::");
    const leading = head === "" ? [] : head.split(":");
    const trailing = tail === "" ? [] : tail.split(":");
    const zeros = Math.max(0, 8 - leading.length - trailing.length);
    const prefix = [...leading, ...new Array<string>(zeros).fill("0"), ...trailing]
        .slice(0, 4)
        .map((group) => Number.parseInt(group, 16).toString(16));
    return `ip:${prefix.join(":")}::/64`;
}

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
        if (!limiter.tryConsume(limiterKey(ip), now)) return c.json(refusal);
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
 * state — owner, pending owner, paused — currently reaches here as one message,
 * "DelegationManager is not operationally active", which cannot say which of the three
 * it was and so classifies as `verification_failed`. `framework_paused` fires once the
 * verifier names the pause.
 */
export function classifyFrameworkError(error: unknown): FrameworkHealthError {
    if (isRpcUnreachable(error)) return "rpc_unreachable";
    const message = error instanceof Error ? error.message : "";
    if (/\bpaused\b/.test(message)) return "framework_paused";
    if (/owner mismatch|admin identity mismatch/.test(message)) return "owner_mismatch";
    return "verification_failed";
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
