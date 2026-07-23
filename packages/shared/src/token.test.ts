import {describe, expect, test} from "bun:test";
import {toTokenAmount} from "./token.js";

describe("toTokenAmount", () => {
    test("parses exact mUSDC amounts without floating-point math", () => {
        expect(toTokenAmount("1.5")).toBe(1_500_000n);
        expect(toTokenAmount("0.000001")).toBe(1n);
        expect(toTokenAmount("5.00")).toBe(5_000_000n);
    });

    test("rejects values that would weaken or ambiguously change a payment limit", () => {
        for (const value of ["-1", "1.0000009", "1e3", "1.", ".5", "01", "NaN", ""]) {
            expect(() => toTokenAmount(value)).toThrow();
        }
    });
});
