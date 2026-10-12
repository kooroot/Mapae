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
    FaucetGate,
    InMemoryFaucetWindows,
    isFaucetMissionId,
    parseFaucetAccount,
    parseFaucetClaimView,
    parseFaucetMissionList,
    parseFaucetRefusal,
    parseFaucetStatus,
    planTopUp,
    readFaucetConfig,
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

describe("FaucetGate", () => {
    test("allows a fresh account, refuses it for a day after a recorded mint, then allows again", () => {
        const gate = new FaucetGate();
        expect(gate.allows(ACCOUNT, T0)).toBe(true);
        gate.record(ACCOUNT, T0);
        expect(gate.allows(ACCOUNT, T0 + 1)).toBe(false);
        expect(gate.allows(ACCOUNT, T0 + FAUCET_WINDOW_MS - 1)).toBe(false);
        expect(gate.allows(ACCOUNT, T0 + FAUCET_WINDOW_MS)).toBe(true);
    });

    test("refusing does not consume: repeated refusals neither extend the window nor add keys", () => {
        const gate = new FaucetGate();
        gate.record(ACCOUNT, T0);
        for (let i = 1; i <= 50; i += 1) expect(gate.allows(ACCOUNT, T0 + i * 3_600_000)).toBe(i >= 24);
        expect(gate.size).toBe(1);
        // The window is dated from the mint, not from the last refusal.
        expect(gate.allows(ACCOUNT, T0 + FAUCET_WINDOW_MS)).toBe(true);
    });

    test("is per account, keyed by the lowercase address", () => {
        const gate = new FaucetGate();
        gate.record(ACCOUNT, T0);
        expect(gate.allows(OTHER, T0 + 1)).toBe(true);
        expect(gate.allows(ACCOUNT.toLowerCase() as typeof ACCOUNT, T0 + 1)).toBe(false);
        expect(gate.allows(ACCOUNT.toUpperCase().replace("0X", "0x") as typeof ACCOUNT, T0 + 1)).toBe(false);
        gate.record(ACCOUNT.toLowerCase() as typeof ACCOUNT, T0 + 2);
        expect(gate.size).toBe(1);
    });

    test("sweep drops elapsed windows and keeps live ones", () => {
        const gate = new FaucetGate();
        gate.record(ACCOUNT, T0);
        gate.record(OTHER, T0 + 3_600_000);
        expect(gate.size).toBe(2);
        gate.sweep(T0 + FAUCET_WINDOW_MS);
        expect(gate.size).toBe(1);
        expect(gate.allows(ACCOUNT, T0 + FAUCET_WINDOW_MS)).toBe(true);
        expect(gate.allows(OTHER, T0 + FAUCET_WINDOW_MS)).toBe(false);
        gate.sweep(T0 + FAUCET_WINDOW_MS + 3_600_000);
        expect(gate.size).toBe(0);
    });

    /**
     * The bound has to outlive the process. While the windows were a field on the gate, a
     * redeploy handed every account a fresh day, and the operator's own restart was the
     * cheapest way to drain the faucet.
     */
    test("a gate rebuilt on the same store keeps every open window", () => {
        const windows = new InMemoryFaucetWindows();
        new FaucetGate(FAUCET_WINDOW_MS, windows).record(ACCOUNT, T0);

        const restarted = new FaucetGate(FAUCET_WINDOW_MS, windows);
        expect(restarted.allows(ACCOUNT, T0 + 1)).toBe(false);
        expect(restarted.allows(ACCOUNT, T0 + FAUCET_WINDOW_MS)).toBe(true);
        expect(restarted.allows(OTHER, T0 + 1)).toBe(true);
        expect(restarted.size).toBe(1);
    });

    test("the store never sees a checksummed key, so re-casing cannot buy a second draw", () => {
        const windows = new InMemoryFaucetWindows();
        const gate = new FaucetGate(FAUCET_WINDOW_MS, windows);
        gate.record(ACCOUNT, T0);
        expect(windows.lastMintedAt(ACCOUNT.toLowerCase())).toBe(T0);
        expect(windows.lastMintedAt(ACCOUNT)).toBeUndefined();
    });

    test("sweep hands the store a cutoff, not the clock", () => {
        const windows = new InMemoryFaucetWindows();
        const gate = new FaucetGate(FAUCET_WINDOW_MS, windows);
        gate.record(ACCOUNT, T0);
        gate.sweep(T0 + FAUCET_WINDOW_MS - 1);
        expect(gate.size).toBe(1);
        gate.sweep(T0 + FAUCET_WINDOW_MS);
        expect(gate.size).toBe(0);
    });

    test("accepts only a positive integer window", () => {
        expect(() => new FaucetGate(0)).toThrow(/positive integer/);
        expect(() => new FaucetGate(1.5)).toThrow(/positive integer/);
        expect(new FaucetGate(1).allows(ACCOUNT, T0)).toBe(true);
    });
});

describe("readFaucetConfig", () => {
    test("is on by default and targets 1000 tUSDC", () => {
        expect(readFaucetConfig({})).toEqual({enabled: true, target: FAUCET_TARGET_BASE});
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: "", BOOTSTRAP_FAUCET_TARGET_BASE: " "})).toEqual({
            enabled: true,
            target: FAUCET_TARGET_BASE,
        });
    });

    test('only the string "false" turns it off, in any casing or padding', () => {
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: "false"}).enabled).toBe(false);
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: " FALSE "}).enabled).toBe(false);
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: "true"}).enabled).toBe(true);
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: "True"}).enabled).toBe(true);
    });

    test("refuses a switch value it cannot read rather than guessing", () => {
        for (const value of ["0", "no", "off", "flase", "yes"]) {
            expect(() => readFaucetConfig({BOOTSTRAP_FAUCET_ENABLED: value})).toThrow(
                /BOOTSTRAP_FAUCET_ENABLED/,
            );
        }
    });

    test("takes an explicit target in base units and refuses anything that is not a positive integer", () => {
        expect(readFaucetConfig({BOOTSTRAP_FAUCET_TARGET_BASE: "2500000000"}).target).toBe(2_500_000_000n);
        for (const value of ["0", "-1", "1.5", "1e9", "abc", "1000 tUSDC"]) {
            expect(() => readFaucetConfig({BOOTSTRAP_FAUCET_TARGET_BASE: value})).toThrow(
                /BOOTSTRAP_FAUCET_TARGET_BASE/,
            );
        }
    });

    test("ignores unrelated variables, including the names the old flag-based faucet used", () => {
        expect(
            readFaucetConfig({
                BOOTSTRAP_FAUCET_AMOUNT_BASE: "3000000",
                BOOTSTRAP_RATE_PER_HOUR: "1",
                BOOTSTRAP_ENABLED: "false",
            }),
        ).toEqual({enabled: true, target: FAUCET_TARGET_BASE});
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
