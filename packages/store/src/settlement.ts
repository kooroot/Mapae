import type {Database} from "bun:sqlite";
import type {HexString, Ledger, SettlementEvent, SettlementEventInput} from "./index.js";

/** Enough to re-sign the same transaction from a re-presented payment, never its calldata/signature. */
export interface TransactionEnvelope {
    signer: HexString;
    chainId: number;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}
export interface SettlementInput extends TransactionEnvelope {
    paymentIntentId: HexString;
    txHash: HexString;
    payer: HexString;
    payTo: HexString;
    amountBase: bigint;
    createdAt: number;
}
export interface SettlementRecord extends SettlementInput {
    budgetDay: string;
    reservedWei: bigint;
    actualCost: bigint | null;
    terminal: SettlementEvent | null;
}
export interface SettlementLimits {total: bigint; payer: bigint}
export class SettlementBudgetExceeded extends Error {
    constructor(readonly errorCode: "budget_exhausted" | "payer_budget_exhausted") {
        super(errorCode);
        this.name = "SettlementBudgetExceeded";
    }
}
export interface SettlementJournal {
    get(id: HexString): SettlementRecord | null;
    /**
     * The lowest nonce at or above the node's pending nonce that no row holds. A claimed
     * nonce may not be on the node yet, so it stays taken; a released one is free again,
     * and handing out the lowest free one is what closes the gap it left — `MAX + 1`
     * would step over it and queue every later transaction behind a nonce nobody sends.
     */
    nextNonce(signer: HexString, chainId: number, pendingNonce: number): number;
    /** Intent and both daily gas reservations land in one transaction. */
    claim(input: SettlementInput, limits: SettlementLimits): SettlementRecord;
    /** Actual cost, both original-day totals and the terminal ledger event land exactly once. */
    finish(id: HexString, result: {at: number; gasUsed: bigint; actualCost: bigint; errorCode?: string}): SettlementRecord;
    /** Every claim of this signer with no terminal event yet, lowest nonce first. */
    unsettled(signer: HexString, chainId: number): SettlementRecord[];
    /**
     * Close a claim whose transaction can never be mined — the node refused it, or its
     * nonce went to another transaction. The reservation is replaced by `actualCost`, the
     * ledger gets one error event, and the row is deleted in the same transaction: its
     * nonce is free for the next claim, and the same payment can be settled afresh
     * because nothing was ever charged for it. A terminal or unknown row is left alone.
     */
    release(id: HexString, result: {at: number; actualCost: bigint; errorCode: string}): void;
}
function hex(value: unknown, bytes: number): HexString {
    if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
        throw new TypeError(`expected ${bytes}-byte hex`);
    }
    return value.toLowerCase() as HexString;
}
function uint(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("expected safe nonnegative integer");
    return value;
}
function amount(value: unknown): string {
    if (typeof value !== "bigint" || value < 0n) throw new TypeError("expected nonnegative bigint");
    return value.toString();
}
interface Row {
    payment_intent_id: HexString; tx_hash: HexString; signer: HexString; chain_id: number; nonce: number;
    gas: string; max_fee: string; priority_fee: string; payer: HexString; pay_to: HexString;
    amount_base: string; budget_day: string; reserved_wei: string; created_at: number;
    terminal_event_id: number | null; actual_cost: string | null;
}
interface EventRow {
    id: number; at: number; kind: string; payer: HexString; pay_to: HexString; amount_base: string;
    tx_hash: HexString | null; outcome: SettlementEvent["outcome"]; gas_used: string | null; error_code: string | null;
}
export function createSettlementJournal(db: Database, ledger: Ledger): SettlementJournal {
    const select = db.query<Row, [string]>("SELECT * FROM settlement_intents WHERE payment_intent_id = ?");
    const event = db.query<EventRow, [number]>("SELECT * FROM settlement_events WHERE id = ?");
    const spent = db.query<{spent_wei: string}, [string, string]>("SELECT spent_wei FROM budget_days WHERE scope = ? AND day = ?");
    const save = db.query("INSERT INTO budget_days (scope, day, spent_wei) VALUES (?, ?, ?) ON CONFLICT (scope, day) DO UPDATE SET spent_wei = excluded.spent_wei");
    const insert = db.query(`INSERT INTO settlement_intents
        (payment_intent_id, tx_hash, signer, chain_id, nonce, gas, max_fee, priority_fee, payer, pay_to,
         amount_base, budget_day, reserved_wei, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const taken = db.query<{nonce: number}, [string, number, number]>("SELECT nonce FROM settlement_intents WHERE signer = ? AND chain_id = ? AND nonce >= ? ORDER BY nonce");
    const open = db.query<{payment_intent_id: HexString}, [string, number]>("SELECT payment_intent_id FROM settlement_intents WHERE signer = ? AND chain_id = ? AND terminal_event_id IS NULL ORDER BY nonce");
    const remove = db.query("DELETE FROM settlement_intents WHERE payment_intent_id = ?");
    function load(scope: string, day: string): bigint {return BigInt(spent.get(scope, day)?.spent_wei ?? "0");}
    function read(id: HexString): SettlementRecord | null {
        const r = select.get(hex(id, 32));
        if (!r) return null;
        const e = r.terminal_event_id === null ? null : event.get(r.terminal_event_id);
        return {
            paymentIntentId: r.payment_intent_id, txHash: r.tx_hash, signer: r.signer, chainId: r.chain_id,
            nonce: r.nonce, gas: BigInt(r.gas), maxFeePerGas: BigInt(r.max_fee), maxPriorityFeePerGas: BigInt(r.priority_fee),
            payer: r.payer, payTo: r.pay_to, amountBase: BigInt(r.amount_base), budgetDay: r.budget_day,
            reservedWei: BigInt(r.reserved_wei), createdAt: r.created_at, actualCost: r.actual_cost === null ? null : BigInt(r.actual_cost),
            terminal: e ? {id: e.id, at: e.at, kind: e.kind, payer: e.payer, payTo: e.pay_to,
                amountBase: BigInt(e.amount_base), txHash: e.tx_hash, outcome: e.outcome,
                gasUsed: e.gas_used === null ? null : BigInt(e.gas_used), errorCode: e.error_code} : null,
        };
    }
    const claim = db.transaction((input: SettlementInput, limits: SettlementLimits): SettlementRecord => {
        const id = hex(input.paymentIntentId, 32);
        const existing = read(id);
        if (existing) return existing;
        const signer = hex(input.signer, 20), payer = hex(input.payer, 20), payTo = hex(input.payTo, 20);
        const day = new Date(uint(input.createdAt)).toISOString().slice(0, 10);
        const gas = amount(input.gas), fee = amount(input.maxFeePerGas), priority = amount(input.maxPriorityFeePerGas);
        if (input.gas === 0n || input.maxPriorityFeePerGas > input.maxFeePerGas) throw new Error("invalid gas envelope");
        amount(limits.total); amount(limits.payer);
        if (limits.total === 0n || limits.payer === 0n || limits.payer > limits.total) throw new Error("invalid settlement limits");
        const reserved = input.gas * input.maxFeePerGas;
        const scope = `payer:${payer}`;
        if (load(scope, day) + reserved > limits.payer) throw new SettlementBudgetExceeded("payer_budget_exhausted");
        if (load("total", day) + reserved > limits.total) throw new SettlementBudgetExceeded("budget_exhausted");
        insert.run(id, hex(input.txHash, 32), signer, uint(input.chainId), uint(input.nonce), gas, fee, priority,
            payer, payTo, amount(input.amountBase), day, amount(reserved), input.createdAt);
        save.run("total", day, amount(load("total", day) + reserved));
        save.run(scope, day, amount(load(scope, day) + reserved));
        return read(id)!;
    });
    const finish = db.transaction((id: HexString, result: {at: number; gasUsed: bigint; actualCost: bigint; errorCode?: string}): SettlementRecord => {
        const record = read(id);
        if (!record) throw new Error("settlement intent not found");
        if (record.terminal) return record;
        amount(result.actualCost); amount(result.gasUsed); uint(result.at);
        for (const scope of ["total", `payer:${record.payer}`]) {
            save.run(scope, record.budgetDay, amount(load(scope, record.budgetDay) - record.reservedWei + result.actualCost));
        }
        const input: SettlementEventInput = {at: result.at, kind: "settle", payer: record.payer, payTo: record.payTo,
            amountBase: record.amountBase, txHash: record.txHash, gasUsed: result.gasUsed,
            outcome: result.errorCode ? "error" : "settled", errorCode: result.errorCode};
        const e = ledger.record(input);
        db.query("UPDATE settlement_intents SET terminal_event_id = ?, actual_cost = ? WHERE payment_intent_id = ?")
            .run(e.id, amount(result.actualCost), record.paymentIntentId);
        return read(id)!;
    });
    const release = db.transaction((id: HexString, result: {at: number; actualCost: bigint; errorCode: string}): void => {
        const record = read(id);
        if (!record || record.terminal) return;
        amount(result.actualCost); uint(result.at);
        if (!result.errorCode) throw new TypeError("a released claim needs an error code");
        for (const scope of ["total", `payer:${record.payer}`]) {
            save.run(scope, record.budgetDay, amount(load(scope, record.budgetDay) - record.reservedWei + result.actualCost));
        }
        ledger.record({at: result.at, kind: "settle", payer: record.payer, payTo: record.payTo, amountBase: record.amountBase,
            txHash: record.txHash, gasUsed: 0n, outcome: "error", errorCode: result.errorCode});
        remove.run(record.paymentIntentId);
    });
    return {
        get: read,
        nextNonce(signer, chainId, pendingNonce) {
            let nonce = uint(pendingNonce);
            for (const row of taken.all(hex(signer, 20), uint(chainId), nonce)) {
                if (row.nonce !== nonce) break;
                nonce += 1;
            }
            return uint(nonce);
        },
        claim: (input, limits) => claim.immediate(input, limits),
        finish: (id, result) => finish.immediate(id, result),
        unsettled: (signer, chainId) => open.all(hex(signer, 20), uint(chainId)).map((row) => read(row.payment_intent_id)!),
        release: (id, result) => release.immediate(id, result),
    };
}
