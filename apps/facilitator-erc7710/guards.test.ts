/**
 * The guards, proven without booting the facilitator: a Hono app around the limiter, an
 * in-memory store under the payer budgets, hand-built errors for the classifier, and a
 * clock the test moves by hand wherever a window matters.
 */
import {afterEach, describe, expect, test} from "bun:test";
import {
    CLIENT_IP_HEADER,
    FACILITATOR_NOT_READY,
    FixedWindowLimiter,
    SETTLEMENT_UNCONFIRMED,
    assertFrameworkAdminActive,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2, redactForLog} from "@mapae/shared";
import {SettlementBudgetExceeded, IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {Hono} from "hono";
import {
    BaseError,
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    ExecutionRevertedError,
    HttpRequestError,
    RpcRequestError,
    TimeoutError,
    type Address,
    type Hex,
} from "viem";
import {
    CachedProbe,
    RATE_WINDOW_MS,
    RpcUnreachableBeforeBroadcast,
    SETTLE_NOT_READY,
    SETTLE_RATE_LIMITED,
    SWEEP_EVERY,
    SettlementUnconfirmed,
    VERIFY_NOT_READY,
    VERIFY_RATE_LIMITED,
    beforeBroadcast,
    classifyFrameworkError,
    describeFailure,
    isRpcUnreachable,
    frameworkPausedFrom,
    rateLimitByIp,
    requireReadiness,
} from "./guards.js";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
// A UTC midnight, so a clock moved by a whole day lands exactly on the next window.
const NOW = 20 * 86_400_000;

const BOB = "0x2222222222222222222222222222222222222222" as Address;
const stores: MapaeStore[] = [];
function memoryStore(): MapaeStore {const store = openStore(IN_MEMORY); stores.push(store); return store;}
afterEach(() => {for (const store of stores.splice(0)) store.close();});

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

const RPC = "https://rpc.example/very-secret-key";

/** Enough ABI for viem to format a failure of the redemption's entry point. */
const REDEEM_ABI = [
    {type: "function", name: "redeemDelegations", inputs: [], outputs: [], stateMutability: "nonpayable"},
] as const;

/** A simulation failure as viem raises it: its own wrapper over whatever the call died of. */
function simulationFailed(cause: BaseError): ContractFunctionExecutionError {
    return new ContractFunctionExecutionError(cause, {abi: REDEEM_ABI, functionName: "redeemDelegations"});
}

/** A revert with the reason the contract chose — a caveat enforcer's, so the caller's. */
function reverted(reason: string): ContractFunctionExecutionError {
    return simulationFailed(
        new ContractFunctionRevertedError({
            abi: REDEEM_ABI,
            functionName: "redeemDelegations",
            message: `execution reverted: ${reason}`,
        }),
    );
}

/** The two shapes of a rate limit that outlived the throttled transport's retries. */
const RATE_LIMITED_BY_HTTP = () => new HttpRequestError({url: RPC, status: 429, details: "over rate limit"});
const RATE_LIMITED_BY_RPC = () =>
    new RpcRequestError({body: {}, error: {code: -32016, message: "over rate limit"}, url: RPC});

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

describe("requireReadiness", () => {
    const HEADERS = {"cf-connecting-ip": "203.0.113.5", "content-type": "application/json"};

    /** Both routes behind the gate, over a probe the test can make fail or pass. */
    function gated(outcome: () => Promise<unknown>) {
        const readiness = new CachedProbe(outcome, {ttlMs: 5_000, cacheFailures: false});
        const app = new Hono();
        let reached = 0;
        app.use("/verify", requireReadiness(readiness, VERIFY_NOT_READY));
        app.use("/settle", requireReadiness(readiness, SETTLE_NOT_READY));
        app.post("/verify", async (c) => {
            reached += 1;
            await c.req.text();
            return c.json({isValid: true, payer: ALICE});
        });
        app.post("/settle", async (c) => {
            reached += 1;
            await c.req.text();
            return c.json({success: true});
        });
        const post = async (path: "/verify" | "/settle") => {
            const response = await app.request(path, {method: "POST", headers: HEADERS, body: "{}"});
            return {status: response.status, body: (await response.json()) as unknown};
        };
        return {post, reached: () => reached};
    }

    test("/verify answers a failed probe with a 503, which the seller reads as unavailable", async () => {
        const gate = gated(async () => {
            throw new Error("fetch failed");
        });
        expect(await gate.post("/verify")).toEqual({
            status: 503,
            body: {isValid: false, invalidReason: "facilitator_not_ready"},
        });
        expect(gate.reached()).toBe(0);
    });

    test("/settle answers a failed probe with a 200 body, since a non-2xx there is a payment in doubt", async () => {
        const gate = gated(async () => {
            throw new Error("fetch failed");
        });
        const refused = await gate.post("/settle");
        expect(refused.status).toBe(200);
        expect(refused.body).toEqual(SETTLE_NOT_READY.body);
        expect(SETTLE_NOT_READY.body.errorReason).toBe(FACILITATOR_NOT_READY);
        expect(gate.reached()).toBe(0);
    });

    test("neither answer is the rejection a formed verdict would carry", () => {
        expect(VERIFY_NOT_READY.body.invalidReason).not.toBe("delegation_rejected");
        expect(SETTLE_NOT_READY.body.errorReason).not.toBe("delegation_rejected");
        expect(FACILITATOR_NOT_READY).toBe("facilitator_not_ready");
    });

    test("a passing probe lets the handler read the body", async () => {
        const gate = gated(async () => ({owner: ALICE, paused: false}));
        expect(await gate.post("/verify")).toEqual({status: 200, body: {isValid: true, payer: ALICE}});
        expect(await gate.post("/settle")).toEqual({status: 200, body: {success: true}});
        expect(gate.reached()).toBe(2);
    });

    test("callers share the window's probe rather than each adding a read", async () => {
        let probes = 0;
        const gate = gated(async () => {
            probes += 1;
            return {};
        });
        await Promise.all([gate.post("/verify"), gate.post("/settle"), gate.post("/verify")]);
        expect(probes).toBe(1);
        expect(gate.reached()).toBe(3);
    });
});

describe("isRpcUnreachable", () => {
    test("a simulation that died on transport is the RPC not answering; a revert is a verdict", () => {
        const transport = new HttpRequestError({url: RPC, details: "fetch failed"});
        expect(isRpcUnreachable(new Error("simulation failed", {cause: transport}))).toBe(true);
        expect(isRpcUnreachable(new Error("execution reverted: caveat"))).toBe(false);
    });

    test("a revert is the RPC having answered, whatever its reason says — the reason is the caller's", () => {
        // A rate limit is recognised by its text, and a delegation names its own caveat
        // enforcers: a revert reading "rate limit exceeded" must not become a non-answer.
        expect(isRpcUnreachable(reverted("rate limit exceeded"))).toBe(false);
        expect(isRpcUnreachable(reverted("too many requests"))).toBe(false);
        // A node that reports the revert under a plain -32000 gives viem no revert data to
        // decode, so the chain carries an `ExecutionRevertedError` instead — still an answer.
        expect(
            isRpcUnreachable(
                simulationFailed(
                    new ExecutionRevertedError({message: "execution reverted: rate limit exceeded"}),
                ),
            ),
        ).toBe(false);
        // The real shapes still are: a 429 on the transport, or proxyd's JSON-RPC error
        // under a 200, both wrapped by the simulation that hit them.
        expect(isRpcUnreachable(simulationFailed(RATE_LIMITED_BY_HTTP()))).toBe(true);
        expect(isRpcUnreachable(simulationFailed(RATE_LIMITED_BY_RPC()))).toBe(true);
    });
});

describe("beforeBroadcast", () => {
    /** What the step's promise rejected with, or `undefined` when it resolved. */
    async function raised(step: () => Promise<unknown>): Promise<unknown> {
        return beforeBroadcast(step).then(
            () => undefined,
            (error: unknown) => error,
        );
    }

    test("a transport death inside the stage is raised as RpcUnreachableBeforeBroadcast, cause kept", async () => {
        const transport = new HttpRequestError({url: RPC, details: "fetch failed"});
        // As viem raises it from a contract simulation: its own error over the transport
        // one, composing the cause's details into its message.
        const simulation = new BaseError("simulation failed", {cause: transport});
        const error = await raised(async () => {
            throw simulation;
        });
        expect(error).toBeInstanceOf(RpcUnreachableBeforeBroadcast);
        // The operator's line is written from the cause, so the cause is what says what
        // died; the wrapper's own message stays a constant and adds nothing to redact.
        expect((error as Error).cause).toBe(simulation);
        expect(redactForLog((error as Error).cause)).toContain("fetch failed");
        expect((error as Error).message).toBe("RPC stopped answering before the redemption was broadcast");
    });

    test("a bare transport error — the fee estimate's shape — keeps the host and drops the key", async () => {
        const error = await raised(async () => {
            throw new HttpRequestError({url: RPC, details: "fetch failed"});
        });
        expect(error).toBeInstanceOf(RpcUnreachableBeforeBroadcast);
        const line = redactForLog((error as Error).cause);
        expect(line).toContain("https://rpc.example/<redacted>");
        expect(line).not.toContain("very-secret-key");
    });

    test("a timeout and a rate limit that outlived the retries are the same non-answer", async () => {
        const timeout = await raised(async () => {
            throw new TimeoutError({body: {}, url: RPC});
        });
        expect(timeout).toBeInstanceOf(RpcUnreachableBeforeBroadcast);
        const limitedByHttp = await raised(async () => {
            throw simulationFailed(RATE_LIMITED_BY_HTTP());
        });
        expect(limitedByHttp).toBeInstanceOf(RpcUnreachableBeforeBroadcast);
        const limitedByRpc = await raised(async () => {
            throw simulationFailed(RATE_LIMITED_BY_RPC());
        });
        expect(limitedByRpc).toBeInstanceOf(RpcUnreachableBeforeBroadcast);
    });

    test("a revert whose reason claims a rate limit is still the verdict: through untouched, a rejected row", async () => {
        // The reason string is the contract's, and the caller chose the contract. A
        // refusal that could talk its way into the not-ready answer would leave no ledger
        // row and send the buyer to retry — the exact pair the not-ready path exists to
        // avoid for a genuine non-answer.
        const revert = reverted("rate limit exceeded");
        await expect(
            beforeBroadcast(async () => {
                throw revert;
            }),
        ).rejects.toBe(revert);
        expect(describeFailure(revert)).toEqual({
            outcome: "rejected",
            errorCode: "delegation_rejected",
            transaction: null,
        });
    });

    test("a revert or the gas cap from the same stage passes through untouched — it is the verdict", async () => {
        const revert = new Error("execution reverted: ERC20TransferAmountEnforcer:allowance-exceeded");
        await expect(
            beforeBroadcast(async () => {
                throw revert;
            }),
        ).rejects.toBe(revert);
        const capped = new Error("redemption gas 2000000 exceeds configured cap");
        await expect(
            beforeBroadcast(async () => {
                throw capped;
            }),
        ).rejects.toBe(capped);
    });

    test("a step that answers is returned as is", async () => {
        expect(await beforeBroadcast(async () => ({gas: 333_523n}))).toEqual({gas: 333_523n});
    });
});

describe("describeFailure", () => {
    const HASH = `0x${"c".repeat(64)}` as Hex;

    test("the RPC dying before the broadcast is no verdict: the not-ready answer, and no ledger row", () => {
        const transport = new HttpRequestError({url: RPC, details: "fetch failed"});
        const failure = describeFailure(
            new RpcUnreachableBeforeBroadcast(new Error("simulation failed", {cause: transport})),
        );
        expect(failure).toEqual({outcome: "not_ready"});
        // The route answers exactly what the readiness middleware answers.
        expect(SETTLE_NOT_READY).toEqual({
            status: 200,
            body: {success: false, network: GIWA_SEPOLIA_CAIP2, errorReason: FACILITATOR_NOT_READY},
        });
        // And there is nothing to record: the store refuses a row with that outcome, so
        // the coordinator's skip is the only way it can be honoured.
        expect(() =>
            memoryStore().ledger.record({
                kind: "settle",
                at: NOW,
                payer: ALICE,
                payTo: SHOP,
                amountBase: 1n,
                outcome: failure.outcome as never,
            }),
        ).toThrow(/settlement_events_outcome/);
    });

    test("a revert from the same stage is a rejection, with a rejected row", () => {
        expect(describeFailure(new Error("execution reverted: caveat"))).toEqual({
            outcome: "rejected",
            errorCode: "delegation_rejected",
            transaction: null,
        });
    });

    test("a broadcast whose receipt was not seen is still settlement_unconfirmed, with an error row", () => {
        expect(describeFailure(new SettlementUnconfirmed(HASH))).toEqual({
            outcome: "error",
            errorCode: SETTLEMENT_UNCONFIRMED,
            transaction: HASH,
        });
        // A throw from writeContract itself has no hash to carry, and is unknown all the same.
        expect(describeFailure(new SettlementUnconfirmed())).toEqual({
            outcome: "error",
            errorCode: SETTLEMENT_UNCONFIRMED,
            transaction: null,
        });
    });

    test("a budget refusal keeps its own code, as a rejection", () => {
        expect(describeFailure(new SettlementBudgetExceeded("payer_budget_exhausted"))).toEqual({
            outcome: "rejected",
            errorCode: "payer_budget_exhausted",
            transaction: null,
        });
        expect(describeFailure(new SettlementBudgetExceeded("budget_exhausted"))).toEqual({
            outcome: "rejected",
            errorCode: "budget_exhausted",
            transaction: null,
        });
    });
});

describe("classifyFrameworkError", () => {

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

    /** What the verifier actually throws for a live admin state, not a hand-written message. */
    function liveFailure(live: Parameters<typeof assertFrameworkAdminActive>[0]): unknown {
        try {
            assertFrameworkAdminActive(live, ALICE);
        } catch (error) {
            return error;
        }
        throw new Error("expected the verifier to refuse");
    }

    test("the artifact's admin disagreeing with the environment is an owner mismatch", () => {
        expect(classifyFrameworkError(new Error("active deployment admin identity mismatch"))).toBe(
            "owner_mismatch",
        );
    });

    test("the live owner, or a pending one, is an owner mismatch — as the verifier throws it", () => {
        expect(classifyFrameworkError(liveFailure({owner: BOB, pendingOwner: null, paused: false}))).toBe(
            "owner_mismatch",
        );
        expect(classifyFrameworkError(liveFailure({owner: ALICE, pendingOwner: BOB, paused: false}))).toBe(
            "owner_mismatch",
        );
    });

    test("the live pause is framework_paused — as the verifier throws it", () => {
        expect(classifyFrameworkError(liveFailure({owner: ALICE, pendingOwner: null, paused: true}))).toBe(
            "framework_paused",
        );
    });

    test("everything the verifier cannot name more precisely is verification_failed", () => {
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

describe("frameworkPausedFrom", () => {
    test("a check that passed proves the manager is not paused — the verifier throws on the pause", () => {
        expect(frameworkPausedFrom(null)).toBe(false);
    });

    test("the pause is known through its classification, since the check returned no flag", () => {
        expect(frameworkPausedFrom("framework_paused")).toBe(true);
    });

    test("a failure that says nothing about the pause leaves it unknown", () => {
        for (const error of ["rpc_unreachable", "owner_mismatch", "verification_failed"] as const) {
            expect(frameworkPausedFrom(error)).toBeNull();
        }
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
