import type {Address} from "viem";

/**
 * Why the revoke button is or is not actionable.
 *
 * Pure and separate from the component because this is the part with real branches, and
 * every one of them is a different sentence the owner needs to read. A button that is
 * merely `disabled` when the kill switch cannot fire tells them nothing about which of
 * five reasons applies.
 */
export type RevokeGate =
    | {kind: "no-submitter"}
    | {kind: "already-revoked"}
    | {kind: "disconnected"}
    | {kind: "wrong-chain"; connected: number; expected: number}
    | {kind: "wrong-wallet"; connected: Address; owner: Address}
    | {kind: "unarmed"; shortfall: bigint}
    | {kind: "ready"; owner: Address};

export function judgeRevokeGate(input: {
    submitterUrl: string | undefined;
    revoked: boolean;
    connected: Address | undefined;
    /** The chain the wallet is on. `undefined` while disconnected, which outranks this. */
    connectedChainId: number | undefined;
    expectedChainId: number;
    owner: Address | undefined;
    shortfall: bigint | undefined;
}): RevokeGate {
    // Ordered by what the owner can act on, cheapest first. `already-revoked` outranks
    // everything except a missing submitter because once the grant is disabled there is
    // nothing left to fix — telling someone to connect a wallet would be busywork.
    if (!input.submitterUrl) return {kind: "no-submitter"};
    if (input.revoked) return {kind: "already-revoked"};
    if (!input.connected) return {kind: "disconnected"};
    // Before the owner check, because the wallet on the wrong network may not even be
    // showing the same account list — and because nothing else here can be trusted to
    // mean what it says until the chain matches.
    //
    // Without this the button reads "회수 서명" and is enabled, and the only thing that
    // refuses is the wallet, whose message arrives as a truncated one-liner in the
    // progress note. The sibling signing page in this repo already guards this
    // (`open-agent.sign.html`); wagmi does not, because the console never passes a
    // `chainId` to `signTypedDataAsync`, so `ConnectorChainMismatchError` is structurally
    // unreachable here.
    if (
        input.connectedChainId !== undefined &&
        input.connectedChainId !== input.expectedChainId
    ) {
        return {
            kind: "wrong-chain",
            connected: input.connectedChainId,
            expected: input.expectedChainId,
        };
    }
    if (input.owner && input.connected.toLowerCase() !== input.owner.toLowerCase()) {
        return {kind: "wrong-wallet", connected: input.connected, owner: input.owner};
    }
    // The deposit is checked *after* the wallet, deliberately. It is fixable by the
    // relayer rather than by whoever is looking at the screen, so surfacing it before the
    // wallet mismatch would hide the one thing this person can actually correct.
    if (input.shortfall !== undefined && input.shortfall > 0n) {
        return {kind: "unarmed", shortfall: input.shortfall};
    }
    if (!input.owner) return {kind: "disconnected"};
    return {kind: "ready", owner: input.owner};
}

/** What the button says in each gate. Separated so the copy is assertable. */
export function revokeButtonLabel(gate: RevokeGate): string {
    switch (gate.kind) {
        case "no-submitter":
            return "제출 엔드포인트 미설정";
        case "already-revoked":
            return "이미 회수됨";
        case "disconnected":
            return "소유자 지갑 연결";
        case "wrong-chain":
            return "지갑 네트워크가 다름";
        case "wrong-wallet":
            return "다른 지갑이 연결됨";
        case "unarmed":
            return "예치금 부족 — 회수 불가";
        case "ready":
            return "회수 서명";
    }
}

export type RevokeProgress =
    | {phase: "idle"}
    | {phase: "signing"}
    | {phase: "submitting"}
    | {phase: "done"; transaction: string}
    | {phase: "failed"; reason: string};
