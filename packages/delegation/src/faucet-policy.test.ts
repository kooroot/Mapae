import {describe, expect, test} from "bun:test";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {
    FAUCET_TARGET_BASE,
    FAUCET_WINDOW_MS,
    FaucetGate,
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
