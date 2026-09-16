import {reconcileSettlementReceipt, type ValidatedDelegatedPayment, type Erc7710SettleResponse} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import type {SettlementRecord} from "@mapae/store";
import type {TransactionReceipt} from "viem";

/** A mined revert cost gas; it is not a pre-broadcast rejection. */
export function receiptFailure(receipt: Pick<TransactionReceipt, "status" | "logs">, payment: ValidatedDelegatedPayment): string | undefined {
    if (receipt.status !== "success") return "settlement_reverted";
    const discrepancies = reconcileSettlementReceipt({logs: receipt.logs, asset: payment.paymentRequirements.asset,
        payer: payment.payer, payTo: payment.paymentRequirements.payTo, amount: payment.amount});
    return discrepancies.length ? "vendor_not_credited" : undefined;
}

export function settlementResponse(record: SettlementRecord): Erc7710SettleResponse {
    if (!record.terminal) throw new Error("settlement is not terminal");
    return {
        success: record.terminal.outcome === "settled",
        network: GIWA_SEPOLIA_CAIP2,
        payer: record.payer,
        transaction: record.txHash,
        ...(record.terminal.errorCode ? {errorReason: record.terminal.errorCode} : {}),
    };
}
