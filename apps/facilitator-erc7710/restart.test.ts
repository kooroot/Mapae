/**
 * The restart proof: kill the facilitator, bring it back on the same `STORE_PATH`, and
 * `/metrics` says the same thing — ledger and budget alike.
 *
 * These store/metrics tests use a structural budget gauge. Real HTTP process death
 * and durable settlement reconciliation are exercised by test:e2e:recovery.
 */
import {afterEach, describe, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SpendBudget} from "@mapae/delegation";
import {IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {metricsReport, rejectedRetention} from "./metrics.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX = `0x${"c".repeat(64)}` as const;
const DAY_MS = 86_400_000;
const LIMIT = 500_000_000_000_000n;
// 333,523 gas × 0.3 gwei, and a receipt that cost a little less than its reservation.
const RESERVATION = 100_056_900_000_000n;
const ACTUAL = 95_000_000_000_000n;

const dirs: string[] = [];
const stores: MapaeStore[] = [];

function tempStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "mapae-facilitator-"));
    dirs.push(dir);
    return join(dir, "data", "facilitator.sqlite");
}

function open(path: string): MapaeStore {
    const store = openStore(path);
    stores.push(store);
    return store;
}

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("restart", () => {
    test("a reopened store yields the identical /metrics report and the same remaining budget", () => {
        const path = tempStorePath();
        const now = 20 * DAY_MS + 3 * 3_600_000;

        // First life: three settle attempts and one charged redemption.
        const first = open(path);
        const budget = new SpendBudget(LIMIT, now, first.budget);
        const base = {kind: "settle", payTo: SHOP, amountBase: 100_000n} as const;
        first.ledger.record({...base, at: now - 2 * DAY_MS, payer: ALICE, outcome: "settled", txHash: TX});
        first.ledger.record({
            ...base,
            at: now - 60_000,
            payer: BOB,
            outcome: "settled",
            txHash: TX,
            gasUsed: 333_523n,
        });
        first.ledger.record({
            ...base,
            at: now,
            payer: BOB,
            outcome: "rejected",
            errorCode: "budget_exhausted",
        });
        const hold = budget.reserve(RESERVATION, now);
        if (!hold) throw new Error("expected a hold");
        budget.settle(hold, ACTUAL, now);

        const before = metricsReport(first.ledger, now, budget, LIMIT);
        const remainingBefore = budget.remaining(now);
        expect(before.budget.spentWei).toBe(ACTUAL.toString());
        expect(remainingBefore).toBe(LIMIT - ACTUAL);
        first.close();

        // Second life: the same file, a fresh process's objects.
        const second = open(path);
        expect(second.path).toBe(path);
        const revived = new SpendBudget(LIMIT, now, second.budget);
        const after = metricsReport(second.ledger, now, revived, LIMIT);

        expect(after).toEqual(before);
        expect(revived.remaining(now)).toBe(remainingBefore);
        // The cap binds after the restart exactly where it bound before it.
        expect(revived.reserve(remainingBefore + 1n, now)).toBeUndefined();
        expect(revived.reserve(remainingBefore, now)).toBeDefined();

        // Negative control: the equality comes from the file, not from the inputs. A
        // process that came up on an empty store would report nothing of the above.
        const fresh = open(IN_MEMORY);
        const empty = metricsReport(fresh.ledger, now, new SpendBudget(LIMIT, now, fresh.budget), LIMIT);
        expect(empty.allTime.total).toBe(0);
        expect(empty.budget.remainingWei).toBe(LIMIT.toString());
        expect(empty).not.toEqual(before);
    });

    test("a prune before the kill is what the next life reads: the refusals it dropped stay dropped", () => {
        const path = tempStorePath();
        const now = 20 * DAY_MS;

        const first = open(path);
        const base = {kind: "settle", payTo: SHOP, amountBase: 100_000n} as const;
        first.ledger.record({...base, at: now - 10 * DAY_MS, payer: ALICE, outcome: "settled", txHash: TX});
        first.ledger.record({...base, at: now - 10 * DAY_MS, payer: BOB, outcome: "rejected"});
        first.ledger.record({...base, at: now - DAY_MS, payer: BOB, outcome: "rejected"});
        // What boot does with the file it found: prune to the facilitator's retention.
        expect(first.ledger.prune(rejectedRetention(now))).toBe(1);
        const before = metricsReport(first.ledger, now, new SpendBudget(LIMIT, now, first.budget), LIMIT);
        expect(before.allTime).toMatchObject({total: 2, succeeded: 1, failed: 1});
        first.close();

        const second = open(path);
        const after = metricsReport(second.ledger, now, new SpendBudget(LIMIT, now, second.budget), LIMIT);
        expect(after).toEqual(before);
        // The next boot's prune finds nothing left to drop.
        expect(second.ledger.prune(rejectedRetention(now))).toBe(0);
    });

    test("a journal reservation in flight survives restart and remains visible in metrics", () => {
        const path = tempStorePath(), now = 20 * DAY_MS;
        const first = open(path);
        first.settlements.claim({paymentIntentId: TX, txHash: TX, signer: ALICE, chainId: 1, nonce: 0,
            gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, payer: ALICE, payTo: SHOP,
            amountBase: 1n, createdAt: now}, {total: LIMIT, payer: LIMIT});
        first.close();
        const second = open(path);
        expect(second.budget.load("1970-01-21")).toBe(1000n);
        expect(second.settlements.get(TX)?.terminal).toBeNull();
    });
});
