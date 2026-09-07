import {afterEach, describe, expect, test} from "bun:test";
import {SpendBudget, budgetDay} from "@mapae/delegation";
import {openStore, type MapaeStore} from "@mapae/store";
import {
    REJECTED_SETTLEMENTS_KEPT,
    REJECTED_SETTLEMENT_RETENTION_MS,
    bearerTokenMatches,
    metricsReport,
    readMetricsToken,
    rejectedRetention,
    summaryJson,
} from "./metrics.js";

const TOKEN = "correct-horse-battery-staple";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAY_MS = 86_400_000;
const LIMIT = 500_000_000_000_000n;
// A steady-state redemption at a 0.3 gwei ceiling: the measured 333,523 gas × 3·10^8,
// small enough to fit the day several times over.
const RESERVATION = 100_056_900_000_000n;

const stores: MapaeStore[] = [];

function open(): MapaeStore {
    const store = openStore(":memory:");
    stores.push(store);
    return store;
}

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
});

describe("readMetricsToken", () => {
    test("unset or blank disables the endpoint; whitespace is trimmed", () => {
        expect(readMetricsToken(undefined)).toBeUndefined();
        expect(readMetricsToken("")).toBeUndefined();
        expect(readMetricsToken("   \n")).toBeUndefined();
        expect(readMetricsToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    });

    test("refuses a token shorter than 16 characters", () => {
        expect(() => readMetricsToken("short")).toThrow(/at least 16/);
        expect(readMetricsToken("0123456789abcdef")).toBe("0123456789abcdef");
    });
});

describe("bearerTokenMatches", () => {
    test("accepts only the configured token behind a Bearer scheme", () => {
        expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
        expect(bearerTokenMatches(`bearer   ${TOKEN}  `, TOKEN)).toBe(true);
        expect(bearerTokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer nope", TOKEN)).toBe(false);
    });

    test("refuses a missing, empty or non-Bearer header without throwing", () => {
        expect(bearerTokenMatches(undefined, TOKEN)).toBe(false);
        expect(bearerTokenMatches("", TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer", TOKEN)).toBe(false);
        expect(bearerTokenMatches("Bearer ", TOKEN)).toBe(false);
        expect(bearerTokenMatches(TOKEN, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
        expect(bearerTokenMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    });
});

describe("summaryJson", () => {
    test("renders every bigint as a decimal string, exactly", () => {
        expect(
            summaryJson({
                total: 3,
                succeeded: 2,
                failed: 1,
                volumeByPayTo: {[SHOP]: 2n ** 70n, [BOB]: 0n},
                uniquePayers: 2,
            }),
        ).toEqual({
            total: 3,
            succeeded: 2,
            failed: 1,
            volumeByPayTo: {[SHOP]: "1180591620717411303424", [BOB]: "0"},
            uniquePayers: 2,
        });
    });
});

describe("rejectedRetention", () => {
    test("keeps a refusal a week and no more than 50,000 of them; the cutoff never precedes the epoch", () => {
        const now = 30 * DAY_MS;
        expect(rejectedRetention(now)).toEqual({rejectedBefore: now - 7 * DAY_MS, keepRejected: 50_000});
        expect(REJECTED_SETTLEMENT_RETENTION_MS).toBe(7 * DAY_MS);
        expect(REJECTED_SETTLEMENTS_KEPT).toBe(50_000);
        expect(rejectedRetention(DAY_MS).rejectedBefore).toBe(0);
    });

    test("under the policy a refusal older than the week leaves failed and total; settled and error rows stay", () => {
        const store = open();
        const now = 30 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);
        const base = {kind: "settle", payTo: SHOP, amountBase: 100n} as const;
        store.ledger.record({...base, at: now - 8 * DAY_MS, payer: ALICE, outcome: "settled"});
        store.ledger.record({...base, at: now - 8 * DAY_MS, payer: ALICE, outcome: "error"});
        store.ledger.record({...base, at: now - 8 * DAY_MS, payer: BOB, outcome: "rejected"});
        store.ledger.record({...base, at: now - 6 * DAY_MS, payer: BOB, outcome: "rejected"});

        expect(store.ledger.prune(rejectedRetention(now))).toBe(1);
        expect(metricsReport(store.ledger, now, budget, LIMIT).allTime).toEqual({
            total: 3,
            succeeded: 1,
            failed: 2,
            volumeByPayTo: {[SHOP]: "100"},
            uniquePayers: 1,
        });
        // The policy's cap is what an operator can reason about from /metrics: the
        // rejected count can never exceed it for long.
        expect(rejectedRetention(now).keepRejected).toBe(REJECTED_SETTLEMENTS_KEPT);
    });

    test("the count cap cuts inside the day too: past it, last24h under-counts refusals like allTime", () => {
        const store = open();
        const now = 30 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);
        const base = {kind: "settle", payTo: SHOP, amountBase: 100n, payer: BOB} as const;
        for (let i = 0; i < 3; i += 1) store.ledger.record({...base, at: now - i, outcome: "rejected"});
        store.ledger.record({...base, at: now - 3, payer: ALICE, outcome: "settled"});

        // The policy's cutoff with a cap this test can fill; the shape is the same at 50,000.
        expect(store.ledger.prune({...rejectedRetention(now), keepRejected: 2})).toBe(1);
        const report = metricsReport(store.ledger, now, budget, LIMIT);
        expect(report.last24h).toMatchObject({total: 3, succeeded: 1, failed: 2});
        expect(report.allTime).toEqual(report.last24h);
    });
});

describe("metricsReport", () => {
    test("splits the ledger into a rolling 24h window and all time, JSON-safe", () => {
        const store = open();
        const now = 10 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);
        const base = {kind: "settle", payTo: SHOP, amountBase: 100n} as const;
        store.ledger.record({...base, at: now - 2 * DAY_MS, payer: ALICE, outcome: "settled"});
        store.ledger.record({...base, at: now - DAY_MS + 1, payer: BOB, outcome: "settled"});
        store.ledger.record({...base, at: now, payer: BOB, outcome: "rejected"});

        const report = metricsReport(store.ledger, now, budget, LIMIT);
        expect(report).toEqual({
            last24h: {
                total: 2,
                succeeded: 1,
                failed: 1,
                volumeByPayTo: {[SHOP]: "100"},
                uniquePayers: 1,
            },
            allTime: {
                total: 3,
                succeeded: 2,
                failed: 1,
                volumeByPayTo: {[SHOP]: "200"},
                uniquePayers: 2,
            },
            budget: {
                day: "1970-01-11",
                limitWei: LIMIT.toString(),
                spentWei: "0",
                remainingWei: LIMIT.toString(),
            },
        });
        expect(() => JSON.stringify(report)).not.toThrow();
        // A clock earlier than one day after the epoch clamps the window to the epoch
        // instead of handing the store a negative `sinceMs`.
        expect(() => metricsReport(store.ledger, 0, budget, LIMIT)).not.toThrow();
        expect(metricsReport(store.ledger, 0, budget, LIMIT).last24h).toEqual(report.allTime);
    });

    test("budget reports what settled receipts charged and what is left", () => {
        const store = open();
        const now = 10 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);

        const first = budget.reserve(RESERVATION, now);
        if (!first) throw new Error("expected a hold");
        budget.settle(first, 300_000_000_000_000n, now);
        const second = budget.reserve(RESERVATION, now + 1);
        if (!second) throw new Error("expected a hold");
        budget.settle(second, 0n, now + 1);

        expect(metricsReport(store.ledger, now + 2, budget, LIMIT).budget).toEqual({
            day: budgetDay(now),
            limitWei: "500000000000000",
            spentWei: "300000000000000",
            remainingWei: "200000000000000",
        });
        // The figures are the store's, not the object's: what /metrics reports is what
        // a restart will read back.
        expect(store.budget.load(budgetDay(now))).toBe(300_000_000_000_000n);
    });

    test("budget subtracts a reservation in flight from remaining but not yet from spent", () => {
        const store = open();
        const now = 10 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);

        const hold = budget.reserve(RESERVATION, now);
        expect(hold).toBeDefined();
        expect(metricsReport(store.ledger, now, budget, LIMIT).budget).toEqual({
            day: budgetDay(now),
            limitWei: LIMIT.toString(),
            spentWei: "0",
            remainingWei: (LIMIT - RESERVATION).toString(),
        });

        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, RESERVATION, now);
        expect(metricsReport(store.ledger, now, budget, LIMIT).budget.spentWei).toBe(
            RESERVATION.toString(),
        );
    });

    test("budget reports an exhausted day as remaining 0, even when spent overshot the limit", () => {
        const store = open();
        const now = 10 * DAY_MS;
        const budget = new SpendBudget(LIMIT, now, store.budget);

        const hold = budget.reserve(LIMIT, now);
        if (!hold) throw new Error("expected a hold");
        // A receipt can cost more than its reservation (the L1 data fee is not in the
        // gas × maxFeePerGas estimate); the overshoot is charged, not clipped.
        budget.settle(hold, LIMIT + 1n, now);

        expect(budget.reserve(1n, now)).toBeUndefined();
        expect(metricsReport(store.ledger, now, budget, LIMIT).budget).toEqual({
            day: budgetDay(now),
            limitWei: LIMIT.toString(),
            spentWei: (LIMIT + 1n).toString(),
            remainingWei: "0",
        });
    });

    test("budget rolls to a fresh UTC day and keeps the old day's total in the store", () => {
        const store = open();
        const now = 10 * DAY_MS + 5 * 60_000;
        const budget = new SpendBudget(LIMIT, now, store.budget);
        const hold = budget.reserve(RESERVATION, now);
        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, RESERVATION, now);

        const tomorrow = now + DAY_MS;
        expect(metricsReport(store.ledger, tomorrow, budget, LIMIT).budget).toEqual({
            day: budgetDay(tomorrow),
            limitWei: LIMIT.toString(),
            spentWei: "0",
            remainingWei: LIMIT.toString(),
        });
        expect(budgetDay(tomorrow)).not.toBe(budgetDay(now));
        expect(store.budget.load(budgetDay(now))).toBe(RESERVATION);
    });

    test("budget seeded from a store that already holds today's total reports it", () => {
        const store = open();
        const now = 10 * DAY_MS;
        store.budget.save(budgetDay(now), 123_000_000_000_000n);

        const budget = new SpendBudget(LIMIT, now, store.budget);
        expect(metricsReport(store.ledger, now, budget, LIMIT).budget).toEqual({
            day: budgetDay(now),
            limitWei: LIMIT.toString(),
            spentWei: "123000000000000",
            remainingWei: "377000000000000",
        });
    });

    test("budget figures stay exact past 2^53", () => {
        const store = open();
        const now = 10 * DAY_MS;
        const limit = 2n ** 70n;
        const budget = new SpendBudget(limit, now, store.budget);
        const hold = budget.reserve(2n ** 60n, now);
        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, 2n ** 60n + 1n, now);

        const report = metricsReport(store.ledger, now, budget, limit).budget;
        expect(report.limitWei).toBe("1180591620717411303424");
        expect(report.spentWei).toBe("1152921504606846977");
        expect(report.remainingWei).toBe((limit - 2n ** 60n - 1n).toString());
        expect(() => JSON.stringify(report)).not.toThrow();
    });
});
