import {describe, expect, test} from "bun:test";
import {short, struckPercent} from "./dial";

describe("struckPercent", () => {
    test("nothing spent is zero, everything spent is a hundred", () => {
        expect(struckPercent(3_000_000n, 3_000_000n)).toBe(0);
        expect(struckPercent(3_000_000n, 0n)).toBe(100);
    });

    test("clamps when remaining exceeds the cap", () => {
        // Terms can change shape; an unclamped value drives the mark past the rim.
        expect(struckPercent(3_000_000n, 9_000_000n)).toBe(0);
    });

    test("a zero cap is zero rather than a division", () => {
        expect(struckPercent(0n, 0n)).toBe(0);
    });
});

describe("short", () => {
    test("leaves values that are already short alone", () => {
        expect(short("0xabc")).toBe("0xabc");
    });

    test("keeps both ends of a hash so it can be matched against an explorer", () => {
        const hash = `0x${"a".repeat(60)}beefcafe`;
        const rendered = short(hash);
        expect(rendered.startsWith("0xaaaaaaaa")).toBe(true);
        expect(rendered.endsWith("beefcafe")).toBe(true);
    });
});
