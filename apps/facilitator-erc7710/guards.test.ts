/**
 * The guards, proven without booting the facilitator: a Hono app around the limiter, an
 * in-memory store for the ledger, and a clock the test moves by hand wherever a window
 * matters.
 */
import {afterEach, describe, expect, test} from "bun:test";
import {FixedWindowLimiter} from "@mapae/delegation";
import {IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {Hono} from "hono";
import type {Address} from "viem";
import {RATE_WINDOW_MS, SETTLE_RATE_LIMITED, VERIFY_RATE_LIMITED, rateLimitByIp} from "./guards.js";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
// A UTC midnight, so a clock moved by a whole day lands exactly on the next window.
const NOW = 20 * 86_400_000;

const stores: MapaeStore[] = [];

function memoryStore(): MapaeStore {
    const store = openStore(IN_MEMORY);
    stores.push(store);
    return store;
}

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
});

/** A settable clock for the guards that take one. */
function clock(start: number) {
    let now = start;
    return {
        read: () => now,
        set(value: number) {
            now = value;
        },
    };
}

describe("rateLimitByIp", () => {
    const PUBLIC = {"cf-connecting-ip": "203.0.113.5", "content-type": "application/json"};

    /** `/settle` behind the limiter, answering `success: true` for anything that reaches it. */
    function settleApp(limit: number, now: () => number) {
        const limiter = new FixedWindowLimiter(limit, RATE_WINDOW_MS);
        const app = new Hono();
        app.use("/settle", rateLimitByIp(limiter, SETTLE_RATE_LIMITED, now));
        app.post("/settle", (c) => c.json({success: true}));
        return {app, limiter};
    }

    async function settle(app: Hono, headers: Record<string, string>) {
        const response = await app.request("/settle", {method: "POST", headers, body: "{}"});
        return {status: response.status, body: (await response.json()) as {success: boolean}};
    }

    test("a request without CF-Connecting-IP came over loopback and is never limited", async () => {
        const {app} = settleApp(1, () => NOW);
        for (let i = 0; i < 5; i += 1) {
            expect(await settle(app, {"content-type": "application/json"})).toEqual({
                status: 200,
                body: {success: true},
            });
        }
    });

    test("the (limit + 1)th request inside the window is refused as a 200 with a body", async () => {
        const {app} = settleApp(2, () => NOW);
        expect((await settle(app, PUBLIC)).body).toEqual({success: true});
        expect((await settle(app, PUBLIC)).body).toEqual({success: true});
        const refused = await settle(app, PUBLIC);
        // A 4xx here would reach the seller as "the answer was lost" — payment unknown —
        // for a request that was never read. The body is the claim; 200 is transport.
        expect(refused.status).toBe(200);
        expect(refused.body).toEqual(SETTLE_RATE_LIMITED);
        expect(SETTLE_RATE_LIMITED.errorReason).toBe("rate_limited");
    });

    test("/verify refuses with the verify shape", async () => {
        const limiter = new FixedWindowLimiter(1, RATE_WINDOW_MS);
        const app = new Hono();
        app.use("/verify", rateLimitByIp(limiter, VERIFY_RATE_LIMITED, () => NOW));
        app.post("/verify", (c) => c.json({isValid: true, payer: ALICE}));
        await app.request("/verify", {method: "POST", headers: PUBLIC, body: "{}"});
        const refused = await app.request("/verify", {method: "POST", headers: PUBLIC, body: "{}"});
        expect(refused.status).toBe(200);
        expect(await refused.json()).toEqual({isValid: false, invalidReason: "rate_limited"});
    });

    test("addresses are counted independently", async () => {
        const {app} = settleApp(1, () => NOW);
        expect((await settle(app, PUBLIC)).body).toEqual({success: true});
        expect((await settle(app, PUBLIC)).body).toEqual(SETTLE_RATE_LIMITED);
        const other = {...PUBLIC, "cf-connecting-ip": "198.51.100.7"};
        expect((await settle(app, other)).body).toEqual({success: true});
    });

    test("the window resets", async () => {
        const time = clock(NOW);
        const {app} = settleApp(1, time.read);
        expect((await settle(app, PUBLIC)).body).toEqual({success: true});
        time.set(NOW + RATE_WINDOW_MS - 1);
        expect((await settle(app, PUBLIC)).body).toEqual(SETTLE_RATE_LIMITED);
        time.set(NOW + RATE_WINDOW_MS);
        expect((await settle(app, PUBLIC)).body).toEqual({success: true});
    });

    test("expired windows are swept on the next request, so distinct addresses cannot grow the map", async () => {
        const time = clock(NOW);
        const {app, limiter} = settleApp(1, time.read);
        for (let i = 0; i < 40; i += 1) {
            await settle(app, {...PUBLIC, "cf-connecting-ip": `203.0.113.${i}`});
        }
        expect(limiter.size).toBe(40);
        time.set(NOW + RATE_WINDOW_MS);
        await settle(app, PUBLIC);
        expect(limiter.size).toBe(1);
    });

    test("a refused request never reaches the handler, so it reads no body and writes no ledger row", async () => {
        const store = memoryStore();
        const limiter = new FixedWindowLimiter(1, RATE_WINDOW_MS);
        const app = new Hono();
        app.use("/settle", rateLimitByIp(limiter, SETTLE_RATE_LIMITED, () => NOW));
        // What the coordinator does for every attempt that reaches it, refused or not:
        // read the body, record the attempt. The handler is the only reader of the body.
        let reached = 0;
        app.post("/settle", async (c) => {
            reached += 1;
            await c.req.text();
            store.ledger.record({
                kind: "settle",
                at: NOW,
                payer: ALICE,
                payTo: SHOP,
                amountBase: 1n,
                outcome: "rejected",
                errorCode: "delegation_rejected",
            });
            return c.json({success: false});
        });

        await settle(app, PUBLIC);
        expect(reached).toBe(1);
        expect(store.ledger.summary({sinceMs: 0}).total).toBe(1);

        expect((await settle(app, PUBLIC)).body).toEqual(SETTLE_RATE_LIMITED);
        expect(reached).toBe(1);
        expect(store.ledger.summary({sinceMs: 0}).total).toBe(1);
    });
});

