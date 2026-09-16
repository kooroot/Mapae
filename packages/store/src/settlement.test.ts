import {afterEach, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore, type MapaeStore, type SettlementInput} from "./index.js";
const A = `0x${"1".repeat(40)}` as const;
const B = `0x${"2".repeat(40)}` as const;
const ID = `0x${"a".repeat(64)}` as const;
const HASH = `0x${"b".repeat(64)}` as const;
const NOW = Date.UTC(2026, 8, 13, 23, 59);
const INPUT: SettlementInput = {paymentIntentId: ID, txHash: HASH, signer: A, chainId: 91342, nonce: 3,
    gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, payer: A, payTo: B, amountBase: 25n, createdAt: NOW};
const LIMITS = {total: 5000n, payer: 2000n};
const dirs: string[] = [], stores: MapaeStore[] = [];
function file() {const dir = mkdtempSync(join(tmpdir(), "mapae-journal-")); dirs.push(dir); return join(dir, "test.sqlite");}
function open(path = ":memory:") {const s = openStore(path); stores.push(s); return s;}
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});});

test("claim and both budgets persist together; reopening reconciles actual cost on the original day once", () => {
    const path = file(), first = open(path);
    first.settlements.claim(INPUT, LIMITS); first.close();
    const second = open(path);
    expect(second.budget.load("2026-09-13")).toBe(1000n);
    expect(second.budget.scoped(`payer:${A}`).load("2026-09-13")).toBe(1000n);
    const r = second.settlements.finish(ID, {at: NOW + 120000, gasUsed: 50n, actualCost: 103n});
    expect(r.terminal?.outcome).toBe("settled"); expect(r.actualCost).toBe(103n);
    expect(second.budget.load("2026-09-13")).toBe(103n);
    expect(second.budget.scoped(`payer:${A}`).load("2026-09-13")).toBe(103n);
    expect(second.budget.load("2026-09-14")).toBe(0n);
    second.settlements.finish(ID, {at: NOW + 500000, gasUsed: 80n, actualCost: 800n});
    expect(second.budget.load("2026-09-13")).toBe(103n); expect(second.ledger.list()).toHaveLength(1);
});
test("two connections cannot reserve beyond either payer or total caps", () => {
    const path = file(), a = open(path), b = open(path);
    a.settlements.claim(INPUT, {total: 1500n, payer: 1000n});
    const next = {...INPUT, nonce: 4, paymentIntentId: HASH, txHash: ID};
    expect(() => b.settlements.claim(next, {total: 1500n, payer: 1000n})).toThrow("payer_budget_exhausted");
    expect(() => b.settlements.claim({...next, payer: B}, {total: 1500n, payer: 1000n})).toThrow("budget_exhausted");
    expect(b.settlements.get(HASH)).toBeNull(); expect(b.budget.load("2026-09-13")).toBe(1000n);
});
test("a failed second budget write rolls back the claim and first budget", () => {
    const path = file(), store = open(path), raw = new Database(path);
    raw.exec("CREATE TRIGGER fail_share BEFORE INSERT ON budget_days WHEN NEW.scope != 'total' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END");
    expect(() => store.settlements.claim(INPUT, LIMITS)).toThrow("injected disk failure");
    expect(store.settlements.get(ID)).toBeNull(); expect(store.budget.load("2026-09-13")).toBe(0n); raw.close();
});
test("a failed final ledger write rolls back gas reconciliation and leaves a recoverable claim", () => {
    const path = file(), store = open(path), raw = new Database(path);
    store.settlements.claim(INPUT, LIMITS);
    raw.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON settlement_events BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END");
    expect(() => store.settlements.finish(ID, {at: NOW, gasUsed: 50n, actualCost: 103n})).toThrow();
    expect(store.settlements.get(ID)?.terminal).toBeNull(); expect(store.budget.load("2026-09-13")).toBe(1000n);
    raw.exec("DROP TRIGGER fail_ledger"); raw.close();
    store.settlements.finish(ID, {at: NOW, gasUsed: 50n, actualCost: 103n});
    expect(store.budget.load("2026-09-13")).toBe(103n);
});
test("a claimed nonce is unavailable after restart even when the node has never seen it", () => {
    const path = file(), a = open(path); a.settlements.claim(INPUT, LIMITS); a.close();
    const b = open(path); expect(b.settlements.nextNonce(A, 91342, 0)).toBe(4);
    expect(b.settlements.nextNonce(A, 91342, 9)).toBe(9);
    expect(() => b.settlements.claim({...INPUT, paymentIntentId: HASH, txHash: ID}, LIMITS)).toThrow();
});
test("duplicate claims return the immutable original without charging twice", () => {
    const s = open(); const first = s.settlements.claim(INPUT, LIMITS);
    expect(s.settlements.claim({...INPUT, nonce: 20, txHash: ID}, LIMITS)).toEqual(first);
    expect(s.budget.load("2026-09-13")).toBe(1000n);
});
test("invalid input and gas envelopes fail before budgets change", () => {
    const s = open();
    for (const patch of [{gas: -1n}, {nonce: -1}, {maxPriorityFeePerGas: 11n}, {paymentIntentId: "0xbad"}, {amountBase: -1n}]) {
        expect(() => s.settlements.claim({...INPUT, ...patch} as SettlementInput, LIMITS)).toThrow();
    }
    expect(s.budget.load("2026-09-13")).toBe(0n);
});
test("mined errors and actual cost exceeding the estimate are recorded once", () => {
    const s = open(); s.settlements.claim(INPUT, LIMITS);
    const r = s.settlements.finish(ID, {at: NOW, gasUsed: 100n, actualCost: 1200n, errorCode: "settlement_reverted"});
    expect(r.terminal).toMatchObject({outcome: "error", txHash: HASH, gasUsed: 100n, errorCode: "settlement_reverted"});
    s.settlements.finish(ID, {at: NOW, gasUsed: 100n, actualCost: 1200n});
    expect(s.ledger.summary({sinceMs: 0})).toMatchObject({total: 1, succeeded: 0, failed: 1});
    expect(s.budget.load("2026-09-13")).toBe(1200n);
});
