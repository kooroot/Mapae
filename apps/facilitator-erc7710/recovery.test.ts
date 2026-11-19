import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openStore, type MapaeStore, type SettlementJournal, type TransactionEnvelope} from "@mapae/store";
import {keccak256, parseTransaction, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {SettlementRecovery, type RecoveryOperations, type RecoveryReceipt, type SweepOperations} from "./recovery.js";
import {SettlementBroadcastRefused, SettlementPending, SettlementStorageUnavailable} from "./guards.js";
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
        refused: () => false,
        wait: async (hash) => ({transactionHash: hash, gasUsed: 50n, effectiveGasPrice: 2n, l1Fee: "0x3"}),
        failure: () => undefined,
    };
    return {operations, sent, prepared};
}
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});});

test("successful receipt reconciles both budgets including L1 and terminal retry does not touch RPC", async () => {
    const s = open(), f = ops(), e = engine(s);
    const first = await e.settle(payment, f.operations);
    expect(first.record.actualCost).toBe(103n); expect(first.record.terminal?.outcome).toBe("settled");
    // The journal held nothing when this call began, so the answer is this call's own.
    expect(first.replayed).toBe(false);
    expect(s.budget.load("2026-09-13")).toBe(103n);
    const again = await e.settle(payment, {...f.operations, receipt: async () => {throw Error("must not read");}});
    // The same answer, marked as the earlier attempt's: this call performed nothing.
    expect(again.replayed).toBe(true);
    expect(again.record).toEqual(first.record);
    expect(f.sent).toHaveLength(1); expect(s.ledger.list()).toHaveLength(1);
});
test("known() answers the journal, and an unseen intent is null rather than a guess", async () => {
    const s = open(), f = ops(), e = engine(s);
    expect(e.known(ID)).toBeNull();
    const {record} = await e.settle(payment, f.operations);
    expect(e.known(ID)).toEqual(record);
});
test("termination boundary after claim but before send recovers by re-signing exactly the same hash", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, receipt: async () => {throw Error("process ended");}})).rejects.toBeInstanceOf(SettlementPending);
    const hash = first.settlements.get(ID)!.txHash;
    expect(f.sent).toHaveLength(0); first.close();
    const second = open(path), next = ops();
    const r = await engine(second, NOW + 120000).settle(payment, next.operations);
    expect(next.prepared).toHaveLength(0); expect(keccak256(next.sent[0]!)).toBe(hash);
    // The claim predates this call, so the answer is marked replayed even though this call
    // is the one that sent: what went out was the bytes the journal already named.
    expect(r.replayed).toBe(true);
    expect(r.record.actualCost).toBe(103n); expect(second.budget.load("2026-09-13")).toBe(103n);
    expect(second.budget.load("2026-09-14")).toBe(0n);
});
test("a lost send answer can still succeed from the original receipt", async () => {
    const s = open(), f = ops();
    const r = await engine(s).settle(payment, {...f.operations, send: async () => {throw Error("response lost");}});
    expect(r.record.terminal?.outcome).toBe("settled");
});
test("an unconfirmed send can be resent after restart without changing bytes or reserving again", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    expect(first.budget.load("2026-09-13")).toBe(1000n); first.close();
    const second = open(path), next = ops(); await engine(second).settle(payment, next.operations);
    expect(next.sent).toEqual(f.sent); expect(second.budget.load("2026-09-13")).toBe(103n);
});
test("a receipt found after restart finishes accounting without another send", async () => {
    const path = file(), first = open(path), f = ops();
    await expect(engine(first).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    first.close(); const second = open(path), next = ops();
    await engine(second).settle(payment, {...next.operations, receipt: next.operations.wait});
    expect(next.sent).toHaveLength(0); expect(second.budget.load("2026-09-13")).toBe(103n);
});
test("tampered reconstruction never sends a new transaction", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, restore: (r) => sign({...r, nonce: r.nonce + 1})})).rejects.toBeInstanceOf(SettlementPending);
    expect(f.sent).toHaveLength(0); expect(s.settlements.get(ID)?.terminal).toBeNull();
    await engine(s).settle(payment, f.operations); expect(f.sent).toHaveLength(1);
});
test("same-intent concurrency coalesces; distinct intents reserve distinct durable nonces", async () => {
    const s = open(), f = ops(), e = engine(s);
    const both = await Promise.all([e.settle(payment, f.operations), e.settle(payment, f.operations)]);
    expect(f.prepared).toEqual([0]); expect(f.sent).toHaveLength(1);
    // One operation, one broadcast, so only the call that owns it may answer as the one
    // that settled: the coalesced call performed nothing and reads as a replay. Two live
    // requests for one payment must never both look like a fresh sale.
    expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
    const a = ops(), b = ops();
    await Promise.all([e.settle({...payment, paymentIntentId: `0x${"b".repeat(64)}`}, a.operations),
        e.settle({...payment, paymentIntentId: `0x${"c".repeat(64)}`}, b.operations)]);
    expect([...a.sent, ...b.sent].map((raw) => parseTransaction(raw).nonce).sort()).toEqual([1, 2]);
});
test("unreadable actual receipt fees preserve the reservation for a later correct receipt", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, wait: async (hash) => ({transactionHash: hash, gasUsed: 50n, effectiveGasPrice: 2n, l1Fee: "bad"})})).rejects.toBeInstanceOf(SettlementPending);
    expect(s.settlements.get(ID)?.actualCost).toBeNull(); expect(s.budget.load("2026-09-13")).toBe(1000n);
    await engine(s).settle(payment, f.operations); expect(s.budget.load("2026-09-13")).toBe(103n);
});
test("an unreadable journal is not-ready: it neither claims a prior payment was rejected nor names a hash it cannot read", async () => {
    const s = open(), f = ops(); s.close();
    await expect(engine(s).settle(payment, f.operations)).rejects.toBeInstanceOf(SettlementStorageUnavailable);
    expect(() => engine(s).known(ID)).toThrow(SettlementStorageUnavailable);
    expect(f.prepared).toHaveLength(0);
});
test("a journal that fails while allocating the nonce is not-ready, not a rejected delegation", async () => {
    // `nextNonce` is a read like `get` and `claim` are writes: none of the three examined
    // the delegation, so a failure in any of them owes the caller a retry, not a verdict
    // — and not the `rejected` ledger row an unclassified throw would have written.
    const s = open(), f = ops();
    const journal: SettlementJournal = {...s.settlements, nextNonce: () => {throw new Error("disk gone");}};
    const e = new SettlementRecovery(journal, account.address, 91342, {total: 10000n, payer: 5000n}, () => NOW);
    await expect(e.settle(payment, f.operations)).rejects.toBeInstanceOf(SettlementStorageUnavailable);
    expect(f.prepared).toHaveLength(0); expect(s.settlements.get(ID)).toBeNull(); expect(s.ledger.list()).toHaveLength(0);
});
test("every pending answer carries the hash the journal wrote before the broadcast", async () => {
    const s = open(), f = ops();
    const pending = await engine(s).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}}).catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(SettlementPending);
    expect((pending as SettlementPending).transaction).toBe(s.settlements.get(ID)!.txHash);
});
const OTHER = `0x${"b".repeat(64)}` as const;
const STALE = 90_000;
const fillerBytes = (envelope: {nonce: number}): Hex => `0x${"f1".repeat(16)}${envelope.nonce.toString(16).padStart(32, "0")}`;
const fillerHash = (nonce: number): Hex => keccak256(fillerBytes({nonce}));
const fillerReceipt = (nonce: number): RecoveryReceipt => ({transactionHash: fillerHash(nonce), gasUsed: 21n, effectiveGasPrice: 2n, l1Fee: "0x1"});
function sweepOps(over: Partial<SweepOperations<RecoveryReceipt>> = {}) {
    const sent: Hex[] = [];
    const operations: SweepOperations<RecoveryReceipt> = {
        pendingNonce: async () => 0,
        receipt: async () => null,
        failure: () => undefined,
        filler: async (envelope) => fillerBytes(envelope),
        send: async (bytes) => {sent.push(bytes); return true;},
        ...over,
    };
    return {operations, sent};
}
test("a refused broadcast releases the claim: nothing is reserved, the nonce is reused, and the same payment settles later", async () => {
    const s = open(), f = ops(), e = engine(s);
    await expect(e.settle(payment, {...f.operations, send: async () => {throw Error("insufficient funds for gas * price + value");},
        refused: () => true})).rejects.toBeInstanceOf(SettlementBroadcastRefused);
    expect(s.settlements.get(ID)).toBeNull(); expect(s.budget.load("2026-09-13")).toBe(0n);
    expect(s.ledger.list()).toMatchObject([{outcome: "error", errorCode: "broadcast_refused"}]);
    const next = ops();
    const {record, replayed} = await e.settle(payment, next.operations);
    expect(replayed).toBe(false); expect(record.nonce).toBe(0); expect(record.terminal?.outcome).toBe("settled");
});
test("a send error that is not a refusal, or a refusal of bytes that already mined, is still decided by the receipt", async () => {
    const s = open(), f = ops();
    const lost = await engine(s).settle(payment, {...f.operations, send: async () => {throw Error("already known");}});
    expect(lost.record.terminal?.outcome).toBe("settled");
    let reads = 0;
    const mined = await engine(s).settle({...payment, paymentIntentId: OTHER}, {...f.operations,
        send: async () => {throw Error("insufficient funds");}, refused: () => true,
        receipt: async (hash) => (reads++ === 0 ? null : f.operations.wait(hash))});
    expect(mined.record.terminal?.outcome).toBe("settled"); expect(s.ledger.list()).toHaveLength(2);
});
test("the sweep leaves a young claim alone and finishes a stale one whose receipt exists", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    const young = sweepOps({receipt: async () => {throw Error("must not read");}});
    expect(await engine(s, NOW + STALE - 1).sweep(young.operations, STALE)).toEqual({finished: 0, released: 0, filled: 0});
    const stale = sweepOps({receipt: f.operations.wait, failure: () => "settlement_reverted"});
    expect(await engine(s, NOW + STALE).sweep(stale.operations, STALE)).toEqual({finished: 1, released: 0, filled: 0});
    expect(stale.sent).toEqual([]); expect(s.settlements.get(ID)?.terminal?.errorCode).toBe("settlement_reverted");
    expect(s.budget.load("2026-09-13")).toBe(103n);
});
test("a stale claim still in the node's pool is waited for, not replaced", async () => {
    const s = open(), f = ops();
    await expect(engine(s).settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    const pooled = sweepOps({pendingNonce: async () => 1});
    expect(await engine(s, NOW + STALE).sweep(pooled.operations, STALE)).toEqual({finished: 0, released: 0, filled: 0});
    expect(pooled.sent).toEqual([]); expect(s.settlements.get(ID)?.terminal).toBeNull();
});
async function lostAndQueued() {
    const s = open(), f = ops(), e = engine(s);
    await expect(e.settle(payment, {...f.operations, send: async () => {throw Error("response lost");}, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    await expect(e.settle({...payment, paymentIntentId: OTHER}, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    expect(s.settlements.unsettled(account.address, 91342).map((r) => r.nonce)).toEqual([0, 1]);
    return {s, f};
}
test("a stale claim the node never received gets a filler, and is released only once that filler's own receipt exists", async () => {
    const {s} = await lostAndQueued();
    const first = sweepOps();
    // Sending the filler releases nothing: no receipt for it has been seen.
    expect(await engine(s, NOW + STALE).sweep(first.operations, STALE)).toEqual({finished: 0, released: 0, filled: 1});
    expect(first.sent).toEqual([fillerBytes({nonce: 0})]); expect(s.settlements.get(ID)?.terminal).toBeNull();
    // A later pass — after a restart, or after the node moved past the nonce — finds the
    // filler mined by recomputing its hash from the row, and releases on that alone.
    const later = sweepOps({pendingNonce: async () => 2, receipt: async (hash) => hash === fillerHash(0) ? fillerReceipt(0) : null});
    expect(await engine(s, NOW + STALE).sweep(later.operations, STALE)).toEqual({finished: 0, released: 1, filled: 0});
    expect(later.sent).toEqual([]); expect(s.settlements.get(ID)).toBeNull();
    expect(s.ledger.list()).toMatchObject([{outcome: "error", errorCode: "broadcast_lost"}]);
    // 1000 reserved twice; the lost one is replaced by the filler's 21 * 2 + 1.
    expect(s.budget.load("2026-09-13")).toBe(1043n);
    expect(s.settlements.get(OTHER)?.terminal).toBeNull();
});
test("the claim that mined instead of its filler is finished, never released — whatever a lagging read says about the filler", async () => {
    const {s, f} = await lostAndQueued();
    await engine(s, NOW + STALE).sweep(sweepOps().operations, STALE);
    // The node answers a receipt for another hash when asked for the filler's (a replaced
    // transaction's waiter does this): that is not the filler's receipt and proves nothing.
    const claimed = s.settlements.get(ID)!.txHash;
    const wrong = sweepOps({pendingNonce: async () => 2, receipt: async (hash) => hash === fillerHash(0) ? await f.operations.wait(claimed) : null});
    expect(await engine(s, NOW + STALE).sweep(wrong.operations, STALE)).toEqual({finished: 0, released: 0, filled: 0});
    expect(s.settlements.get(ID)?.terminal).toBeNull();
    const mined = sweepOps({pendingNonce: async () => 2, receipt: async (hash) => hash === fillerHash(0) ? null : await f.operations.wait(hash)});
    expect(await engine(s, NOW + STALE).sweep(mined.operations, STALE)).toEqual({finished: 2, released: 0, filled: 0});
    expect(s.settlements.get(ID)?.terminal?.outcome).toBe("settled");
});
test("a filler the node refuses releases nothing, and a gap no claim holds is filled without touching the journal", async () => {
    const s = open(), f = ops(), e = engine(s);
    await expect(e.settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    const dud = sweepOps({send: async () => false});
    expect(await engine(s, NOW + STALE).sweep(dud.operations, STALE)).toEqual({finished: 0, released: 0, filled: 0});
    expect(s.settlements.get(ID)?.terminal).toBeNull();
    s.settlements.release(ID, {at: NOW, actualCost: 0n, errorCode: "broadcast_refused"});
    await expect(engine(s).settle({...payment, paymentIntentId: OTHER}, {...f.operations, pendingNonce: async () => 1,
        wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    const gap = sweepOps();
    expect(await engine(s, NOW + STALE).sweep(gap.operations, STALE)).toEqual({finished: 0, released: 0, filled: 1});
    expect(gap.sent).toEqual([fillerBytes({nonce: 0})]); expect(s.settlements.get(OTHER)?.nonce).toBe(1);
});
test("a resumed claim is never released on a refusal, and a settle that finds its claim released answers not-ready, not a dead hash", async () => {
    const s = open(), f = ops(), e = engine(s);
    await expect(e.settle(payment, {...f.operations, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    // The first attempt broadcast these bytes; a node that cannot see that pool refuses them.
    await expect(e.settle(payment, {...f.operations, receipt: async () => null, send: async () => {throw Error("insufficient funds");},
        refused: () => true, wait: async () => {throw Error("timeout");}})).rejects.toBeInstanceOf(SettlementPending);
    expect(s.settlements.get(ID)?.terminal).toBeNull();
    // The sweep releases the row while a retry is waiting on the old hash.
    await expect(e.settle(payment, {...f.operations, receipt: async () => null, wait: async () => {
        s.settlements.release(ID, {at: NOW, actualCost: 0n, errorCode: "broadcast_lost"}); throw Error("timeout");
    }})).rejects.toBeInstanceOf(SettlementBroadcastRefused);
});
