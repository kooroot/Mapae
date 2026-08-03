import {describe, expect, test} from "bun:test";
import {toTokenAmount} from "@mapae/shared";
import {
    TRANSFER_EVENT_TOPIC,
    reconcileSettlement,
    reconcileSettlementReceipt,
    type SettlementSnapshot,
} from "./settlement-evidence.js";

const PAYER = "0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382";
const VENDOR = "0x0229346e91a07EA24A54704F094D293E43E9d302";

const AMOUNT = toTokenAmount("1.00");

const before: SettlementSnapshot = {
    payerToken: toTokenAmount("26.5"),
    payerNative: 0n,
    vendorToken: toTokenAmount("3.5"),
    relayerNonce: 41,
};

/** A settlement that went exactly as the product claims it does. */
function clean(overrides: Partial<SettlementSnapshot> = {}): SettlementSnapshot {
    return {
        payerToken: before.payerToken - AMOUNT,
        payerNative: before.payerNative,
        vendorToken: before.vendorToken + AMOUNT,
        relayerNonce: before.relayerNonce + 1,
        ...overrides,
    };
}

function codes(after: SettlementSnapshot, amount = AMOUNT): string[] {
    return reconcileSettlement({before, after, amount, payer: PAYER, vendor: VENDOR}).map(
        (problem) => problem.code,
    );
}

/**
 * The function that decides whether a GIWA run counts as proof.
 *
 * A receipt with `status: success` says nothing about whether the right amount reached
 * the right address, or who paid the gas — so the verdict is taken from the difference
 * between two independent reads of chain state, not from anything the settlement path
 * reported about itself.
 */
describe("reconcileSettlement", () => {
    test("a settlement that matches the claim has nothing to report", () => {
        expect(reconcileSettlement({before, after: clean(), amount: AMOUNT, payer: PAYER, vendor: VENDOR})).toEqual([]);
    });

    test("catches a payer debit that is not the invoiced amount", () => {
        expect(codes(clean({payerToken: before.payerToken - toTokenAmount("2.0")}))).toContain(
            "PAYER_DEBIT",
        );
    });

    test("an over-payment inside the cap is still a discrepancy", () => {
        // The caveat is a ceiling, not the invoice. A transfer larger than the 402 asked
        // for can sit comfortably inside a 3.0 cap — which is precisely why the amount is
        // compared for equality rather than with an inequality.
        const over = toTokenAmount("2.5");
        const after = {
            ...clean(),
            payerToken: before.payerToken - over,
            vendorToken: before.vendorToken + over,
        };
        expect(codes(after)).toEqual(["PAYER_DEBIT", "VENDOR_CREDIT"]);
    });

    test("payer debited but vendor not credited — money left, nobody received it", () => {
        // Neither check substitutes for the other: a debit alone does not show the funds
        // reached the payee.
        expect(codes(clean({vendorToken: before.vendorToken}))).toEqual(["VENDOR_CREDIT"]);
    });

    test("vendor credited but payer untouched — someone else paid", () => {
        expect(codes(clean({payerToken: before.payerToken}))).toEqual(["PAYER_DEBIT"]);
    });

    test("catches the payer spending gas — the demo's central claim", () => {
        // If this check silently inverted, a run where the payer funded its own gas would
        // report PASS and the product's headline claim would be false underneath it.
        //
        // The realistic shape of that failure is a payer that was funded by mistake and
        // then spent: the balance goes *down*. A check written as "flag only if it grew"
        // passes such a run, so the falling direction is the one that has to be pinned —
        // and it needs a non-zero starting balance to be expressible at all.
        const funded = {...before, payerNative: 10n ** 16n};
        const spent = {
            ...clean(),
            payerNative: funded.payerNative - 170_000_000_000_000n, // ~a settlement's gas
        };
        const problems = reconcileSettlement({
            before: funded,
            after: spent,
            amount: AMOUNT,
            payer: PAYER,
            vendor: VENDOR,
        });
        expect(problems.map((p) => p.code)).toEqual(["PAYER_PAID_GAS"]);
        expect(problems[0]?.detail).toContain("must never fund gas");
    });

    test("a payer whose native balance grew is also unexplained", () => {
        expect(codes(clean({payerNative: before.payerNative + 10n}))).toEqual(["PAYER_PAID_GAS"]);
    });

    test("no broadcast at all is a failure, not a pass", () => {
        // Zero means the settlement did not come from this relayer — the balances moved
        // by some path this run cannot account for.
        expect(codes(clean({relayerNonce: before.relayerNonce}))).toEqual(["RELAYER_NONCE"]);
    });

    test("a second transaction in the same window breaks attribution", () => {
        const problems = reconcileSettlement({
            before,
            after: clean({relayerNonce: before.relayerNonce + 2}),
            amount: AMOUNT,
            payer: PAYER,
            vendor: VENDOR,
        });
        expect(problems.map((p) => p.code)).toEqual(["RELAYER_NONCE"]);
        expect(problems[0]?.detail).toContain("shared this window");
    });

    test("reports every mismatch at once rather than stopping at the first", () => {
        // An operator looking at a failed run needs the whole picture; one code at a time
        // turns a single investigation into four.
        expect(codes({payerToken: before.payerToken, payerNative: 5n, vendorToken: before.vendorToken, relayerNonce: before.relayerNonce}).sort()).toEqual(
            ["PAYER_DEBIT", "PAYER_PAID_GAS", "RELAYER_NONCE", "VENDOR_CREDIT"],
        );
    });

    test("refuses a zero or negative amount instead of passing it", () => {
        // Every check above holds trivially against a snapshot where nothing happened, so
        // a zero-amount reconciliation would return [] and read as proof.
        const unchanged = {...before};
        expect(() => reconcileSettlement({before, after: unchanged, amount: 0n})).toThrow(
            "positive amount",
        );
        expect(() => reconcileSettlement({before, after: unchanged, amount: -1n})).toThrow(
            "positive amount",
        );
    });

    test("refuses to judge a payment to itself", () => {
        // Self-payment nets to zero, so the debit and credit checks cannot both hold.
        // Reporting that as a mismatch would send the operator hunting for a transfer bug.
        expect(() =>
            reconcileSettlement({before, after: clean(), amount: AMOUNT, payer: PAYER, vendor: PAYER}),
        ).toThrow("cannot be reconciled");
    });

    test("the payer/vendor identity check is case-insensitive", () => {
        expect(() =>
            reconcileSettlement({
                before,
                after: clean(),
                amount: AMOUNT,
                payer: PAYER.toLowerCase(),
                vendor: PAYER.toUpperCase(),
            }),
        ).toThrow("cannot be reconciled");
    });
});

describe("reconcileSettlementReceipt — per-transaction vendor credit evidence", () => {
    const ASSET = "0xcfeb694719A09caeb80798e2011298F29CDa4e92";
    const OTHER_CONTRACT = "0x00000000000000000000000000000000000000AA";
    const OTHER_RECIPIENT = "0x2000000000000000000000000000000000000009";

    const pad = (address: string) =>
        `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
    const value = (amount: bigint) => `0x${amount.toString(16).padStart(64, "0")}`;

    function transferLog(overrides: {
        address?: string;
        from?: string;
        to?: string;
        amount?: bigint;
    } = {}) {
        return {
            address: overrides.address ?? ASSET,
            topics: [
                TRANSFER_EVENT_TOPIC,
                pad(overrides.from ?? PAYER),
                pad(overrides.to ?? VENDOR),
            ],
            data: value(overrides.amount ?? AMOUNT),
        };
    }

    function receiptCodes(logs: Array<ReturnType<typeof transferLog>>): string[] {
        return reconcileSettlementReceipt({
            logs,
            asset: ASSET,
            payer: PAYER,
            payTo: VENDOR,
            amount: AMOUNT,
        }).map((problem) => problem.code);
    }

    test("a receipt with the exact Transfer(payer → vendor, amount) is evidence", () => {
        expect(receiptCodes([transferLog()])).toEqual([]);
    });

    test("a mined receipt with no Transfer at all is the false-return token case", () => {
        // The audited hazard: a token that returns `false` instead of reverting makes
        // the redemption succeed as a call — status "success", allowance consumed —
        // while moving nothing. The absence of the Transfer event is the one trace
        // that distinguishes it inside the transaction's own receipt.
        expect(receiptCodes([])).toEqual(["VENDOR_CREDIT"]);
    });

    test("a Transfer of the wrong amount is not evidence", () => {
        expect(receiptCodes([transferLog({amount: AMOUNT - 1n})])).toEqual(["VENDOR_CREDIT"]);
    });

    test("a Transfer to someone else is not evidence", () => {
        expect(receiptCodes([transferLog({to: OTHER_RECIPIENT})])).toEqual(["VENDOR_CREDIT"]);
    });

    test("a matching event emitted by a different contract is not evidence", () => {
        // Any contract can emit a log with the ERC-20 Transfer topic and arbitrary
        // topics; only the asset's own logs speak for the asset.
        expect(receiptCodes([transferLog({address: OTHER_CONTRACT})])).toEqual(["VENDOR_CREDIT"]);
    });

    test("two matching transfers cannot be attributed to one payment", () => {
        expect(receiptCodes([transferLog(), transferLog()])).toEqual(["VENDOR_CREDIT"]);
    });

    test("unrelated logs around the matching one do not disturb the verdict", () => {
        expect(
            receiptCodes([
                transferLog({address: OTHER_CONTRACT}),
                transferLog(),
                transferLog({to: OTHER_RECIPIENT, amount: 5n}),
            ]),
        ).toEqual([]);
    });

    test("an ERC-721-style 4-topic Transfer is not a credit and does not throw", () => {
        // ERC-20 Transfer indexes from/to and carries amount in data; ERC-721 indexes
        // the tokenId as a third topic and leaves data "0x". A filter that ignores the
        // topic count matches the 721 log, then BigInt("0x") throws a SyntaxError —
        // which in the facilitator escapes reconcile entirely and mislabels a mined
        // settlement as delegation_rejected instead of vendor_not_credited.
        const erc721Like = {
            address: ASSET,
            topics: [TRANSFER_EVENT_TOPIC, pad(PAYER), pad(VENDOR), value(1n)],
            data: "0x",
        };
        expect(() => receiptCodes([erc721Like])).not.toThrow();
        expect(receiptCodes([erc721Like])).toEqual(["VENDOR_CREDIT"]);
    });

    test("a matching topic set with non-numeric data is not a credit and does not throw", () => {
        const garbageData = {
            address: ASSET,
            topics: [TRANSFER_EVENT_TOPIC, pad(PAYER), pad(VENDOR)],
            data: "0xnothex",
        };
        expect(() => receiptCodes([garbageData])).not.toThrow();
        expect(receiptCodes([garbageData])).toEqual(["VENDOR_CREDIT"]);
    });

    test("address comparison is case-insensitive", () => {
        const log = transferLog();
        expect(
            reconcileSettlementReceipt({
                logs: [log],
                asset: ASSET.toLowerCase(),
                payer: PAYER.toUpperCase().replace("0X", "0x"),
                payTo: VENDOR.toLowerCase(),
                amount: AMOUNT,
            }).map((p) => p.code),
        ).toEqual([]);
    });
});
