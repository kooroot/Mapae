import {Hono, type Context} from "hono";
import type {Address, Hex} from "viem";
import {GIWA_SEPOLIA_CAIP2, redactForLog} from "@mapae/shared";
import {SETTLEMENT_UNCONFIRMED, type Erc7710SettleResponse} from "@mapae/delegation";
import {describeFailure, SETTLE_NOT_READY, VERIFY_NOT_READY, SettlementUnconfirmed} from "./guards.js";

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
            if (describeFailure(error).outcome === "not_ready") return c.json(VERIFY_NOT_READY.body, VERIFY_NOT_READY.status);
            // The seller preserves this explicit unknown as 504, even at verification.
            if (error instanceof SettlementUnconfirmed) return c.json({isValid: false, invalidReason: SETTLEMENT_UNCONFIRMED});
            return c.json({isValid: false, invalidReason: "delegation_rejected"});
        }
    });
    app.post("/settle", async (c) => {
        try {
            const payment = service.validate(await readJson(c));
            const result = await service.settle(payment);
            console.log(`[settle] intent=${payment.paymentIntentId} success=${result.success} tx=${result.transaction ?? "none"}`);
            return c.json(result);
        } catch (error) {
            console.error(`[settle] failed — ${redactForLog(error)}`);
            const failure = describeFailure(error);
            if (failure.outcome === "not_ready") return c.json(SETTLE_NOT_READY.body, SETTLE_NOT_READY.status);
            return c.json({success: false, network: GIWA_SEPOLIA_CAIP2,
                transaction: failure.transaction ?? undefined, errorReason: failure.errorCode});
        }
    });
    return app;
}
async function readJson(c: Context): Promise<unknown> {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("content-type must be JSON");
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > 150000) throw new Error("request body too large");
    const text = await c.req.text();
    if (!text.length || text.length > 150000) throw new Error("request body empty or too large");
    return JSON.parse(text) as unknown;
}
