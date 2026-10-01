import {Hono} from "hono";
import {AdmissionError, type ArcadeGame} from "@mapae/store/arcade";
import {ArcadeError, limitedJson, object, parseDecisionRequest, type createModel} from "./model.js";
import type {createPayments} from "./payments.js";

export function createArcadeApp(model: ReturnType<typeof createModel>, payments: ReturnType<typeof createPayments>) {
    const app = new Hono();
    app.use("*", async (c, next) => {
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
        // This service owns a shared development payer and model budget. A tunnel
        // must not accidentally turn it into an unauthenticated public service.
        if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname) ||
            c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-host")) {
            throw new ArcadeError("host_denied", 403, "This service is loopback-only.");
        }
        const origin = c.req.header("origin");
        if (origin) {
            let allowed = false;
            try {const u = new URL(origin); allowed = u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);} catch { /* Reject malformed origins. */ }
            if (!allowed) throw new ArcadeError("origin_denied", 403, "Only the local Arcade browser is permitted.");
        }
        if (c.req.method === "POST" && c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
            throw new ArcadeError("json_required", 400, "Send application/json.");
        }
        await next();
    });
    app.get("/api/arcade/status", (c) => c.json({model: model.status(), payments: payments.status()}));
    async function body(request: Request): Promise<unknown> {
        try {return await limitedJson(new Response(request.body), 16_384);}
        catch (error) {
            if (error instanceof ArcadeError && error.code === "response_too_large") throw new ArcadeError("request_too_large", 413, "The request is too large.");
            throw new ArcadeError("invalid_json", 400, "The request body must be JSON.");
        }
    }
    app.post("/api/arcade/decide", async (c) => c.json(await model.decide(parseDecisionRequest(await body(c.req.raw)), c.req.raw.signal)));
    app.post("/api/arcade/tickets", async (c) => {
        const input = await body(c.req.raw);
        if (!object(input) || !["stamp", "race", "shop"].includes(String(input.game)) || typeof input.requestId !== "string" ||
            Object.keys(input).some((key) => !["game", "requestId"].includes(key))) throw new ArcadeError("invalid_ticket_request", 400, "A game and unique requestId are required.");
        return c.json(await payments.buy(input.game as ArcadeGame, input.requestId));
    });
    app.get("/api/arcade/tickets/:id", (c) => c.json(payments.get(c.req.param("id"))));
    app.post("/api/arcade/tickets/:id/consume", async (c) => {
        const input = await body(c.req.raw);
        if (!object(input) || typeof input.runId !== "string" || Object.keys(input).length !== 1) throw new ArcadeError("invalid_run", 400, "A unique runId is required.");
        return c.json(payments.consume(c.req.param("id"), input.runId));
    });
    app.onError((error, c) => {
        if (error instanceof ArcadeError) return c.json({error: {code: error.code, message: error.message}}, error.status);
        if (error instanceof AdmissionError) return c.json({error: {code: error.code, message: "The admission request conflicts with its stored ticket state."}}, error.code.startsWith("invalid") ? 400 : 409);
        return c.json({error: {code: "internal_error", message: "The request could not be completed. No automatic retry was made."}}, 500);
    });
    return app;
}
