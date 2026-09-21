import {
    PaymentValidationError,
    SETTLEMENT_REVERTED,
    VENDOR_NOT_CREDITED,
    reconcileSettlementReceipt,
    type ValidatedDelegatedPayment,
    type Erc7710SettleResponse,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {SettlementRecord} from "@mapae/store";
import type {TransactionReceipt} from "viem";

/** A mined revert cost gas; it is not a pre-broadcast rejection. */
export function receiptFailure(receipt: Pick<TransactionReceipt, "status" | "logs">, payment: ValidatedDelegatedPayment): string | undefined {
    if (receipt.status !== "success") return SETTLEMENT_REVERTED;
    const discrepancies = reconcileSettlementReceipt({logs: receipt.logs, asset: payment.paymentRequirements.asset,
        payer: payment.payer, payTo: payment.paymentRequirements.payTo, amount: payment.amount});
    return discrepancies.length ? VENDOR_NOT_CREDITED : undefined;
}

/**
 * `/verify` for an intent the journal already knows. A row that ended on chain as a
 * failure — a mined revert, a receipt with no `Transfer` to the seller — is a verdict:
 * this leaf's attempt is over, `/settle` returns that same failure, and re-verifying
 * cannot make it valid, so the §9 word `invalid_transaction_state` goes out. Any other
 * row — a success, or a claim not yet resolved — is left to `/settle` to recover, and
 * verifies as it did the first time: re-simulating an already consumed or expired leaf
 * would refuse a payment whose receipt is still there to be found.
 */
export function verifyKnownSettlement(record: SettlementRecord): void {
    if (record.terminal?.errorCode) {
        throw new PaymentValidationError(
            "invalid_transaction_state",
            `settlement ${record.txHash} already ended as ${record.terminal.errorCode}`,
        );
    }
}

/** The wire's answer for a resolved row; `replayed` says the row predates this call. */
export function settlementResponse(record: SettlementRecord, replayed: boolean): Erc7710SettleResponse {
    if (!record.terminal) throw new Error("settlement is not terminal");
    return {
        success: record.terminal.outcome === "settled",
        network: GIWA_SEPOLIA_CAIP2,
        payer: record.payer,
        transaction: record.txHash,
        ...(record.terminal.errorCode ? {errorReason: record.terminal.errorCode} : {}),
        ...(replayed ? {replayed: true as const} : {}),
    };
}
