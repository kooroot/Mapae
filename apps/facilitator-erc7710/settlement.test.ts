import {expect, test} from "bun:test";
import {encodeEventTopics, encodeAbiParameters, erc20Abi, type TransactionReceipt} from "viem";
import {PaymentValidationError, type ValidatedDelegatedPayment} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import {openStore, type MapaeStore, type SettlementRecord} from "@mapae/store";
import {receiptFailure, settlementResponse, verifyKnownSettlement} from "./settlement.js";
import {createPaymentRoutes} from "./routes.js";
import {SettlementStorageUnavailable, describeFailure} from "./guards.js";
const A = `0x${"1".repeat(40)}` as const, B = `0x${"2".repeat(40)}` as const;
const TOKEN = `0x${"3".repeat(40)}` as const, ID = `0x${"a".repeat(64)}` as const, HASH = `0x${"b".repeat(64)}` as const;
// Only the receipt validator's fields are used; no cryptographic validation is bypassed in production.
const payment = {paymentIntentId: ID, payer: A, amount: 25n,
    paymentRequirements: {asset: TOKEN, payTo: B}} as ValidatedDelegatedPayment;
const JSON_HEADERS = {"content-type": "application/json"};

/** A claimed row for the one intent, terminal only once `finish` is called on it. */
function claimed(s: MapaeStore): SettlementRecord {
    return s.settlements.claim({paymentIntentId: ID, txHash: HASH, signer: A, chainId: 91342, nonce: 0,
        gas: 100n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, payer: A, payTo: B, amountBase: 25n, createdAt: 0},
        {total: 2000n, payer: 1000n});
}

test("a mined revert is a terminal error with hash and gas, and remains so through the HTTP route", async () => {
    const s = openStore(":memory:");
    try {
        const errorCode = receiptFailure({status: "reverted", logs: []}, payment);
        expect(errorCode).toBe("settlement_reverted");
        claimed(s);
        const r = s.settlements.finish(ID, {at: 1, gasUsed: 50n, actualCost: 100n, errorCode});
        expect(r.terminal).toMatchObject({outcome: "error", txHash: HASH, gasUsed: 50n});
        const app = createPaymentRoutes({validate: () => payment, simulate: async () => {}, settle: async () => settlementResponse(r, false)});
        const response = await app.request("/settle", {method: "POST", headers: JSON_HEADERS, body: "{}"});
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({success: false, transaction: HASH, errorReason: "settlement_reverted"});
    } finally {s.close();}
});
test("success requires the exact token Transfer; a successful call alone does not credit the seller", () => {
    expect(receiptFailure({status: "success", logs: []}, payment)).toBe("vendor_not_credited");
    const log = {address: TOKEN, topics: encodeEventTopics({abi: erc20Abi, eventName: "Transfer", args: {from: A, to: B}}),
        data: encodeAbiParameters([{type: "uint256"}], [25n])} as TransactionReceipt["logs"][number];
    expect(receiptFailure({status: "success", logs: [log]}, payment)).toBeUndefined();
    expect(receiptFailure({status: "success", logs: [{...log, data: encodeAbiParameters([{type: "uint256"}], [26n])}]}, payment)).toBe("vendor_not_credited");
});

test("only a replayed answer says so, and it is the only difference between the two bodies", () => {
    // The seller counts one sale once. A recovered settlement is otherwise byte-identical
    // to a fresh one, so the flag is the whole signal — and its absence must be the
    // default, never an omitted `false` the seller could read either way.
    const s = openStore(":memory:");
    try {
        claimed(s);
        const r = s.settlements.finish(ID, {at: 1, gasUsed: 50n, actualCost: 100n, errorCode: undefined});
        const fresh = settlementResponse(r, false);
        expect(fresh).toEqual({success: true, transaction: HASH, network: GIWA_SEPOLIA_CAIP2, payer: A});
        expect("replayed" in fresh).toBe(false);
        expect(settlementResponse(r, true)).toEqual({...fresh, replayed: true});
    } finally {s.close();}
});

test("a settlement that already ended on chain as a failure verifies as invalid_transaction_state", async () => {
    // The leaf's attempt is over: /settle answers that same failure, and re-simulating
    // cannot make the payment valid again. A row that succeeded, or one still unresolved,
    // is left alone — /settle recovers it, and re-simulating a consumed or expired leaf
    // would refuse a payment whose receipt is still there to be found.
    const s = openStore(":memory:");
    try {
        const pending = claimed(s);
        expect(verifyKnownSettlement(pending)).toBeUndefined();
        const settled = s.settlements.finish(ID, {at: 1, gasUsed: 50n, actualCost: 100n, errorCode: undefined});
        expect(verifyKnownSettlement(settled)).toBeUndefined();
        for (const errorCode of ["settlement_reverted", "vendor_not_credited"]) {
            const failed = {...settled, terminal: {...settled.terminal!, outcome: "error" as const, errorCode}};
            const raised = (() => {try {verifyKnownSettlement(failed); return undefined;} catch (error) {return error;}})();
            expect(raised).toBeInstanceOf(PaymentValidationError);
            expect((raised as PaymentValidationError).reason).toBe("invalid_transaction_state");
            // And the routes carry that word, unchanged, as the verify refusal.
            const app = createPaymentRoutes({validate: () => payment,
                simulate: async () => verifyKnownSettlement(failed), settle: async () => {throw new Error("not reached");}});
            const verify = await app.request("/verify", {method: "POST", headers: JSON_HEADERS, body: "{}"});
            expect(verify.status).toBe(200);
            expect(await verify.json()).toEqual({isValid: false, invalidReason: "invalid_transaction_state"});
        }
    } finally {s.close();}
});

test("a body that cannot be read is invalid_payload on both routes, under the route's own shape", async () => {
    // Neither route may answer a 4xx: /settle's non-2xx reads as "the answer was lost" —
    // a payment in doubt — for a request that was never even parsed.
    const app = createPaymentRoutes({validate: () => payment, simulate: async () => {}, settle: async () => {throw new Error("not reached");}});
    const cases: Array<{headers: Record<string, string>; body: string}> = [
        {headers: {"content-type": "text/plain"}, body: "{}"},
        {headers: JSON_HEADERS, body: ""},
        {headers: JSON_HEADERS, body: "{not json"},
        {headers: {...JSON_HEADERS, "content-length": "150001"}, body: "{}"},
    ];
    for (const {headers, body} of cases) {
        const verify = await app.request("/verify", {method: "POST", headers, body});
        expect(verify.status).toBe(200);
        expect(await verify.json()).toEqual({isValid: false, invalidReason: "invalid_payload"});
        const settle = await app.request("/settle", {method: "POST", headers, body});
        expect(settle.status).toBe(200);
        expect(await settle.json()).toEqual({success: false, transaction: "", network: GIWA_SEPOLIA_CAIP2,
            errorReason: "invalid_payload"});
    }
});

test("a throw neither route expected is its own unexpected_*_error, with a transaction on the wire", async () => {
    // The one answer that says "this is ours, not yours": no verdict on the delegation, and
    // `transaction: ""` because nothing was broadcast before it.
    const boom = async () => {throw new Error("boom");};
    const app = createPaymentRoutes({validate: () => payment, simulate: boom, settle: boom});
    const verify = await app.request("/verify", {method: "POST", headers: JSON_HEADERS, body: "{}"});
    expect(await verify.json()).toEqual({isValid: false, invalidReason: "unexpected_verify_error"});
    const settle = await app.request("/settle", {method: "POST", headers: JSON_HEADERS, body: "{}"});
    expect(await settle.json()).toEqual({success: false, transaction: "", network: GIWA_SEPOLIA_CAIP2,
        errorReason: "unexpected_settle_error"});
    expect(describeFailure(new Error("boom"), "settle")).toEqual({outcome: "rejected",
        errorCode: "unexpected_settle_error", transaction: ""});
});

test("an unreadable recovery journal is not-ready on both routes: nothing examined, nothing charged, no hash to name", async () => {
    // The journal records the hash before the broadcast, so a row that cannot be read
    // is a facilitator that cannot look, not a payment in doubt — and a pending answer
    // without a hash is the one shape x402 v2 forbids.
    const unreadable = async () => {throw new SettlementStorageUnavailable(new Error("database is locked"));};
    const app = createPaymentRoutes({validate: () => payment, simulate: unreadable, settle: unreadable});
    const verify = await app.request("/verify", {method: "POST", headers: JSON_HEADERS, body: "{}"});
    expect(verify.status).toBe(503);
    expect(await verify.json()).toEqual({isValid: false, invalidReason: "facilitator_not_ready"});
    const settle = await app.request("/settle", {method: "POST", headers: JSON_HEADERS, body: "{}"});
    expect(settle.status).toBe(200);
    expect(await settle.json()).toEqual({success: false, transaction: "", network: GIWA_SEPOLIA_CAIP2, errorReason: "facilitator_not_ready"});
});
