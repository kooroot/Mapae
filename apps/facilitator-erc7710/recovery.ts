import {PaymentIntentSingleFlight, readReceiptFeeField} from "@mapae/delegation";
import type {SettlementInput, SettlementJournal, SettlementLimits, SettlementRecord, TransactionEnvelope} from "@mapae/store";
import {SettlementBudgetExceeded} from "@mapae/store";
import {keccak256, parseTransaction, type Hex} from "viem";
import {SettlementPending, SettlementStorageUnavailable} from "./guards.js";

export interface RecoveryReceipt {
    transactionHash: Hex;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    l1Fee?: unknown;
}
export interface RecoveryOperations<T extends RecoveryReceipt> {
    pendingNonce: () => Promise<number>;
    prepare: (nonce: number) => Promise<Hex>;
    restore: (envelope: TransactionEnvelope) => Promise<Hex>;
    receipt: (hash: Hex) => Promise<T | null>;
    send: (serializedTransaction: Hex) => Promise<Hex>;
    wait: (hash: Hex) => Promise<T>;
    failure: (receipt: T) => string | undefined;
}
export type RecoveryPayment = Pick<SettlementInput, "paymentIntentId" | "payer" | "payTo" | "amountBase">;
/**
 * A resolved row and whether the answer was performed by some other call. `replayed` is
 * true when the journal already held this intent before the call began, terminal or not:
 * the answer belongs to an earlier attempt, and nothing new was broadcast — a resumed
 * claim re-sends the bytes that row already named, never a second transaction. It is true
 * for a concurrent call coalesced into another's operation too: that call performed
 * nothing either, and it is handed the answer the operation produced. So at most one
 * answer per intent is ever unmarked — the one call that settled it.
 *
 * What it is not is a delivery gate on its own: when the first attempt ends
 * {@link SettlementPending} and a later call finishes the claim, *every* successful
 * answer is marked. A seller that ships once per sale dedupes on its own record of the
 * payment intent id; this flag only ever says "this call is not the one that did it".
 */
export interface SettlementResult {record: SettlementRecord; replayed: boolean}

/** Owns one signer's prepare/claim queue. The DB is the authority for nonces and budgets. */
export class SettlementRecovery {
    readonly #inflight = new PaymentIntentSingleFlight<SettlementResult>();
    #preparing: Promise<unknown> = Promise.resolve();
    constructor(
        private readonly journal: SettlementJournal,
        private readonly signer: Hex,
        private readonly chainId: number,
        private readonly limits: SettlementLimits,
        private readonly now: () => number = Date.now,
    ) {}

    /** The journal's row for this intent, if any. An unreadable journal is not-ready, never a verdict. */
    known(intent: Hex): SettlementRecord | null {
        try {return this.journal.get(intent);}
        catch (error) {throw new SettlementStorageUnavailable(error);}
    }

    async settle<T extends RecoveryReceipt>(payment: RecoveryPayment, operations: RecoveryOperations<T>): Promise<SettlementResult> {
        let own = false;
        const result = await this.#inflight.run(payment.paymentIntentId, async () => {
            own = true;
            let replayed = false;
            // Serialize only preparation and the atomic claim, not receipt waiting.
            const preparing = this.#preparing.then(async () => {
                const existing = this.known(payment.paymentIntentId);
                if (existing) {replayed = true; return existing;}
                const pending = await operations.pendingNonce();
                // Allocating the nonce is another read of the journal, and a journal that
                // cannot be read is not-ready on either route — never a rejected delegation
                // with a ledger row, which is what a raw throw from here would become.
                let nonce: number;
                try {nonce = this.journal.nextNonce(this.signer, this.chainId, pending);}
                catch (error) {throw new SettlementStorageUnavailable(error);}
                const serialized = await operations.prepare(nonce);
                const tx = parseTransaction(serialized);
                if (tx.type !== "eip1559" || tx.chainId !== this.chainId || tx.nonce !== nonce ||
                    tx.gas === undefined || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) {
                    throw new Error("prepared transaction does not match the allocated envelope");
                }
                try {
                    return this.journal.claim({...payment, signer: this.signer, chainId: this.chainId, nonce,
                        gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
                        txHash: keccak256(serialized), createdAt: this.now()}, this.limits);
                } catch (error) {
                    if (error instanceof SettlementBudgetExceeded) throw error;
                    throw new SettlementStorageUnavailable(error);
                }
            });
            this.#preparing = preparing.catch(() => {});
            const record = await preparing;
            if (record.terminal) return {record, replayed};
            try {
                let receipt = await operations.receipt(record.txHash);
                if (!receipt) {
                    const serialized = await operations.restore(record);
                    if (keccak256(serialized) !== record.txHash) throw new Error("reconstructed transaction hash mismatch");
                    // An already-known transaction can cause a send error. Whether the
                    // answer was lost or the node refused it, only its receipt decides.
                    try {await operations.send(serialized);} catch { /* inspect original hash below */ }
                    receipt = await operations.wait(record.txHash);
                }
                if (receipt.transactionHash.toLowerCase() !== record.txHash) throw new Error("receipt hash mismatch");
                if (typeof receipt.gasUsed !== "bigint" || receipt.gasUsed <= 0n || typeof receipt.effectiveGasPrice !== "bigint") throw new Error("missing receipt fees");
                const actualCost = readReceiptFeeField(receipt.gasUsed) * readReceiptFeeField(receipt.effectiveGasPrice)
                    + readReceiptFeeField(receipt.l1Fee);
                const finished = this.journal.finish(record.paymentIntentId, {at: this.now(), gasUsed: receipt.gasUsed,
                    actualCost, errorCode: operations.failure(receipt)});
                return {record: finished, replayed};
            } catch {
                // The claim is durable and the transaction may be on the network; only
                // our wait, our reconstruction, or the terminal write gave up. Includes
                // disk failure after a mined receipt: keep the claim and let the next
                // same-intent request finish the atomic accounting. Collapsing this into
                // a rejection would tell the seller the payer was not charged, which is
                // exactly what nobody knows yet — so the hash goes out as pending.
                throw new SettlementPending(record.txHash);
            }
        });
        // A call coalesced into another's operation ran none of the above: it neither read
        // the journal nor broadcast anything, and the answer it is handed was performed by
        // the call that owns the operation. Leaving it unmarked would let two live requests
        // for one payment both claim to be the settling one.
        return own ? result : {...result, replayed: true};
    }
}
