/**
 * The guards, proven without booting the facilitator: a Hono app around the limiter, an
 * in-memory store under the payer budgets, hand-built errors for the classifier, and a
 * clock the test moves by hand wherever a window matters.
 */
import {afterEach, describe, expect, test} from "bun:test";
import {FixedWindowLimiter, SpendBudget, budgetDay} from "@mapae/delegation";
import {IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {Hono} from "hono";
import {HttpRequestError, TimeoutError, type Address} from "viem";
import {
    BudgetExhausted,
    CLIENT_IP_HEADER,
    CachedProbe,
    GasBudgets,
    PAYER_IDLE_MS,
    PayerBudgets,
    RATE_WINDOW_MS,
    SETTLE_RATE_LIMITED,
    SWEEP_EVERY,
    VERIFY_RATE_LIMITED,
    classifyFrameworkError,
    limiterKey,
    rateLimitByIp,
} from "./guards.js";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const CAROL = "0x3333333333333333333333333333333333333333" as Address;
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

    test("a loopback caller naming the buyer in X-Mapae-Client-IP is counted as that buyer", async () => {
        const {app} = settleApp(1, () => NOW);
        const buyer = {"content-type": "application/json", [CLIENT_IP_HEADER]: "203.0.113.9"};
        expect((await settle(app, buyer)).body).toEqual({success: true});
        expect((await settle(app, buyer)).body).toEqual(SETTLE_RATE_LIMITED);
        const other = {...buyer, [CLIENT_IP_HEADER]: "198.51.100.7"};
        expect((await settle(app, other)).body).toEqual({success: true});
    });

    test("through the tunnel CF-Connecting-IP is the client; a forwarded name beside it is ignored", async () => {
        const {app} = settleApp(1, () => NOW);
        const both = {...PUBLIC, [CLIENT_IP_HEADER]: "198.51.100.7"};
        expect((await settle(app, both)).body).toEqual({success: true});
        expect((await settle(app, PUBLIC)).body).toEqual(SETTLE_RATE_LIMITED);
        const forwardedOnly = {"content-type": "application/json", [CLIENT_IP_HEADER]: "198.51.100.7"};
        expect((await settle(app, forwardedOnly)).body).toEqual({success: true});
    });

    test("IPv6 clients inside one /64 share a window", async () => {
        const {app} = settleApp(1, () => NOW);
        const first = {...PUBLIC, "cf-connecting-ip": "2001:db8:1:2::1"};
        const rotated = {...PUBLIC, "cf-connecting-ip": "2001:db8:1:2:ffff:ffff:ffff:ffff"};
        const elsewhere = {...PUBLIC, "cf-connecting-ip": "2001:db8:1:3::1"};
        expect((await settle(app, first)).body).toEqual({success: true});
        expect((await settle(app, rotated)).body).toEqual(SETTLE_RATE_LIMITED);
        expect((await settle(app, elsewhere)).body).toEqual({success: true});
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

    test("expired windows are swept every SWEEP_EVERY requests, so distinct addresses cannot grow the map", async () => {
        const time = clock(NOW);
        const {app, limiter} = settleApp(1, time.read);
        for (let i = 0; i < 40; i += 1) {
            await settle(app, {...PUBLIC, "cf-connecting-ip": `203.0.113.${i}`});
        }
        expect(limiter.size).toBe(40);
        time.set(NOW + RATE_WINDOW_MS);
        // PUBLIC is 203.0.113.5, one of the forty; its next request re-opens its own
        // window and leaves the other 39 expired until the sweep lands.
        for (let counted = 40; counted < SWEEP_EVERY - 1; counted += 1) await settle(app, PUBLIC);
        expect(limiter.size).toBe(40);
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

describe("limiterKey", () => {
    test("an IPv4 address is one client", () => {
        expect(limiterKey("203.0.113.5")).toBe("ip:203.0.113.5");
        expect(limiterKey("::ffff:203.0.113.5")).toBe("ip:::ffff:203.0.113.5");
    });

    test("an IPv6 address is its /64, however it was spelled", () => {
        expect(limiterKey("2001:0db8:0001:0002:0003:0004:0005:0006")).toBe("ip:2001:db8:1:2::/64");
        expect(limiterKey("2001:db8:1:2::1")).toBe("ip:2001:db8:1:2::/64");
        expect(limiterKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("ip:2001:db8:1:2::/64");
        expect(limiterKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
        expect(limiterKey("::1")).toBe("ip:0:0:0:0::/64");
        expect(limiterKey("2001:db8:1:2:3::")).toBe("ip:2001:db8:1:2::/64");
        expect(limiterKey("2001:db8:1:3::1")).not.toBe(limiterKey("2001:db8:1:2::1"));
    });
});

describe("PayerBudgets", () => {
    test("each payer gets its own share of the day", () => {
        const payers = new PayerBudgets(100n, memoryStore().budget);
        expect(payers.for(ALICE, NOW).reserve(100n, NOW)).toBeDefined();
        expect(payers.for(ALICE, NOW).reserve(1n, NOW)).toBeUndefined();
        expect(payers.for(BOB, NOW).reserve(100n, NOW)).toBeDefined();
        expect(payers.size).toBe(2);
    });

    test("the share is keyed on the address, whichever case it was spelled in", () => {
        const payers = new PayerBudgets(100n, memoryStore().budget);
        const upper = ALICE.toUpperCase().replace("0X", "0x") as Address;
        expect(payers.for(upper, NOW)).toBe(payers.for(ALICE, NOW));
        expect(payers.size).toBe(1);
    });

    test("a share survives a re-created registry over the same store, in its own series", () => {
        const store = memoryStore();
        const first = new PayerBudgets(100n, store.budget);
        const budget = first.for(ALICE, NOW);
        const hold = budget.reserve(60n, NOW);
        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, 60n, NOW);

        const second = new PayerBudgets(100n, store.budget);
        expect(second.for(ALICE, NOW).spentToday(NOW)).toBe(60n);
        expect(second.for(ALICE, NOW).remaining(NOW)).toBe(40n);
        expect(second.for(ALICE, NOW).reserve(41n, NOW)).toBeUndefined();
        // Another payer starts the day whole, and the day's total series was never touched.
        expect(second.for(BOB, NOW).remaining(NOW)).toBe(100n);
        expect(store.budget.load(budgetDay(NOW))).toBe(0n);
        expect(store.budget.scoped(`payer:${ALICE}`).load(budgetDay(NOW))).toBe(60n);
    });

    test("a payer idle for a day is evicted, and its next sight reloads the share from the store", () => {
        const store = memoryStore();
        const payers = new PayerBudgets(100n, store.budget);
        const budget = payers.for(ALICE, NOW);
        const hold = budget.reserve(60n, NOW);
        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, 60n, NOW);
        payers.for(BOB, NOW + 1);

        payers.sweep(NOW + PAYER_IDLE_MS - 1);
        expect(payers.size).toBe(2);
        payers.sweep(NOW + PAYER_IDLE_MS);
        expect(payers.size).toBe(1);
        payers.sweep(NOW + PAYER_IDLE_MS + 1);
        expect(payers.size).toBe(0);

        const revived = payers.for(ALICE, NOW);
        expect(revived).not.toBe(budget);
        expect(revived.spentToday(NOW)).toBe(60n);
    });

    test("refuses a share that could admit nothing", () => {
        expect(() => new PayerBudgets(0n, memoryStore().budget)).toThrow("positive");
    });
});

describe("GasBudgets", () => {
    function gasBudgets(totalWei: bigint, shareWei: bigint) {
        const store = memoryStore();
        const total = new SpendBudget(totalWei, NOW, store.budget);
        const payers = new PayerBudgets(shareWei, store.budget);
        return {total, payers, gas: new GasBudgets(total, payers)};
    }

    function refusal(run: () => unknown): BudgetExhausted {
        try {
            run();
        } catch (error) {
            if (error instanceof BudgetExhausted) return error;
            throw error;
        }
        throw new Error("expected BudgetExhausted");
    }

    test("the payer's share refuses first, and the day is left untouched", () => {
        const {total, payers, gas} = gasBudgets(1_000n, 100n);
        const refused = refusal(() => gas.reserve(ALICE, 101n, NOW));
        expect(refused.errorCode).toBe("payer_budget_exhausted");
        expect(refused.message).toContain("share");
        expect(total.remaining(NOW)).toBe(1_000n);
        expect(payers.for(ALICE, NOW).remaining(NOW)).toBe(100n);
    });

    test("when the day refuses after the share admitted, the share's hold is released uncharged", () => {
        const {total, payers, gas} = gasBudgets(150n, 100n);
        const alice = gas.reserve(ALICE, 100n, NOW);
        expect(alice.amount).toBe(100n);
        const refused = refusal(() => gas.reserve(BOB, 100n, NOW));
        expect(refused.errorCode).toBe("budget_exhausted");
        expect(refused.message).toContain("relayer");
        expect(payers.for(BOB, NOW).remaining(NOW)).toBe(100n);
        expect(payers.for(BOB, NOW).spentToday(NOW)).toBe(0n);
        expect(total.remaining(NOW)).toBe(50n);
    });

    test("settle charges both budgets the same amount and releases both holds", () => {
        const {total, payers, gas} = gasBudgets(1_000n, 100n);
        const hold = gas.reserve(ALICE, 100n, NOW);
        expect(total.remaining(NOW)).toBe(900n);
        expect(payers.for(ALICE, NOW).remaining(NOW)).toBe(0n);
        hold.settle(70n, NOW);
        expect(total.spentToday(NOW)).toBe(70n);
        expect(total.remaining(NOW)).toBe(930n);
        expect(payers.for(ALICE, NOW).spentToday(NOW)).toBe(70n);
        expect(payers.for(ALICE, NOW).remaining(NOW)).toBe(30n);
    });

    test("a settle of 0n is a rejection that shrinks neither day", () => {
        const {total, payers, gas} = gasBudgets(1_000n, 100n);
        gas.reserve(ALICE, 100n, NOW).settle(0n, NOW);
        expect(total.remaining(NOW)).toBe(1_000n);
        expect(payers.for(ALICE, NOW).remaining(NOW)).toBe(100n);
    });

    test("one payer cannot spend the day; the day still binds across payers", () => {
        const {gas} = gasBudgets(250n, 100n);
        gas.reserve(ALICE, 100n, NOW).settle(100n, NOW);
        expect(refusal(() => gas.reserve(ALICE, 1n, NOW)).errorCode).toBe("payer_budget_exhausted");
        gas.reserve(BOB, 100n, NOW).settle(100n, NOW);
        expect(refusal(() => gas.reserve(CAROL, 100n, NOW)).errorCode).toBe("budget_exhausted");
        expect(gas.reserve(CAROL, 50n, NOW).amount).toBe(50n);
    });

    test("reserving sweeps payers idle for a day", () => {
        const {payers, gas} = gasBudgets(1_000n, 100n);
        gas.reserve(ALICE, 1n, NOW).settle(1n, NOW);
        expect(payers.size).toBe(1);
        gas.reserve(BOB, 1n, NOW + PAYER_IDLE_MS).settle(1n, NOW + PAYER_IDLE_MS);
        expect(payers.size).toBe(1);
    });
});

describe("classifyFrameworkError", () => {
    const RPC = "https://rpc.example/very-secret-key";

    test("a transport failure anywhere in the cause chain is the RPC being unreachable", () => {
        const transport = new HttpRequestError({url: RPC, details: "fetch failed"});
        expect(classifyFrameworkError(transport)).toBe("rpc_unreachable");
        const wrapped = new Error("contract read failed", {cause: transport});
        expect(classifyFrameworkError(wrapped)).toBe("rpc_unreachable");
        expect(classifyFrameworkError(new TimeoutError({body: {}, url: RPC}))).toBe("rpc_unreachable");
    });

    test("a rate limit that outlived the transport's retries is the RPC refusing to answer", () => {
        expect(classifyFrameworkError(new Error("over rate limit"))).toBe("rpc_unreachable");
    });

    test("the artifact's admin disagreeing with the environment is an owner mismatch", () => {
        expect(classifyFrameworkError(new Error("active deployment admin identity mismatch"))).toBe(
            "owner_mismatch",
        );
        expect(classifyFrameworkError(new Error("DelegationManager owner mismatch"))).toBe("owner_mismatch");
        expect(classifyFrameworkError(new Error("DelegationManager pending owner mismatch"))).toBe(
            "owner_mismatch",
        );
    });

    test("a named pause is framework_paused", () => {
        expect(classifyFrameworkError(new Error("DelegationManager is paused"))).toBe("framework_paused");
    });

    test("everything the verifier cannot name more precisely is verification_failed", () => {
        // The live admin state — owner, pending owner, paused — reaches the classifier as
        // one message today, so it cannot be read as either of the two named codes.
        expect(classifyFrameworkError(new Error("DelegationManager is not operationally active"))).toBe(
            "verification_failed",
        );
        // NAME/VERSION disagreement, not an owner: "identity mismatch" alone must not match.
        expect(classifyFrameworkError(new Error("DelegationManager operational identity mismatch"))).toBe(
            "verification_failed",
        );
        expect(classifyFrameworkError(new Error("DelegationManager has no operational runtime"))).toBe(
            "verification_failed",
        );
        expect(classifyFrameworkError("not even an error")).toBe("verification_failed");
    });

    test("the answer is one of four words and never the message", () => {
        const answer = classifyFrameworkError(new HttpRequestError({url: RPC, details: "fetch failed"}));
        expect(["framework_paused", "owner_mismatch", "rpc_unreachable", "verification_failed"]).toContain(
            answer,
        );
        expect(answer).not.toContain("rpc.example");
        expect(answer).not.toContain("viem");
    });
});

describe("CachedProbe", () => {
    const TTL = 5_000;

    /** A probe whose completion the test controls, counting how often it was started. */
    function controlled<T>() {
        let calls = 0;
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const probe = () => {
            calls += 1;
            return new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
            });
        };
        return {
            probe,
            calls: () => calls,
            resolve: (value: T) => resolve(value),
            reject: (error: unknown) => reject(error),
        };
    }

    test("readers that arrive while a probe is in flight share it", async () => {
        const time = clock(NOW);
        const control = controlled<bigint>();
        const cached = new CachedProbe(control.probe, {ttlMs: TTL, cacheFailures: true, clock: time.read});
        const reads = Array.from({length: 10}, () => cached.read());
        expect(control.calls()).toBe(1);
        control.resolve(7n);
        expect(await Promise.all(reads)).toEqual(Array.from({length: 10}, () => 7n));
    });

    test("a value is served from the cache until the window ends, then probed again", async () => {
        const time = clock(NOW);
        let calls = 0;
        const cached = new CachedProbe(async () => (calls += 1), {ttlMs: TTL, cacheFailures: true, clock: time.read});
        expect(await cached.read()).toBe(1);
        time.set(NOW + TTL - 1);
        expect(await cached.read()).toBe(1);
        time.set(NOW + TTL);
        expect(await cached.read()).toBe(2);
        expect(calls).toBe(2);
    });

    test("with cacheFailures a failure is the window's answer, so a flood under an outage probes once", async () => {
        const time = clock(NOW);
        const outage = new Error("fetch failed");
        let calls = 0;
        const cached = new CachedProbe(async () => {
            calls += 1;
            throw outage;
        }, {ttlMs: TTL, cacheFailures: true, clock: time.read});
        for (let i = 0; i < 5; i += 1) {
            await expect(cached.read()).rejects.toBe(outage);
        }
        expect(calls).toBe(1);
        time.set(NOW + TTL);
        await expect(cached.read()).rejects.toBe(outage);
        expect(calls).toBe(2);
    });

    test("without cacheFailures a failure reaches only the callers that shared the probe, and the next one probes again", async () => {
        const time = clock(NOW);
        const control = controlled<number>();
        const cached = new CachedProbe(control.probe, {ttlMs: TTL, cacheFailures: false, clock: time.read});
        cached.prime(1);
        time.set(NOW + TTL);
        const outage = new Error("fetch failed");
        const sharing = [cached.read(), cached.read()];
        control.reject(outage);
        // `allSettled` attaches both handlers before any microtask runs. Awaiting the
        // reads one at a time drains the queue and leaves the second rejecting unhandled,
        // and `expect(read).rejects` attached beforehand spins the loop until it settles.
        const outcomes = await Promise.allSettled(sharing);
        expect(outcomes).toEqual([
            {status: "rejected", reason: outage},
            {status: "rejected", reason: outage},
        ]);
        expect(control.calls()).toBe(1);
        // The expired value is not resurrected, and the failure is not remembered.
        const retried = cached.read();
        expect(control.calls()).toBe(2);
        control.resolve(2);
        expect(await retried).toBe(2);
        expect(await cached.read()).toBe(2);
        expect(control.calls()).toBe(2);
    });

    test("prime seeds the first window from a reading taken elsewhere", async () => {
        const time = clock(NOW);
        let calls = 0;
        const cached = new CachedProbe(async () => (calls += 1), {ttlMs: TTL, cacheFailures: true, clock: time.read});
        cached.prime(99);
        expect(await cached.read()).toBe(99);
        expect(calls).toBe(0);
        time.set(NOW + TTL);
        expect(await cached.read()).toBe(1);
    });

    test("refuses a window that would cache nothing", () => {
        expect(() => new CachedProbe(async () => 1, {ttlMs: 0, cacheFailures: true})).toThrow("ttlMs");
    });
});
