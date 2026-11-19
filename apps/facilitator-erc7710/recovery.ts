import {PaymentIntentSingleFlight, readReceiptFeeField} from "@mapae/delegation";
import type {SettlementInput, SettlementJournal, SettlementLimits, SettlementRecord, TransactionEnvelope} from "@mapae/store";
import {SettlementBudgetExceeded} from "@mapae/store";
import {keccak256, parseTransaction, type Hex} from "viem";
import {BROADCAST_LOST, BROADCAST_REFUSED, SettlementBroadcastRefused, SettlementPending, SettlementStorageUnavailable} from "./guards.js";

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
    /** True only when the node's answer to `send` means these bytes are in no pool and never will be. */
    refused: (error: unknown) => boolean;
    wait: (hash: Hex) => Promise<T>;
    failure: (receipt: T) => string | undefined;
}
/** What the sweep needs: no payment is in hand, only the journal's rows and the chain. */
export interface SweepOperations<T extends RecoveryReceipt> {
    pendingNonce: () => Promise<number>;
    receipt: (hash: Hex) => Promise<T | null>;
    failure: (receipt: T, record: SettlementRecord) => string | undefined;
    /**
     * The signed bytes of a transfer of nothing at this envelope's nonce. The same envelope
     * must always give the same bytes: the journal has no column for a filler, so its hash
     * is recomputed from the claim on every pass, and that is how a filler sent by an
     * earlier pass — or by a process that has since restarted — is recognised.
     */
    filler: (envelope: TransactionEnvelope) => Promise<Hex>;
    /** Whether the node took it. Nothing is decided on the answer; it is only counted. */
    send: (serializedTransaction: Hex) => Promise<boolean>;
}
export interface SweepResult {finished: number; released: number; filled: number}
function receiptCost(receipt: RecoveryReceipt): bigint {
    if (typeof receipt.gasUsed !== "bigint" || receipt.gasUsed <= 0n || typeof receipt.effectiveGasPrice !== "bigint") throw new Error("missing receipt fees");
    return readReceiptFeeField(receipt.gasUsed) * readReceiptFeeField(receipt.effectiveGasPrice) + readReceiptFeeField(receipt.l1Fee);
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
                    // An already-known transaction can cause a send error, and so can a
                    // lost answer: for those only the receipt decides. A refusal is a
                    // verdict only for a claim made in this call, whose bytes have never
                    // left this process: no node can hold them, so nobody will be charged
                    // and the nonce must not stay claimed, or every later settlement
                    // queues behind it. A resumed claim may have been broadcast by the
                    // attempt that made it, and a node that does not see that pool can
                    // refuse the same bytes; it is left to the receipt and to the sweep.
                    try {await operations.send(serialized);}
                    catch (error) {
                        if (!replayed && operations.refused(error) && !(await operations.receipt(record.txHash))) {
                            this.journal.release(record.paymentIntentId, {at: this.now(), actualCost: 0n, errorCode: BROADCAST_REFUSED});
                            throw new SettlementBroadcastRefused();
                        }
                    }
                    receipt = await operations.wait(record.txHash);
                }
                if (receipt.transactionHash.toLowerCase() !== record.txHash) throw new Error("receipt hash mismatch");
                const finished = this.journal.finish(record.paymentIntentId, {at: this.now(), gasUsed: receipt.gasUsed,
                    actualCost: receiptCost(receipt), errorCode: operations.failure(receipt)});
                return {record: finished, replayed};
            } catch (error) {
                if (error instanceof SettlementBroadcastRefused) throw error;
                // The sweep released this claim while we waited: its nonce went to a
                // filler, so the hash can never mine and must not be handed out as pending.
                let gone = false;
                try {gone = this.journal.get(record.paymentIntentId) === null;} catch {/* unreadable: pending below */}
                if (gone) throw new SettlementBroadcastRefused();
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

    /**
     * Resolve claims nobody came back for. A claim stays open when its settle call gave
     * up waiting, and only a retry of that same payment used to finish it — so a
     * transaction the node never received held its nonce forever, and every settlement
     * after it sat in the node's queue behind the gap.
     *
     * A claim older than `staleMs` is finished from its receipt when one exists. If it is
     * still open at or above the node's pending nonce, the node has nothing at that nonce
     * and a filler — a transfer of nothing — is sent for it. Nothing is released on that
     * send. A claim is released only on the positive evidence of its filler's own receipt:
     * one nonce takes one transaction, so once the filler is mined the claim never can be.
     * A missing receipt proves nothing through a load-balanced RPC, and is never the reason.
     *
     * The journal keeps no calldata, so re-sending the original is not an option here.
     * One filler per pass, no waiting on it; it runs on the same queue as nonce allocation.
     */
    sweep<T extends RecoveryReceipt>(operations: SweepOperations<T>, staleMs: number): Promise<SweepResult> {
        const run = this.#preparing.then(async () => {
            const result: SweepResult = {finished: 0, released: 0, filled: 0};
            const cutoff = this.now() - staleMs;
            const waiting: SettlementRecord[] = [];
            for (const record of this.journal.unsettled(this.signer, this.chainId)) {
                if (record.createdAt > cutoff) continue;
                const receipt = await operations.receipt(record.txHash);
                if (receipt) {
                    if (receipt.transactionHash.toLowerCase() !== record.txHash) throw new Error("receipt hash mismatch");
                    this.journal.finish(record.paymentIntentId, {at: this.now(), gasUsed: receipt.gasUsed,
                        actualCost: receiptCost(receipt), errorCode: operations.failure(receipt, record)});
                    result.finished += 1;
                    continue;
                }
                const filler = keccak256(await operations.filler(record));
                const landed = await operations.receipt(filler);
                if (landed && landed.transactionHash.toLowerCase() === filler) {
                    this.journal.release(record.paymentIntentId, {at: this.now(), actualCost: receiptCost(landed), errorCode: BROADCAST_LOST});
                    result.released += 1;
                    continue;
                }
                waiting.push(record);
            }
            if (waiting.length === 0) return result;
            const pending = await operations.pendingNonce();
            const basis = waiting.find((record) => record.nonce >= pending);
            if (!basis) return result;
            // A younger claim at that nonce may simply not have been sent yet.
            const holder = this.journal.unsettled(this.signer, this.chainId).find((record) => record.nonce === pending);
            if (holder && holder.createdAt > cutoff) return result;
            // With no holder the gap was left by a released claim; the filler borrows the
            // fees of the first claim queued behind it and nothing needs releasing after.
            if (await operations.send(await operations.filler({...(holder ?? basis), nonce: pending}))) result.filled = 1;
            return result;
        });
        this.#preparing = run.catch(() => {});
        return run;
    }
}
