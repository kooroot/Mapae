import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import {judgeRevokeGate, revokeButtonLabel} from "./revoke-state";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const STRANGER = getAddress("0x2222222222222222222222222222222222222222");
const SUBMITTER = "http://127.0.0.1:8082";

const GIWA = 91_342;

const base = {
    submitterUrl: SUBMITTER,
    revoked: false,
    connected: OWNER as Address | undefined,
    connectedChainId: GIWA as number | undefined,
    expectedChainId: GIWA,
    owner: OWNER as Address | undefined,
    shortfall: 0n as bigint | undefined,
};

describe("revoke gate", () => {
    test("everything in place is ready", () => {
        expect(judgeRevokeGate(base)).toEqual({kind: "ready", owner: OWNER});
    });

    test("no submitter outranks everything — a signature with nowhere to go is worse than none", () => {
        const gate = judgeRevokeGate({...base, submitterUrl: undefined, connected: undefined, revoked: true});
        expect(gate.kind).toBe("no-submitter");
    });

    test("an already-revoked grant is not made actionable by connecting a wallet", () => {
        // Nothing left to fix, so asking someone to connect would be busywork.
        expect(judgeRevokeGate({...base, revoked: true, connected: undefined}).kind).toBe(
            "already-revoked",
        );
    });

    test("a disconnected wallet asks for connection", () => {
        expect(judgeRevokeGate({...base, connected: undefined}).kind).toBe("disconnected");
    });

    /**
     * The wallet leg's quietest failure. MetaMask refuses `eth_signTypedData_v4` outright
     * when `domain.chainId` is not the selected network — it does not even open the
     * prompt. Without this branch the button reads "회수 서명", stays enabled, and the
     * only explanation is the wallet's own message truncated to one line. wagmi cannot
     * catch it either: the console passes no `chainId` to `signTypedDataAsync`, so
     * `ConnectorChainMismatchError` is structurally unreachable.
     */
    test("a wallet on the wrong chain is caught before the wallet has to refuse", () => {
        const gate = judgeRevokeGate({...base, connectedChainId: 11_155_111});
        expect(gate).toEqual({kind: "wrong-chain", connected: 11_155_111, expected: GIWA});
        expect(revokeButtonLabel(gate)).toBe("지갑 네트워크가 다름");
    });

    /**
     * A fork keeps chain id 91342, which is the whole reason the wallet leg can be
     * verified locally: the digest is identical to the one live GIWA would produce. A
     * guard that treated "not live GIWA" as wrong would break exactly the setup it exists
     * to support.
     */
    test("a GIWA fork is not a wrong chain — same id, same digest", () => {
        expect(judgeRevokeGate({...base, connectedChainId: GIWA}).kind).toBe("ready");
    });

    test("an unknown wallet chain does not invent a mismatch", () => {
        // `useAccount().chainId` is undefined while disconnected, and `disconnected`
        // already outranks this. Guessing here would lock the button on a connection
        // state we have no reading for.
        expect(judgeRevokeGate({...base, connectedChainId: undefined}).kind).toBe("ready");
    });

    test("chain outranks wallet — the wrong network can be showing a different account set", () => {
        const gate = judgeRevokeGate({...base, connected: STRANGER, connectedChainId: 1});
        expect(gate.kind).toBe("wrong-chain");
    });

    test("a disconnected wallet outranks a chain mismatch", () => {
        expect(
            judgeRevokeGate({...base, connected: undefined, connectedChainId: 1}).kind,
        ).toBe("disconnected");
    });

    test("a non-owner wallet is refused before anything is signed", () => {
        // The account validates through ERC-1271, so signing anyway returns `AA24
        // signature error` from the EntryPoint — which reads like a nonce or gas problem.
        const gate = judgeRevokeGate({...base, connected: STRANGER});
        expect(gate).toEqual({kind: "wrong-wallet", connected: STRANGER, owner: OWNER});
    });

    test("owner matching is case-insensitive — wallets return unchecksummed addresses", () => {
        const lower = OWNER.toLowerCase() as Address;
        expect(judgeRevokeGate({...base, connected: lower}).kind).toBe("ready");
    });

    test("a short deposit locks the button, because the op would fail AA21", () => {
        const gate = judgeRevokeGate({...base, shortfall: 42n});
        expect(gate).toEqual({kind: "unarmed", shortfall: 42n});
    });

    test("the wrong wallet is reported before the deposit, because it is the fixable one", () => {
        // Both are broken. The deposit is the relayer's job; the wallet belongs to whoever
        // is looking at the screen, so surfacing the deposit first would hide the one thing
        // they can actually correct.
        const gate = judgeRevokeGate({...base, connected: STRANGER, shortfall: 42n});
        expect(gate.kind).toBe("wrong-wallet");
    });

    test("an unread owner does not silently pass as ready", () => {
        // `owner.data` is undefined while the read is in flight. Treating that as a match
        // would let a stranger's wallet reach the signing prompt on a slow RPC.
        expect(judgeRevokeGate({...base, owner: undefined}).kind).toBe("disconnected");
    });

    test("an unread deposit does not block — the submitter re-checks it anyway", () => {
        // Reads as the opposite of the test directly above, and the difference is the
        // point. This looks like the fail-open that `judgePreflight` had — an absent
        // reading treated as a satisfied condition — and it is not the same trade.
        //
        // An unread *owner* risks prompting the wrong person to sign, and failing closed
        // costs them a retry. An unread *deposit* risks nothing but a wasted signature on
        // an operation the submitter re-checks and refuses with the shortfall; failing
        // closed would disarm the kill switch whenever the **console's** RPC is unhealthy,
        // even though the submitter reads through a different process that may be fine.
        // A kill switch that locks itself because the page cannot see is the wrong
        // failure for the one control that has to work when things are bad.
        //
        // The owner is not left uninformed: `RevocationFunding` holds its own query and
        // says "재원을 읽는 중…" or "재원 상태를 읽지 못했습니다 — <reason>" in the panel
        // beside the button, which is why the gate does not need to repeat it.
        expect(judgeRevokeGate({...base, shortfall: undefined}).kind).toBe("ready");
    });

    test("every gate has a distinct label", () => {
        const labels = [
            judgeRevokeGate({...base, submitterUrl: undefined}),
            judgeRevokeGate({...base, revoked: true}),
            judgeRevokeGate({...base, connected: undefined}),
            judgeRevokeGate({...base, connected: STRANGER}),
            judgeRevokeGate({...base, shortfall: 1n}),
            judgeRevokeGate(base),
        ].map(revokeButtonLabel);
        expect(new Set(labels).size).toBe(labels.length);
        expect(labels.every((l) => l.length > 0)).toBe(true);
    });
});
