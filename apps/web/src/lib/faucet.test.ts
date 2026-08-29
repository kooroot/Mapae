import {describe, expect, test} from "bun:test";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Address, Hex} from "viem";
import {
    FAUCET_COPY,
    TESTNET_TOKEN,
    interpretTopUp,
    topUpMessage,
    topUpPermissionContext,
} from "./faucet";
import {LOCALES} from "./i18n";

const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
const AGENT = "0x0000000000000000000000000000000000000b22" as Address;
const TARGET = "1000000000";

const root = {
    delegate: AGENT,
    delegator: OWNER,
    authority: `0x${"0".repeat(64)}` as Hex,
    caveats: [],
    salt: `0x${"0".repeat(64)}` as Hex,
    signature: "0x" as Hex,
};

describe("interpretTopUp (the sponsor's reply as an outcome)", () => {
    test("a mint reports the minted amount and its transaction", () => {
        const outcome = interpretTopUp({
            ok: true,
            body: {
                status: "already_deployed",
                fundingTransaction: "0xabc",
                mintedBase: "250000000",
                targetBase: TARGET,
            },
        });
        expect(outcome).toEqual({kind: "minted", amount: 250_000_000n, transaction: "0xabc"});
    });

    test("nothing minted at a live target means the account is already full", () => {
        expect(
            interpretTopUp({
                ok: true,
                body: {status: "already_deployed", mintedBase: "0", targetBase: TARGET},
            }),
        ).toEqual({kind: "at_target", target: 1_000_000_000n});
    });

    test("a zero target is the faucet being off, not an empty account", () => {
        expect(
            interpretTopUp({
                ok: true,
                body: {status: "deployed", transaction: "0x1", mintedBase: "0", targetBase: "0"},
            }),
        ).toEqual({kind: "faucet_off"});
    });

    test("the 24-hour refusal is its own outcome, every other refusal keeps its reason", () => {
        expect(interpretTopUp({ok: false, body: {reason: "faucet_recently_used"}})).toEqual({
            kind: "recently_used",
        });
        expect(interpretTopUp({ok: false, body: {reason: "budget_exhausted"}})).toEqual({
            kind: "refused",
            reason: "budget_exhausted",
        });
        expect(interpretTopUp({ok: false, body: {}})).toEqual({kind: "refused"});
    });

    test("a success without well-formed amounts is refused rather than guessed at", () => {
        expect(interpretTopUp({ok: true, body: {status: "deployed"}})).toEqual({kind: "refused"});
        expect(
            interpretTopUp({ok: true, body: {mintedBase: "1e9", targetBase: TARGET}}),
        ).toEqual({kind: "refused"});
        expect(
            interpretTopUp({ok: true, body: {mintedBase: "-5", targetBase: TARGET}}),
        ).toEqual({kind: "refused"});
    });
});

describe("topUpPermissionContext", () => {
    test("sends the signed root alone — a chain of one", () => {
        const decoded = decodeDelegations(topUpPermissionContext(root));
        expect(decoded).toHaveLength(1);
        expect(decoded[0]?.delegator).toBe(OWNER);
        expect(decoded[0]?.delegate).toBe(AGENT);
    });
});

describe("faucet copy", () => {
    test("names the token as testnet money in full, never as bare USDC", () => {
        for (const locale of LOCALES) {
            const t = FAUCET_COPY[locale];
            const sentences = [
                t.action,
                t.busy,
                t.hint,
                t.minted("1000.0"),
                t.atTarget("1000.0"),
                t.faucetOff,
                t.recentlyUsed,
                t.budgetExhausted,
                t.feeTooHigh,
                t.failed,
                t.viewTransaction,
            ];
            for (const sentence of sentences) {
                for (const match of sentence.matchAll(/USDC[^,]*(?:,[^)]*\))?/g)) {
                    // Every USDC is the full label: "tUSDC (testnet, not real money)".
                    expect(sentence.slice(match.index - 1)).toStartWith(TESTNET_TOKEN[locale]);
                }
            }
            expect(t.hint).toContain("1000.0");
        }
    });

    test("the outcome sentence carries the amount that was actually minted", () => {
        const minted = {kind: "minted", amount: 1_000_000_000n} as const;
        expect(topUpMessage(minted, "en")).toBe(
            "Received 1000.0 tUSDC (testnet, not real money).",
        );
        expect(topUpMessage(minted, "ko")).toBe("1000.0 tUSDC (테스트넷, 실제 돈 아님)를 받았습니다.");
        expect(topUpMessage({kind: "at_target", target: 1_000_000_000n}, "ko")).toContain(
            "1000.0 tUSDC (테스트넷, 실제 돈 아님) 이상",
        );
    });

    test("the 24-hour refusal reads as policy, and refusals map to copy by reason", () => {
        expect(topUpMessage({kind: "recently_used"}, "en")).toContain("last 24 hours");
        expect(topUpMessage({kind: "recently_used"}, "ko")).toContain("24시간");
        expect(topUpMessage({kind: "refused", reason: "sponsor_unfunded"}, "en")).toBe(
            FAUCET_COPY.en.budgetExhausted,
        );
        expect(topUpMessage({kind: "refused", reason: "bootstrap_disabled"}, "ko")).toBe(
            FAUCET_COPY.ko.faucetOff,
        );
        expect(topUpMessage({kind: "refused", reason: "something_new"}, "en")).toBe(
            FAUCET_COPY.en.failed,
        );
        expect(topUpMessage({kind: "faucet_off"}, "en")).toBe(FAUCET_COPY.en.faucetOff);
    });
});
