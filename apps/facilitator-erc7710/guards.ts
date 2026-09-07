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
    type Erc7710SettleResponse,
    type Erc7710VerifyResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {MiddlewareHandler} from "hono";

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

