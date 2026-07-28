import {describe, expect, test} from "bun:test";
import {
    formatCountdown,
    periodPhase,
    short,
    struckPercent,
    struckTicks,
    tickCount,
} from "./dial";

const START = 1_800_000_000n;

describe("periodPhase", () => {
    test("before the start date it reports the wait, never a period", () => {
        // The enforcer answers (0, false, 0) here, and rendering that zero as a
        // balance shows an untouched cap as fully drained. So this branch has to
        // be its own kind rather than an open period at turn 0.
        const phase = periodPhase({
            nowSeconds: START - 45n,
            startDate: START,
            durationSeconds: 60n,
        });
        expect(phase).toEqual({kind: "before", startsInSeconds: 45n});
    });

    test("the first period is index 1, matching the enforcer's own numbering", () => {
        const phase = periodPhase({nowSeconds: START, startDate: START, durationSeconds: 60n});
        expect(phase.kind).toBe("open");
        if (phase.kind !== "open") return;
        expect(phase.index).toBe(1n);
        expect(phase.elapsedSeconds).toBe(0n);
        expect(phase.remainingSeconds).toBe(60n);
        expect(phase.turn).toBe(0);
    });

    test("rolls over to the next index at exactly the duration", () => {
        const last = periodPhase({
            nowSeconds: START + 59n,
            startDate: START,
            durationSeconds: 60n,
        });
        const next = periodPhase({
            nowSeconds: START + 60n,
            startDate: START,
            durationSeconds: 60n,
        });
        expect(last.kind === "open" && last.index).toBe(1n);
        expect(next.kind === "open" && next.index).toBe(2n);
        expect(next.kind === "open" && next.elapsedSeconds).toBe(0n);
    });

    test("turn stays inside [0,1) across a period", () => {
        for (const offset of [0n, 1n, 30n, 59n, 60n, 61n, 119n]) {
            const phase = periodPhase({
                nowSeconds: START + offset,
                startDate: START,
                durationSeconds: 60n,
            });
            expect(phase.kind).toBe("open");
            if (phase.kind !== "open") continue;
            expect(phase.turn).toBeGreaterThanOrEqual(0);
            expect(phase.turn).toBeLessThan(1);
        }
    });

    test("a zero duration is reported, never divided by", () => {
        const phase = periodPhase({nowSeconds: START, startDate: START, durationSeconds: 0n});
        expect(phase.kind).toBe("undefined");
    });

    test("a start date past the Date range is reported rather than rendered", () => {
        // Caveat terms are uint128, so a threshold can exceed what Date accepts.
        // That is a value to report as unrenderable, not a RangeError that
        // unmounts the page.
        const phase = periodPhase({
            nowSeconds: START,
            startDate: 8_640_000_000_001n,
            durationSeconds: 60n,
        });
        expect(phase.kind).toBe("undefined");
    });

    test("a period far past the epoch keeps full precision", () => {
        // The modulo happens in bigint and only the remainder becomes a Number,
        // so a large epoch cannot round the elapsed seconds away.
        const phase = periodPhase({
            nowSeconds: 4_000_000_000n + 37n,
            startDate: 4_000_000_000n,
            durationSeconds: 60n,
        });
        expect(phase.kind === "open" && phase.elapsedSeconds).toBe(37n);
    });
});

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

describe("tickCount", () => {
    test("one tick per whole token", () => {
        expect(tickCount(3_000_000n)).toBe(3);
        expect(tickCount(12_000_000n)).toBe(12);
    });

    test("never zero, so a sub-token cap still draws a boundary", () => {
        expect(tickCount(500_000n)).toBe(1);
    });

    test("caps out, because a count you cannot count is not an engraving", () => {
        expect(tickCount(400_000_000n)).toBe(24);
    });
});

describe("struckTicks", () => {
    test("one of three spent strikes exactly one tick", () => {
        expect(struckTicks(3_000_000n, 2_000_000n)).toBe(1);
    });

    test("never strikes more ticks than exist", () => {
        expect(struckTicks(3_000_000n, 0n)).toBe(3);
    });
});

describe("formatCountdown", () => {
    test("seconds below a minute", () => {
        expect(formatCountdown(47n)).toBe("47초");
    });

    test("pads past a minute so the string keeps its width", () => {
        expect(formatCountdown(123n)).toBe("2분 03초");
    });

    test("never renders a negative clock", () => {
        expect(formatCountdown(-5n)).toBe("0초");
    });

    test("hours", () => {
        expect(formatCountdown(3_900n)).toBe("1시간 05분");
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
