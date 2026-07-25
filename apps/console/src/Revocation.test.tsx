import {describe, expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {DEFAULT_REVOCATION_GAS, revocationPrefund} from "@mapae/delegation/revocation";
import type {RevocationPrefundState} from "@mapae/delegation/revocation";
import {getAddress} from "viem";
import {
    REQUIRED_PREFUND,
    RevocationFundingView,
    RevokeGateNote,
    RevokeProgressNote,
    describeRefusal,
} from "./Revocation";
import {judgeRevokeGate} from "./revoke-state";

const required = revocationPrefund(DEFAULT_REVOCATION_GAS);
const OWNER = getAddress("0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382");
const STRANGER = getAddress("0x0229346e91a07EA24A54704F094D293E43E9d302");
const TX = "0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c";

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

const gateNote = (gate: Parameters<typeof RevokeGateNote>[0]["gate"]) =>
    renderToStaticMarkup(<RevokeGateNote gate={gate} />);

/**
 * Why the kill switch will not fire, in the owner's words.
 *
 * `judgeRevokeGate` is already pinned by `revoke-state.test.ts`, but that proves only
 * which branch is chosen. These render the branch — and the whole reason the gate is a
 * discriminated union rather than a boolean is that a merely-disabled button leaves the
 * one person who can revoke with no idea which of five things to fix.
 */
describe("revoke gate copy", () => {
    test("a missing submitter says the signature would have nowhere to go", () => {
        const html = gateNote(
            judgeRevokeGate({
                submitterUrl: undefined,
                revoked: false,
                connected: undefined,
                owner: undefined,
                shortfall: undefined,
            }),
        );
        expect(html).toContain("VITE_REVOCATION_SUBMITTER_URL");
    });

    /**
     * Both addresses, not just the connected one. The account validates through ERC-1271,
     * so signing with the wrong wallet returns `AA24 signature error` from the EntryPoint
     * — which reads exactly like a nonce or gas fault. Naming the owner is what turns a
     * dead end into a one-click fix.
     */
    test("a wrong wallet names both addresses and the error it would cause", () => {
        const html = gateNote(
            judgeRevokeGate({
                submitterUrl: "http://127.0.0.1:8082",
                revoked: false,
                connected: STRANGER,
                owner: OWNER,
                shortfall: 0n,
            }),
        );
        expect(html).toContain("AA24");
        expect(html).toContain(STRANGER.slice(0, 10));
        expect(html).toContain(OWNER.slice(0, 10));
    });

    test("an unarmed deposit names AA21 and the shortfall in ETH", () => {
        const html = gateNote(
            judgeRevokeGate({
                submitterUrl: "http://127.0.0.1:8082",
                revoked: false,
                connected: OWNER,
                owner: OWNER,
                shortfall: 700_000_000_000_000n,
            }),
        );
        expect(html).toContain("AA21");
        expect(html).toContain("0.0007 ETH");
        expect(html).not.toContain("700000000000000");
    });

    test("a ready gate and an already-revoked one say nothing at all", () => {
        const ready = judgeRevokeGate({
            submitterUrl: "http://127.0.0.1:8082",
            revoked: false,
            connected: OWNER,
            owner: OWNER,
            shortfall: 0n,
        });
        const revoked = judgeRevokeGate({
            submitterUrl: "http://127.0.0.1:8082",
            revoked: true,
            connected: OWNER,
            owner: OWNER,
            shortfall: 0n,
        });
        expect(ready.kind).toBe("ready");
        expect(revoked.kind).toBe("already-revoked");
        // The button label already carries these two; a note repeating it would push the
        // three that actually need explaining further down the panel.
        expect(gateNote(ready)).toBe("");
        expect(gateNote(revoked)).toBe("");
    });
});

/**
 * What the owner sees after they sign.
 *
 * The success path is the only place this console ever reports a state change, so it has
 * to be unambiguous about whether the grant is gone.
 */
describe("revoke progress", () => {
    test("idle, signing and submitting render nothing above the button", () => {
        expect(renderToStaticMarkup(<RevokeProgressNote progress={{phase: "idle"}} />)).toBe("");
        expect(renderToStaticMarkup(<RevokeProgressNote progress={{phase: "signing"}} />)).toBe("");
        expect(renderToStaticMarkup(<RevokeProgressNote progress={{phase: "submitting"}} />)).toBe(
            "",
        );
    });

    test("a completed revocation links the transaction and states the consequence", () => {
        const html = renderToStaticMarkup(
            <RevokeProgressNote progress={{phase: "done", transaction: TX}} />,
        );
        expect(html).toContain(`https://sepolia-explorer.giwa.io/tx/${TX}`);
        expect(html).toContain('rel="noreferrer noopener"');
        expect(html).toContain("더 이상 지불할 수 없습니다");
    });

    /**
     * `success: true` with no hash is a shape the submitter's own response type allows.
     * A link built from an empty string points at the explorer's tx index, which renders
     * a plausible page and would let someone conclude they had seen their revocation.
     */
    test("a success with no hash says so instead of linking to nothing", () => {
        const html = renderToStaticMarkup(
            <RevokeProgressNote progress={{phase: "done", transaction: ""}} />,
        );
        expect(html).toContain("트랜잭션 해시가 반환되지 않았습니다");
        expect(html).not.toContain("<a");
    });

    test("a failure keeps the reason and marks itself as a fault", () => {
        const html = renderToStaticMarkup(
            <RevokeProgressNote progress={{phase: "failed", reason: "AA21 didn't pay prefund"}} />,
        );
        expect(html).toContain("회수하지 못했습니다");
        expect(html).toContain("AA21");
        expect(html).toContain("fault");
    });
});

/**
 * The submitter answers with a machine-readable reason; this is the translation.
 *
 * Each branch names a *different* party who has to act — the relayer tops up the account's
 * EntryPoint deposit for `prefund_short`, but its own EOA for `relayer_unfunded`. Swapping
 * the two sends someone to fund the wrong address.
 */
describe("submitter refusals", () => {
    test("prefund_short points at the account's EntryPoint deposit", () => {
        const said = describeRefusal({reason: "prefund_short", detail: {shortfall: "12345"}});
        expect(said).toContain("EntryPoint");
        expect(said).toContain("12345");
        expect(said).toContain("depositTo");
    });

    test("relayer_unfunded points at the relayer's own balance instead", () => {
        const said = describeRefusal({reason: "relayer_unfunded"});
        expect(said).toContain("relayer");
        expect(said).not.toContain("EntryPoint");
    });

    test("fee_below_basefee quotes both numbers being compared", () => {
        const said = describeRefusal({
            reason: "fee_below_basefee",
            detail: {maxFeePerGas: "1000", baseFeePerGas: "2000"},
        });
        expect(said).toContain("1000");
        expect(said).toContain("2000");
    });

    test("invalid_submission carries the validator's own message through", () => {
        expect(
            describeRefusal({reason: "invalid_submission", detail: {message: "callData mismatch"}}),
        ).toContain("callData mismatch");
    });

    /**
     * An unrecognised reason must still say something. A submitter that grows a new
     * refusal code before this switch does would otherwise report the revocation as
     * having failed for no stated reason at all.
     */
    test("an unknown reason falls through to something rather than to nothing", () => {
        expect(describeRefusal({reason: "some_new_code"})).toBe("some_new_code");
        expect(describeRefusal({}).length).toBeGreaterThan(0);
    });
});
