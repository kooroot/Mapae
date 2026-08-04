import type {Delegation} from "@metamask/smart-accounts-kit";
import {isDelegationRevoked} from "@mapae/delegation/revocation";
import {buildRevocationSubmissionBody} from "@mapae/delegation/revocation-submission";
import type {Address, Hex} from "viem";
import type {PackedUserOperation} from "viem/account-abstraction";
import {deployment, publicClient} from "./config";

/**
 * Why the Studio revoke button is or is not actionable.
 *
 * The console's local gate has a sibling shape with one deliberate difference: there is
 * no deposit ("unarmed") gate here. The payer holds no ETH by design and the sponsored
 * endpoint arms the EntryPoint deposit at revoke time, so a shortfall is the *normal*
 * pre-revoke state rather than a blocker — a gate keyed on it would refuse the exact
 * flow this feature exists to provide.
 */
export type StudioRevokeGate =
    | {kind: "no-endpoint"}
    | {kind: "already-revoked"}
    | {kind: "disconnected"}
    | {kind: "wrong-chain"; connected: number; expected: number}
    | {kind: "wrong-wallet"; connected: Address; owner: Address}
    | {kind: "owner-unknown"}
    | {kind: "ready"; owner: Address};

export function judgeStudioRevokeGate(input: {
    endpoint: string | undefined;
    revoked: boolean;
    connected: Address | undefined;
    /** The chain the wallet is on. `undefined` while disconnected, which outranks this. */
    connectedChainId: number | undefined;
    expectedChainId: number;
    owner: Address | undefined;
}): StudioRevokeGate {
    // Ordered by what the owner can act on, cheapest first. `already-revoked` outranks
    // everything except a missing endpoint because once the grant is disabled there is
    // nothing left to fix — telling someone to connect a wallet would be busywork.
    if (!input.endpoint) return {kind: "no-endpoint"};
    if (input.revoked) return {kind: "already-revoked"};
    if (!input.connected) return {kind: "disconnected"};
    // Before the owner check: a wallet on the wrong network may not even be showing the
    // same account list, and nothing else here means what it says until the chain matches.
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
    if (!input.owner) return {kind: "owner-unknown"};
    if (input.connected.toLowerCase() !== input.owner.toLowerCase()) {
        return {kind: "wrong-wallet", connected: input.connected, owner: input.owner};
    }
    return {kind: "ready", owner: input.owner};
}

/** What the button says in each gate. Separated so the copy is assertable. */
export function studioRevokeButtonLabel(gate: StudioRevokeGate): string {
    switch (gate.kind) {
        case "no-endpoint":
            return "회수 엔드포인트 미설정";
        case "already-revoked":
            return "이미 회수됨";
        case "disconnected":
            return "소유자 지갑 연결";
        case "wrong-chain":
            return "지갑 네트워크가 다름";
        case "wrong-wallet":
            return "다른 지갑이 연결됨";
        case "owner-unknown":
            return "소유자 확인 중…";
        case "ready":
            return "권한 회수 서명";
    }
}

/**
 * Turn the submitter's closed refusal enum into the sentence it stands for.
 *
 * Map, never render: the server's body is a closed set by design, so a new server-side
 * reason becomes the generic sentence here — not UI text nobody wrote. Same rule as
 * `bootstrapRefusalMessage` in `grant.ts`.
 */
export function revokeRefusalMessage(reason: string | undefined): string {
    switch (reason) {
        case "already_revoked":
            return "이미 회수된 권한입니다.";
        case "rate_limited":
            return "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.";
        case "invalid_account_signature":
            return "서명이 이 계정의 소유자와 일치하지 않습니다. 소유자 지갑으로 다시 서명해 주세요.";
        case "sender_busy":
            return "이 계정의 다른 회수가 처리 중입니다. 잠시 후 다시 시도해 주세요.";
        case "budget_exhausted":
        case "sponsor_unfunded":
            return "오늘 대납 가능한 회수 한도를 모두 사용했습니다. 잠시 후 다시 시도해 주세요.";
        case "fee_below_basefee":
            return "네트워크 수수료가 일시적으로 높습니다. 잠시 후 다시 시도해 주세요.";
        case "base_fee_unreadable":
        case "relayer_unfunded":
        case "prefund_short":
            return "회수 경로가 일시적으로 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.";
        case "invalid_submission":
            return "제출이 거절되었습니다. 권한 코드를 다시 확인해 주세요.";
        default:
            return "회수를 완료하지 못했습니다.";
    }
}

/**
 * Ask the sponsored submitter to carry a signed revocation, then confirm on chain.
 *
 * Mirrors `requestSponsoredBootstrap`: `redirect: "error"` because a redirect would carry
 * an owner signature — a bearer authorization to disable this permission — to an origin
 * nobody chose; the refusal body is mapped, never rendered; and the success response is
 * the sponsor's claim, so the delegation's on-chain disabled flag is what this function
 * actually returns on.
 */
export async function requestSponsoredRevocation(params: {
    endpoint: string;
    permissionContext: Hex;
    packed: PackedUserOperation;
    delegation: Delegation;
}): Promise<{transaction?: string}> {
    let response: Response;
    try {
        response = await fetch(`${params.endpoint}/revoke`, {
            method: "POST",
            redirect: "error",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(
                buildRevocationSubmissionBody({
                    permissionContext: params.permissionContext,
                    packed: params.packed,
                }),
            ),
            signal: AbortSignal.timeout(90_000),
        });
    } catch {
        throw new Error("회수 서버에 연결하지 못했습니다.");
    }
    const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        transaction?: string;
        reason?: string;
    };
    if (!response.ok || !body.success) {
        throw new Error(revokeRefusalMessage(body.reason));
    }
    const revoked = await isDelegationRevoked({
        publicClient,
        delegationManager: deployment.environment.DelegationManager,
        delegation: params.delegation,
    });
    if (!revoked) {
        throw new Error("회수가 아직 온체인에서 확인되지 않았습니다. 잠시 후 상태를 새로고침해 주세요.");
    }
    return {transaction: body.transaction};
}
