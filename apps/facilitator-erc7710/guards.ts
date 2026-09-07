/**
 * The guards in front of the facilitator's routes — every decision about a request that
 * is taken *before* the chain is touched, or that decides whether it is touched at all.
 *
 * `index.ts` boots against a signer, two artifacts and a live RPC, so no test can import
 * it. The decisions live here, where they are provable with a `Map` and a clock, and
 * `index.ts` only wires them into Hono.
 */
import {
    FixedWindowLimiter,
    SpendBudget,
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {Budget} from "@mapae/store";
import type {MiddlewareHandler} from "hono";
import type {Address} from "viem";

// ── Per-IP rate limit ──────────────────────────────────────────────────────────────

export const RATE_LIMITED = "rate_limited";
export const RATE_WINDOW_MS = 3_600_000;

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
 * Refuse the (limit + 1)th request from one address within the window, before the body
 * is read and before anything is enqueued toward the RPC — so a flood costs a Map lookup
 * and nothing else. Until this existed the only bound on an anonymous caller was the
 * day's gas budget: 1,500 self-paid redemptions with free testnet tUSDC, and every other
 * seller got `budget_exhausted` until UTC midnight.
 *
 * Cloudflare sets `CF-Connecting-IP` on everything that comes through the tunnel, and the
 * tunnel is the only public path; a request without the header came over loopback (the
 * hosted shop on the same machine calls 127.0.0.1:8081 directly) and is exempt.
 */
export function rateLimitByIp(
    limiter: FixedWindowLimiter,
    refusal: Erc7710VerifyResponse | Erc7710SettleResponse,
    clock: () => number = Date.now,
): MiddlewareHandler {
    return async (c, next) => {
        const ip = c.req.header("cf-connecting-ip");
        if (ip === undefined) return next();
        const now = clock();
        limiter.sweep(now);
        if (!limiter.tryConsume(`ip:${ip}`, now)) return c.json(refusal);
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

export type BudgetExhaustedCode = "budget_exhausted" | "payer_budget_exhausted";

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

