import {expect, test} from "bun:test";
import {encodeEventTopics, encodeAbiParameters, erc20Abi, type TransactionReceipt} from "viem";
import type {ValidatedDelegatedPayment} from "@mapae/delegation";
import {openStore} from "@mapae/store";
import {receiptFailure, settlementResponse} from "./settlement.js";
import {createPaymentRoutes} from "./routes.js";
import {SettlementUnconfirmed, describeFailure} from "./guards.js";
const A = `0x${"1".repeat(40)}` as const, B = `0x${"2".repeat(40)}` as const;
const TOKEN = `0x${"3".repeat(40)}` as const, ID = `0x${"a".repeat(64)}` as const, HASH = `0x${"b".repeat(64)}` as const;
// Only the receipt validator's fields are used; no cryptographic validation is bypassed in production.
const payment = {paymentIntentId: ID, payer: A, amount: 25n,
    paymentRequirements: {asset: TOKEN, payTo: B}} as ValidatedDelegatedPayment;

test("a mined revert is a terminal error with hash and gas, and remains so through the HTTP route", async () => {
    const s = openStore(":memory:");
    try {
        const errorCode = receiptFailure({status: "reverted", logs: []}, payment);
        expect(errorCode).toBe("settlement_reverted");
        s.settlements.claim({paymentIntentId: ID, txHash: HASH, signer: A, chainId: 91342, nonce: 0,
            gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, payer: A, payTo: B, amountBase: 25n, createdAt: 0}, {total: 2000n, payer: 1000n});
        const r = s.settlements.finish(ID, {at: 1, gasUsed: 50n, actualCost: 100n, errorCode});
        expect(r.terminal).toMatchObject({outcome: "error", txHash: HASH, gasUsed: 50n});
        const app = createPaymentRoutes({validate: () => payment, simulate: async () => {}, settle: async () => settlementResponse(r)});
        const response = await app.request("/settle", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({success: false, transaction: HASH, errorReason: "settlement_reverted"});
        expect(describeFailure(new Error("simulation reverted"))).toEqual({outcome: "rejected", errorCode: "delegation_rejected", transaction: null});
    } finally {s.close();}
});
test("success requires the exact token Transfer; a successful call alone does not credit the seller", () => {
    expect(receiptFailure({status: "success", logs: []}, payment)).toBe("vendor_not_credited");
    const log = {address: TOKEN, topics: encodeEventTopics({abi: erc20Abi, eventName: "Transfer", args: {from: A, to: B}}),
        data: encodeAbiParameters([{type: "uint256"}], [25n])} as TransactionReceipt["logs"][number];
    expect(receiptFailure({status: "success", logs: [log]}, payment)).toBeUndefined();
    expect(receiptFailure({status: "success", logs: [{...log, data: encodeAbiParameters([{type: "uint256"}], [26n])}]}, payment)).toBe("vendor_not_credited");
});

test("an unreadable recovery journal is an explicit unknown verification verdict", async () => {
    const app = createPaymentRoutes({validate: () => payment, simulate: async () => {throw new SettlementUnconfirmed();},
        settle: async () => {throw new Error("must not settle");}});
    const response = await app.request("/verify", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({isValid: false, invalidReason: "settlement_unconfirmed"});
});
