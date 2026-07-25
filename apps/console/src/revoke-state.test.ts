import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import {judgeRevokeGate, revokeButtonLabel} from "./revoke-state";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const STRANGER = getAddress("0x2222222222222222222222222222222222222222");
const SUBMITTER = "http://127.0.0.1:8082";

const base = {
    submitterUrl: SUBMITTER,
    revoked: false,
    connected: OWNER as Address | undefined,
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
