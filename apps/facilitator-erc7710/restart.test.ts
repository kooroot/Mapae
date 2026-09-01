/**
 * The restart proof: kill the facilitator, bring it back on the same `STORE_PATH`, and
 * `/metrics` says the same thing — ledger and budget alike.
 *
 * `index.ts` cannot be imported here (it needs a signer, artifacts and an RPC at module
 * load), so the test composes exactly what its boot does with the store: `openStore`,
 * `new SpendBudget(limit, Date.now(), store.budget)`, `metricsReport(...)`. What is
 * proven is the persistence contract between those three, which is the part a restart
 * can break.
 */
import {afterEach, describe, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SpendBudget} from "@mapae/delegation";
import {IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {metricsReport} from "./metrics.js";

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

    test("a reservation in flight at the kill is not carried over; a charged one is", () => {
        const path = tempStorePath();
        const now = 20 * DAY_MS;

        const first = open(path);
        const budget = new SpendBudget(LIMIT, now, first.budget);
        const charged = budget.reserve(RESERVATION, now);
        if (!charged) throw new Error("expected a hold");
        // A broadcast whose receipt never arrived keeps its whole reservation charged.
        budget.settle(charged, charged.amount, now);
        // A second hold is mid-broadcast when the process dies: never settled.
        expect(budget.reserve(RESERVATION, now)).toBeDefined();
        expect(budget.remaining(now)).toBe(LIMIT - 2n * RESERVATION);
        first.close();

        const second = open(path);
        const revived = new SpendBudget(LIMIT, now, second.budget);
        // Documented bound (SpendBudget): reservations are not persisted, so a crash
        // mid-broadcast under-counts by at most the one hold that was in flight.
        expect(metricsReport(second.ledger, now, revived, LIMIT).budget).toEqual({
            day: "1970-01-21",
            limitWei: LIMIT.toString(),
            spentWei: RESERVATION.toString(),
            remainingWei: (LIMIT - RESERVATION).toString(),
        });
    });
});
