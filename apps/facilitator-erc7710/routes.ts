import {Hono, type Context} from "hono";
import type {Address, Hex} from "viem";
import {GIWA_SEPOLIA_CAIP2, redactForLog} from "@mapae/shared";
import {PaymentValidationError, type Erc7710SettleResponse} from "@mapae/delegation";
import {describeFailure, SETTLE_NOT_READY, VERIFY_NOT_READY} from "./guards.js";

/** Shared by production and the hermetic HTTP/Anvil harness; policy validation is mandatory. */
export function createPaymentRoutes<P extends {payer: Address; paymentIntentId: Hex}>(service: {
    validate: (body: unknown) => P;
    simulate: (payment: P) => Promise<void>;
    settle: (payment: P) => Promise<Erc7710SettleResponse>;
}): Hono {
    const app = new Hono();
    app.post("/verify", async (c) => {
        try {
            const payment = service.validate(await readJson(c));
            await service.simulate(payment);
            return c.json({isValid: true, payer: payment.payer});
        } catch (error) {
            console.error(`[verify] failed — ${redactForLog(error)}`);
            const failure = describeFailure(error, "verify");
            // Only a rejection is copied onto the wire. `/verify` broadcasts nothing, so
            // it has no producer of a pending hash — and were one to appear, the §9 word
            // would go out without the transaction x402 v2 binds it to, and the seller
            // would read it as a refused delegation: "nobody was charged", asserted about
            // a payment in doubt. Not-ready says nothing about the payment, which is all
            // this route knows in either case.
            if (failure.outcome !== "rejected") return c.json(VERIFY_NOT_READY.body, VERIFY_NOT_READY.status);
            return c.json({isValid: false, invalidReason: failure.errorCode});
        }
    });
    app.post("/settle", async (c) => {
        try {
            const payment = service.validate(await readJson(c));
            const result = await service.settle(payment);
            console.log(`[settle] intent=${payment.paymentIntentId} success=${result.success} tx=${result.transaction || "none"}`);
            return c.json(result);
        } catch (error) {
            console.error(`[settle] failed — ${redactForLog(error)}`);
            const failure = describeFailure(error, "settle");
            if (failure.outcome === "not_ready") return c.json(SETTLE_NOT_READY.body, SETTLE_NOT_READY.status);
            // `transaction` is always present on the wire: the pending hash, or "" for a
            // rejection that broadcast nothing.
            return c.json({success: false, network: GIWA_SEPOLIA_CAIP2,
                transaction: failure.transaction, errorReason: failure.errorCode});
        }
    });
    return app;
}

/**
 * A body that cannot be read is `invalid_payload` (x402 §9), answered as a 200 with the
 * route's refusal shape like every other refusal: a 4xx from `/settle` would reach the
 * seller as "the answer was lost" for a request that was never parsed.
 */
async function readJson(c: Context): Promise<unknown> {
    const invalid = (message: string) => new PaymentValidationError("invalid_payload", message);
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) throw invalid("content-type must be JSON");
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > 150000) throw invalid("request body too large");
    const text = await c.req.text();
    if (!text.length || text.length > 150000) throw invalid("request body empty or too large");
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw invalid("request body is not JSON");
    }
}
