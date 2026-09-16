import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore, type MapaeStore, type TransactionEnvelope} from "@mapae/store";
import {keccak256, parseTransaction, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {SettlementRecovery, type RecoveryOperations, type RecoveryReceipt} from "./recovery.js";
import {SettlementUnconfirmed} from "./guards.js";
const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const PAY_TO = `0x${"2".repeat(40)}` as const;
const ID = `0x${"a".repeat(64)}` as const;
const NOW = Date.UTC(2026, 8, 13, 23, 59);
const payment = {paymentIntentId: ID, payer: account.address, payTo: PAY_TO, amountBase: 25n};
const stores: MapaeStore[] = [], dirs: string[] = [];
function file() {const d = mkdtempSync(join(tmpdir(), "mapae-recovery-")); dirs.push(d); return join(d, "test.sqlite");}
function open(path = ":memory:") {const s = openStore(path); stores.push(s); return s;}
function engine(s: MapaeStore, now = NOW) {return new SettlementRecovery(s.settlements, account.address, 91342, {total: 10000n, payer: 5000n}, () => now);}
async function sign(envelope: Pick<TransactionEnvelope, "nonce" | "gas" | "maxFeePerGas" | "maxPriorityFeePerGas">) {
    return account.signTransaction({type: "eip1559", chainId: 91342, to: PAY_TO, value: 25n, ...envelope});
}
function ops() {
    const sent: Hex[] = [], prepared: number[] = [];
    const operations: RecoveryOperations<RecoveryReceipt> = {
        pendingNonce: async () => 0,
        prepare: async (nonce) => {prepared.push(nonce); return sign({nonce, gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n});},
        restore: (r) => sign({nonce: r.nonce, gas: r.gas, maxFeePerGas: r.maxFeePerGas, maxPriorityFeePerGas: r.maxPriorityFeePerGas}),
        receipt: async () => null,
        send: async (raw) => {sent.push(raw); return keccak256(raw);},
        wait: async (hash) => ({transactionHash: hash, gasUsed: 50n, effectiveGasPrice: 2n, l1Fee: "0x3"}),
        failure: () => undefined,
    };
    return {operations, sent, prepared};
}
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});});

test("successful receipt reconciles both budgets including L1 and terminal retry does not touch RPC", async () => {
    const s = open(), f = ops(), e = engine(s);
    const first = await e.settle(payment, f.operations);
    expect(first.actualCost).toBe(103n); expect(first.terminal?.outcome).toBe("settled");
    expect(s.budget.load("2026-09-13")).toBe(103n);
    await e.settle(payment, {...f.operations, receipt: async () => {throw Error("must not read");}});
    expect(f.sent).toHaveLength(1); expect(s.ledger.list()).toHaveLength(1);
});
test("termination boundary after claim but before send recovers by re-signing exactly the same hash", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, receipt: async () => {throw Error("process ended");}})).rejects.toBeInstanceOf(SettlementUnconfirmed);
    const hash = first.settlements.get(ID)!.txHash;
    expect(f.sent).toHaveLength(0); first.close();
    const second = open(path), next = ops();
    const r = await engine(second, NOW + 120000).settle(payment, next.operations);
    expect(next.prepared).toHaveLength(0); expect(keccak256(next.sent[0]!)).toBe(hash);
    expect(r.actualCost).toBe(103n); expect(second.budget.load("2026-09-13")).toBe(103n);
    expect(second.budget.load("2026-09-14")).toBe(0n);
});
test("a lost send answer can still succeed from the original receipt", async () => {
    const s = open(), f = ops();
    const r = await engine(s).settle(payment, {...f.operations, send: async () => {throw Error("response lost");}});
    expect(r.terminal?.outcome).toBe("settled");
});
test("an unconfirmed send can be resent after restart without changing bytes or reserving again", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementUnconfirmed);
    expect(first.budget.load("2026-09-13")).toBe(1000n); first.close();
    const second = open(path), next = ops(); await engine(second).settle(payment, next.operations);
    expect(next.sent).toEqual(f.sent); expect(second.budget.load("2026-09-13")).toBe(103n);
});
test("a receipt found after restart finishes accounting without another send", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementUnconfirmed);
    first.close(); const second = open(path), next = ops();
    await engine(second).settle(payment, {...next.operations, receipt: next.operations.wait});
    expect(next.sent).toHaveLength(0); expect(second.budget.load("2026-09-13")).toBe(103n);
});
test("tampered reconstruction never sends a new transaction", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, restore: (r) => sign({...r, nonce: r.nonce + 1})})).rejects.toBeInstanceOf(SettlementUnconfirmed);
    expect(f.sent).toHaveLength(0); expect(s.settlements.get(ID)?.terminal).toBeNull();
    await engine(s).settle(payment, f.operations); expect(f.sent).toHaveLength(1);
});
test("same-intent concurrency coalesces; distinct intents reserve distinct durable nonces", async () => {
    const s = open(), f = ops(), e = engine(s);
    await Promise.all([e.settle(payment, f.operations), e.settle(payment, f.operations)]);
    expect(f.prepared).toEqual([0]); expect(f.sent).toHaveLength(1);
    const a = ops(), b = ops();
    await Promise.all([e.settle({...payment, paymentIntentId: `0x${"b".repeat(64)}`}, a.operations),
        e.settle({...payment, paymentIntentId: `0x${"c".repeat(64)}`}, b.operations)]);
    expect([...a.sent, ...b.sent].map((raw) => parseTransaction(raw).nonce).sort()).toEqual([1, 2]);
});
test("unreadable actual receipt fees preserve the reservation for a later correct receipt", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, wait: async (hash) => ({transactionHash: hash, gasUsed: 50n, effectiveGasPrice: 2n, l1Fee: "bad"})})).rejects.toBeInstanceOf(SettlementUnconfirmed);
    expect(s.settlements.get(ID)?.actualCost).toBeNull(); expect(s.budget.load("2026-09-13")).toBe(1000n);
    await engine(s).settle(payment, f.operations); expect(s.budget.load("2026-09-13")).toBe(103n);
});
test("an unreadable journal cannot claim a prior payment was rejected", async () => {
    const s = open(), f = ops(); s.close();
    await expect(engine(s).settle(payment, f.operations)).rejects.toBeInstanceOf(SettlementUnconfirmed);
    expect(f.prepared).toHaveLength(0);
});
