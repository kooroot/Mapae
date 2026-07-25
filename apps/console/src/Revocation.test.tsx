import {describe, expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {DEFAULT_REVOCATION_GAS, revocationPrefund} from "@mapae/delegation/revocation";
import type {RevocationPrefundState} from "@mapae/delegation/revocation";
import {REQUIRED_PREFUND, RevocationFundingView} from "./Revocation";

const required = revocationPrefund(DEFAULT_REVOCATION_GAS);

function state(deposit: bigint, nativeBalance = 0n): RevocationPrefundState {
    const shortfall = deposit >= required ? 0n : required - deposit;
    return {deposit, nativeBalance, shortfall, ready: shortfall === 0n};
}

const view = (s: RevocationPrefundState) =>
    renderToStaticMarkup(<RevocationFundingView state={s} required={required} />);

describe("revocation funding", () => {
    test("the panel sizes the prefund from the shared helper, not its own copy", () => {
        expect(REQUIRED_PREFUND).toBe(required);
        expect(REQUIRED_PREFUND).toBeGreaterThan(0n);
    });

    test("a funded deposit reads as armed and names the deposit as the gas source", () => {
        const html = view(state(required));
        expect(html).toContain("장전됨");
        expect(html).not.toContain("미장전");
        expect(html).toContain("EntryPoint 예치금");
        // No shortfall row when there is no shortfall.
        expect(html).not.toContain("부족분");
    });

    /**
     * The state the live payer account is actually in: zero deposit, zero ETH. A panel
     * that rendered a revoke button here without saying so would claim a capability the
     * chain does not have — the operation fails AA21 before it reaches the account.
     */
    test("an empty deposit reads as not armed, names AA21, and shows the shortfall", () => {
        const html = view(state(0n));
        expect(html).toContain("미장전");
        expect(html).toContain("AA21");
        expect(html).toContain("부족분");
        expect(html).toContain("depositTo");
    });

    test("a partial deposit is still not armed", () => {
        const partial = state(required - 1n);
        expect(partial.ready).toBe(false);
        expect(view(partial)).toContain("미장전");
    });

    /**
     * Gaslessness is the demo's central claim, so the payer's ETH balance has to be
     * legible precisely when it is zero. A row that only appears when the number is
     * non-zero is a row that can never confirm the invariant held.
     */
    test("the payer's zero ETH balance stays visible", () => {
        expect(view(state(required, 0n))).toContain("지불 계정 ETH");
        expect(view(state(0n, 0n))).toContain("지불 계정 ETH");
    });

    test("ETH amounts render as ETH, never as raw wei", () => {
        const html = view(state(required));
        expect(html).toContain("0.0007 ETH");
        expect(html).not.toContain(String(required));
    });
});
