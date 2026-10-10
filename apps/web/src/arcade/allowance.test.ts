import {describe, expect, test} from "bun:test";
import {arcadePolicy} from "./giwa-client";

describe("individual character allowances", () => {

    test("each grant has its own lifetime cap, not the sum of the crew's budgets", () => {
        const a = arcadePolicy(5), b = arcadePolicy(10);
        expect(a.lifetimeTotalAmount).toBe(5_000_000n);
        expect(b.lifetimeTotalAmount).toBe(10_000_000n);
        expect(a.periodAmount).toBe(a.lifetimeTotalAmount!);
        expect(b.periodAmount).toBe(b.lifetimeTotalAmount!);
        expect(a.recipient).toBe(b.recipient);
        expect(a.expiresAfterSeconds).toBe(7200);
    });
});
