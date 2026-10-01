import {describe, expect, test} from "bun:test";
import {openStore} from "@mapae/store";
import {openArcadeStore} from "@mapae/store/arcade";
import {createPayments} from "./payments.js";
import {createSimulation} from "./simulation.js";
import {createArcadeApp} from "./app.js";
import {createModel, modelConfig} from "./model.js";

async function fixture(behavior: "settle" | "unknown" | "reject" = "settle") {
    const store = openStore(":memory:"), admissions = openArcadeStore(":memory:");
    const options = await createSimulation(store, behavior);
    const payments = createPayments(store, admissions, options);
    const app = createArcadeApp(createModel(modelConfig({}), admissions), payments);
    return {store, admissions, options, payments, app, close() {store.close(); admissions.close();}};
}
describe("Mapae admission integration", () => {
    test("402 → signed delegated leaf → seller settlement → journal → one recoverable consumable ticket", async () => {
        const f = await fixture();
        try {
            const requestId = crypto.randomUUID();
            const result = await f.payments.buy("race", requestId);
            expect(result.source).toBe("mapae-simulation");
            expect(result.ticket.status).toBe("ready");
            expect(result.ticket.amount).toBe("1.00");
            expect(result.ticket.unit).toBe("mUSDC");
            const orders = f.store.orders.listBySeller("mapae-arcade");
            expect(orders).toHaveLength(1);
            const journal = f.store.settlements.get(orders[0]!.paymentIntentId);
            expect(journal?.terminal?.outcome).toBe("settled");
            expect(journal?.amountBase).toBe(1_000_000n);
            // Throw away the first answer: replay the request using a fresh coordinator, as after a server restart.
            const restarted = createPayments(f.store, f.admissions, f.options);
            expect(await restarted.buy("race", requestId)).toEqual(result);
            expect(f.store.orders.listBySeller("mapae-arcade")).toHaveLength(1);
            const runId = crypto.randomUUID();
            const consumed = restarted.consume(result.ticket.id, runId);
            expect(consumed.ticket.status).toBe("consumed");
            expect(restarted.consume(result.ticket.id, runId)).toEqual(consumed);
            expect(() => restarted.consume(result.ticket.id, crypto.randomUUID())).toThrow("ticket_already_consumed");
            await expect(restarted.buy("stamp", requestId)).rejects.toThrow("request_conflict");
        } finally {f.close();}
    });
    test("unknown settlement is a durable stop: no admission and no fresh charge", async () => {
        const f = await fixture("unknown");
        try {
            const requestId = crypto.randomUUID();
            await expect(f.payments.buy("shop", requestId)).rejects.toMatchObject({code: "payment_unresolved"});
            await expect(f.payments.buy("shop", requestId)).rejects.toMatchObject({code: "payment_unresolved"});
            await expect(f.payments.buy("shop", crypto.randomUUID())).rejects.toThrow("unresolved_payment");
            expect(f.store.orders.listBySeller("mapae-arcade")).toHaveLength(0);
        } finally {f.close();}
    });
    test("rejected settlement never grants admission", async () => {
        const f = await fixture("reject");
        try {
            const requestId = crypto.randomUUID();
            await expect(f.payments.buy("stamp", requestId)).rejects.toMatchObject({code: "payment_rejected"});
            await expect(f.payments.buy("stamp", requestId)).rejects.toMatchObject({code: "payment_rejected"});
            expect(f.store.orders.listBySeller("mapae-arcade")).toHaveLength(0);
        } finally {f.close();}
    });
    test("a confirmed journal recovers delivery after a crash before the seller wrote its order", async () => {
        const f = await fixture("unknown");
        try {
            const requestId = crypto.randomUUID();
            await expect(f.payments.buy("race", requestId)).rejects.toMatchObject({code: "payment_unresolved"});
            const ticket = f.admissions.reserve(requestId, "race").admission;
            f.store.settlements.finish(ticket.intent as `0x${string}`, {at: Date.now(), gasUsed: 1n, actualCost: 1n});
            const recovered = await f.payments.buy("race", requestId);
            expect(recovered.ticket.status).toBe("ready");
            expect(f.store.orders.listBySeller("mapae-arcade")).toHaveLength(1);
        } finally {f.close();}
    });
    test("payments stay disabled without an explicit local mode", async () => {
        const store = openStore(":memory:"), admissions = openArcadeStore(":memory:");
        try {
            const service = createPayments(store, admissions);
            expect(service.status().mode).toBe("disabled");
            expect(service.status().broadcastEnabled).toBe(false);
            await expect(service.buy("race", crypto.randomUUID())).rejects.toMatchObject({code: "payments_disabled"});
        } finally {store.close(); admissions.close();}
    });
    test("HTTP contract requires local origin, bounded JSON and disables model without credentials", async () => {
        const f = await fixture();
        try {
            expect((await f.app.request("/api/arcade/status")).status).toBe(200);
            expect((await f.app.request("http://evil.test/api/arcade/status")).status).toBe(403);
            expect((await f.app.request("/api/arcade/status", {headers: {"cf-connecting-ip": "203.0.113.1"}})).status).toBe(403);
            expect((await f.app.request("/api/arcade/status", {headers: {"x-forwarded-host": "arcade.example"}})).status).toBe(403);
            expect((await f.app.request("/api/arcade/status", {headers: {origin: "https://evil.test"}})).status).toBe(403);
            expect((await f.app.request("/api/arcade/tickets", {method: "POST", body: "{}"})).status).toBe(400);
            expect((await f.app.request("/api/arcade/tickets", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({padding: "x".repeat(20_000)})})).status).toBe(413);
            expect((await f.app.request("/api/arcade/tickets", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({game: "race", requestId: "bad"})})).status).toBe(400);
            const response = await f.app.request("/api/arcade/tickets", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({game: "race", requestId: crypto.randomUUID()})});
            expect(response.status).toBe(200);
            const result = await response.json();
            const consume = await f.app.request(`/api/arcade/tickets/${result.ticket.id}/consume`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({runId: crypto.randomUUID()})});
            expect(consume.status).toBe(200);
            expect(JSON.stringify(result)).not.toMatch(/permissionContext|privateKey|authorization/);
        } finally {f.close();}
    });
});
