import {describe, expect, test} from "bun:test";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {
    FAUCET_ETH_AMOUNT_WEI,
    FAUCET_ETH_WINDOW_MS,
    FAUCET_LIMITS,
    FAUCET_MISSIONS,
    FAUCET_MUSDC_MISSIONS,
    FAUCET_REFUSALS,
    FAUCET_TARGET_BASE,
    FAUCET_WINDOW_MS,
    isFaucetMissionId,
    parseFaucetAccount,
    parseFaucetClaimView,
    parseFaucetMissionList,
    parseFaucetRefusal,
    parseFaucetStatus,
    planTopUp,
} from "./faucet-policy.js";

const ACCOUNT = "0x0229346e91a07EA24A54704F094D293E43E9d302" as const;
const OTHER = "0x5F5F6B4E5a9e9aB2eE0e3b8C1F0C7d6B4a3F2E1D" as const;
const T0 = 1_756_400_000_000;

describe("faucet constants", () => {
    test("the target is 1000 tUSDC in the token's own decimals", () => {
        expect(MOCK_USDC.decimals).toBe(6);
        expect(FAUCET_TARGET_BASE).toBe(toTokenAmount("1000"));
        expect(FAUCET_TARGET_BASE).toBe(1_000_000_000n);
    });

    test("the window is one rolling day", () => {
        expect(FAUCET_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    });
});

describe("planTopUp", () => {
    test("mints the shortfall when the balance is below the target", () => {
        expect(planTopUp({balance: 0n, target: FAUCET_TARGET_BASE})).toBe(FAUCET_TARGET_BASE);
        expect(planTopUp({balance: 100_000n, target: FAUCET_TARGET_BASE})).toBe(999_900_000n);
        expect(planTopUp({balance: FAUCET_TARGET_BASE - 1n, target: FAUCET_TARGET_BASE})).toBe(1n);
    });

    test("mints nothing at or above the target", () => {
        expect(planTopUp({balance: FAUCET_TARGET_BASE, target: FAUCET_TARGET_BASE})).toBe(0n);
        expect(planTopUp({balance: FAUCET_TARGET_BASE * 3n, target: FAUCET_TARGET_BASE})).toBe(0n);
    });

    test("refuses negative inputs instead of minting a negative shortfall", () => {
        expect(() => planTopUp({balance: -1n, target: FAUCET_TARGET_BASE})).toThrow(/non-negative/);
        expect(() => planTopUp({balance: 0n, target: -1n})).toThrow(/non-negative/);
    });
});

describe("faucet.mapae.io contract", () => {
    const PAYER = "0x00000000000000000000000000000000000000b2" as const;
    const HASH = `0x${"ab".repeat(32)}` as const;
    const status = {
        musdc: {enabled: true, targetBase: String(FAUCET_TARGET_BASE), windowMs: FAUCET_WINDOW_MS, missions: ["x_follow_mapae"]},
        eth: {enabled: false, amountWei: String(FAUCET_ETH_AMOUNT_WEI), windowMs: FAUCET_ETH_WINDOW_MS, missions: [], minMainnetNonce: 1},
    };

    test("ETH is 0.05 per claim, once a week; the follow mission links the official account", () => {
        expect(FAUCET_ETH_AMOUNT_WEI).toBe(5n * 10n ** 16n);
        expect(FAUCET_ETH_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(FAUCET_MISSIONS.x_follow_mapae).toEqual({kind: "honour", href: "https://x.com/intent/follow?screen_name=mapae_io"});
        expect(FAUCET_MUSDC_MISSIONS).toEqual(["x_follow_mapae"]);
        expect(FAUCET_LIMITS.eth.perIp).toBeLessThan(FAUCET_LIMITS.eth.perSubnet);
    });

    test("a mission list names registry ids only, so a typo refuses boot", () => {
        expect(parseFaucetMissionList(undefined)).toEqual([]);
        expect(parseFaucetMissionList(" , ")).toEqual([]);
        expect(parseFaucetMissionList("x_follow_mapae, x_follow_mapae")).toEqual(["x_follow_mapae"]);
        expect(() => parseFaucetMissionList("x_follow_mapae,discord_join")).toThrow(/discord_join/);
        expect(isFaucetMissionId("toString")).toBe(false);
        expect(isFaucetMissionId("__proto__")).toBe(false);
    });

    test("parseFaucetStatus keeps exactly the promised fields", () => {
        expect(parseFaucetStatus({...status, extra: 1})).toEqual(status as never);
        expect(() => parseFaucetStatus({...status, eth: {...status.eth, missions: ["unknown"]}})).toThrow();
        expect(() => parseFaucetStatus({...status, musdc: {...status.musdc, targetBase: "1e9"}})).toThrow();
        expect(() => parseFaucetStatus({...status, eth: {...status.eth, enabled: "true"}})).toThrow();
        expect(() => parseFaucetStatus({...status, musdc: {...status.musdc, windowMs: 0}})).toThrow();
        expect(() => parseFaucetStatus(null)).toThrow();
    });

    test("parseFaucetClaimView accepts each state and refuses a wrong kind or shape", () => {
        const view = {kind: "musdc", state: "confirmed", amount: "1000000000", recipient: PAYER, transaction: HASH, nextAt: T0};
        expect(parseFaucetClaimView(view, "musdc")).toEqual(view as never);
        expect(parseFaucetClaimView({kind: "eth", state: "already_enough", amount: "0", recipient: ACCOUNT})).toEqual({
            kind: "eth", state: "already_enough", amount: "0", recipient: ACCOUNT,
        });
        expect(() => parseFaucetClaimView(view, "eth")).toThrow();
        for (const bad of [
            {...view, state: "reserved"},
            {...view, amount: "-1"},
            {...view, amount: "01"},
            {...view, recipient: "0x1234"},
            {...view, transaction: "0x12"},
            {...view, nextAt: 1.5},
            {...view, kind: "btc"},
        ]) {
            expect(() => parseFaucetClaimView(bad)).toThrow();
        }
    });

    test("parseFaucetAccount ties the ETH recipient to the owner", () => {
        const account = {owner: ACCOUNT, recipients: {musdc: PAYER, eth: ACCOUNT}, musdc: null, eth: null};
        expect(parseFaucetAccount(account)).toEqual(account);
        expect(() => parseFaucetAccount({...account, recipients: {musdc: PAYER, eth: OTHER}})).toThrow();
        expect(() => parseFaucetAccount({...account, musdc: {kind: "eth", state: "pending", amount: "0", recipient: ACCOUNT}})).toThrow();
    });

    test("parseFaucetRefusal admits only the closed set", () => {
        for (const reason of FAUCET_REFUSALS) expect(parseFaucetRefusal({reason})).toEqual({reason});
        expect(parseFaucetRefusal({reason: "cooldown", nextAt: T0})).toEqual({reason: "cooldown", nextAt: T0});
        expect(parseFaucetRefusal({reason: "insufficient funds for gas * price + value"})).toBeUndefined();
        expect(parseFaucetRefusal({reason: "cooldown", nextAt: "soon"})).toBeUndefined();
        expect(parseFaucetRefusal("faucet_off")).toBeUndefined();
    });
});
