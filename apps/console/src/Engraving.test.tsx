import {describe, expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {DelegationStatus} from "@mapae/delegation/delegation-status";
import {getAddress} from "viem";
import {Engraving, haltReason, periodStarted, stamp, struckPercent, tickCount} from "./Engraving";
import {faultLine} from "./fault";

const MUSDC = 1_000_000n;

/** The exact shape the fork returned after the MCP agent spent 1.0 of a 3.0 cap. */
function status(remaining: bigint, periodAmount = 3n * MUSDC): DelegationStatus {
    return {
        delegationHash: `0x${"ab".repeat(32)}`,
        delegator: getAddress("0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382"),
        delegate: getAddress("0xA350522aE469DFA53a117aFD268a60C0e322a321"),
        limit: {
            token: getAddress("0xcfeb694719A09caeb80798e2011298F29CDa4e92"),
            periodAmount,
            periodDuration: 60n,
            startDate: 1_784_902_334n,
        },
        remaining,
        currentPeriod: 274n,
        revoked: false,
        expired: false,
        notYetActive: false,
    };
}

describe("struck proportion", () => {
    test("one of three spent reads as a third struck", () => {
        expect(struckPercent(3n * MUSDC, 2n * MUSDC)).toBeCloseTo(33.3, 1);
    });

    test("an untouched cap is not struck at all", () => {
        expect(struckPercent(3n * MUSDC, 3n * MUSDC)).toBe(0);
    });

    test("an exhausted cap is fully struck", () => {
        expect(struckPercent(3n * MUSDC, 0n)).toBe(100);
    });

    test("never exceeds the channel even if remaining is inconsistent", () => {
        expect(struckPercent(3n * MUSDC, 9n * MUSDC)).toBe(0);
        expect(struckPercent(0n, 0n)).toBe(0);
    });
});

describe("engraved ticks", () => {
    test("one tick per whole token", () => {
        expect(tickCount(3n * MUSDC)).toBe(3);
        expect(tickCount(1n * MUSDC)).toBe(1);
    });

    test("caps the tick count so a large limit stays legible", () => {
        expect(tickCount(500n * MUSDC)).toBe(24);
    });
});

describe("rendered engraving", () => {
    test("shows remaining, the cap and the period the chain reported", () => {
        const html = renderToStaticMarkup(<Engraving status={status(2n * MUSDC)} />);
        expect(html).toContain("2.0");
        expect(html).toContain("한도 3.0 mUSDC");
        expect(html).toContain("60초");
        expect(html).toContain("이번 주기 사용 1.0");
        expect(html).toContain("주기 #274");
        expect(html).toContain("width:33.3%");
    });

    test("says so plainly when the delegation carries no period cap", () => {
        const bare = {...status(0n), limit: undefined, remaining: undefined};
        const html = renderToStaticMarkup(<Engraving status={bare} />);
        expect(html).toContain("주기 한도 caveat이 없습니다");
    });
});

/**
 * `ERC20PeriodTransferEnforcer._getAvailableAmount` returns `(0, false, 0)`
 * while `block.timestamp < startDate`, and its first real period is index 1.
 * Read as a balance, that zero renders an untouched cap as one that has been
 * completely drained — the single most misleading thing this screen could say.
 */
describe("a period that has not opened yet", () => {
    const notStarted = {...status(0n), currentPeriod: 0n};

    test("currentPeriod 0 is the contract's not-started sentinel, not a period", () => {
        expect(periodStarted(notStarted)).toBe(false);
        expect(periodStarted(status(2n * MUSDC))).toBe(true);
    });

    test("shows the full cap with an empty channel, never a drained one", () => {
        const html = renderToStaticMarkup(<Engraving status={notStarted} />);
        expect(html).toContain("width:0%");
        expect(html).not.toContain("이번 주기 사용 3.0");
        expect(html).toContain("주기 미개시");
        // The one thing a reader actually needs here: when it opens.
        expect(html).toContain("개시 2026-07-24 14:12:14 UTC");
        expect(html).not.toContain("주기 #0");
    });
});

/**
 * The period enforcer never learns about revocation or expiry — it keeps
 * reporting the full cap forever. The console previously rendered that number in
 * 44px bright bronze under "남음", i.e. "3.0 still spendable", for a delegation
 * that could not pay at all. For a demo whose whole claim is that revocation
 * cuts the agent off, that is the claim inverted.
 */
describe("a delegation that can no longer pay", () => {
    test("names the reason instead of captioning a stale balance as 남음", () => {
        for (const [flag, label] of [
            ["revoked", "회수됨"],
            ["expired", "만료됨"],
            ["notYetActive", "미개시"],
        ] as const) {
            const halted = {...status(3n * MUSDC), [flag]: true};
            expect(haltReason(halted)).toBe(label);

            const html = renderToStaticMarkup(<Engraving status={halted} />);
            expect(html).toContain('data-halted="true"');
            expect(html).toContain(`${label} · 이 위임으로는 지불할 수 없습니다`);
            expect(html).not.toContain("남음 · 한도");
        }
    });

    test("still shows the enforcer's own number rather than inventing a zero", () => {
        const html = renderToStaticMarkup(<Engraving status={{...status(3n * MUSDC), revoked: true}} />);
        expect(html).toContain("3.0"); // struck through in CSS, not rewritten here
    });
});

/**
 * `toISOString().replace("T"," ").slice(0,19)` removed both marks that said
 * UTC, leaving a string shaped exactly like a local wall clock — nine hours
 * behind a Korean viewer's, beside a 유효 chip computed from the chain's own
 * block timestamp. The two contradicted each other and the console read stale.
 */
describe("stamp", () => {
    test("says which clock it is on", () => {
        expect(stamp(1_784_902_334n)).toBe("2026-07-24 14:12:14 UTC");
    });

    test("a zero threshold is unbounded, not 1970", () => {
        expect(stamp(0n)).toBe("—");
    });

    test("a uint128 threshold past the Date range is reported, never thrown", () => {
        // 2**128-1 is a legal TimestampEnforcer term; toISOString would RangeError
        // here, and with no error boundary above it that blanks the whole page.
        expect(() => stamp(2n ** 128n - 1n)).not.toThrow();
        expect(stamp(2n ** 128n - 1n)).toBe("—");
    });
});

/**
 * A ~700-character viem error is not a message, it is a terminal dump: request
 * body, raw call arguments, docs URL, library version. In a 390px column with no
 * `white-space` rule it collapses into one run-on red paragraph.
 */
describe("faultLine", () => {
    const viemError = new Error(
        [
            "HTTP request failed.",
            "",
            "URL: http://127.0.0.1:9944/",
            'Request body: {"method":"eth_call","params":[{"data":"0x2d40d052"}]}',
            "Docs: https://viem.sh/docs/contract/readContract",
            "Version: viem@2.55.8",
        ].join("\n"),
    );

    test("keeps the actionable line and drops the terminal dump", () => {
        expect(faultLine(viemError)).toBe("HTTP request failed.");
        expect(faultLine(viemError)).not.toContain("Request body");
        expect(faultLine(viemError)).not.toContain("viem@");
    });

    test("bounds a single long line so it cannot fill the column either", () => {
        expect(faultLine(new Error("x".repeat(400)))).toHaveLength(120);
    });

    test("survives a thrown non-Error and an empty message", () => {
        expect(faultLine("plain string")).toBe("plain string");
        expect(faultLine(new Error(""))).toBe("알 수 없는 오류");
        expect(faultLine(undefined)).toBe("undefined");
    });
});
