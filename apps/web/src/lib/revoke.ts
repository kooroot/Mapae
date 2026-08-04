import type {Delegation} from "@metamask/smart-accounts-kit";
import {isDelegationRevoked} from "@mapae/delegation/revocation";
import {buildRevocationSubmissionBody} from "@mapae/delegation/revocation-submission";
import type {Address, Hex} from "viem";
import type {PackedUserOperation} from "viem/account-abstraction";
import {deployment, publicClient} from "./config";
import type {Locale} from "./i18n";

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
const BUTTON_COPY: Record<Locale, Record<StudioRevokeGate["kind"], string>> = {
    en: {
        "no-endpoint": "Revocation endpoint not configured",
        "already-revoked": "Already revoked",
        disconnected: "Connect the owner wallet",
        "wrong-chain": "Wallet on a different network",
        "wrong-wallet": "A different wallet is connected",
        "owner-unknown": "Confirming owner…",
        ready: "Sign to revoke this permission",
    },
    ko: {
        "no-endpoint": "회수 엔드포인트 미설정",
        "already-revoked": "이미 회수됨",
        disconnected: "소유자 지갑 연결",
        "wrong-chain": "지갑 네트워크가 다름",
        "wrong-wallet": "다른 지갑이 연결됨",
        "owner-unknown": "소유자 확인 중…",
        ready: "권한 회수 서명",
    },
};

export function studioRevokeButtonLabel(
    gate: StudioRevokeGate,
    locale: Locale = "en",
): string {
    return BUTTON_COPY[locale][gate.kind];
}

/**
 * Turn the submitter's closed refusal enum into the sentence it stands for.
 *
 * Map, never render: the server's body is a closed set by design, so a new server-side
 * reason becomes the generic sentence here — not UI text nobody wrote. Same rule as
 * `bootstrapRefusalMessage` in `grant.ts`.
 */
const REFUSAL_COPY: Record<
    Locale,
    {
        alreadyRevoked: string;
        rateLimited: string;
        invalidSignature: string;
        senderBusy: string;
        budgetExhausted: string;
        feeBelowBaseFee: string;
        pathNotReady: string;
        invalidSubmission: string;
        generic: string;
    }
> = {
    en: {
        alreadyRevoked: "This permission is already revoked.",
        rateLimited: "Too many requests. Try again shortly.",
        invalidSignature:
            "The signature does not match this account's owner. Sign again with the owner wallet.",
        senderBusy: "Another revocation for this account is in progress. Try again shortly.",
        budgetExhausted:
            "Today's sponsored revocation allowance is used up. Try again later.",
        feeBelowBaseFee: "Network fees are temporarily high. Try again shortly.",
        pathNotReady: "The revocation path is temporarily unavailable. Try again shortly.",
        invalidSubmission: "The submission was refused. Check the permission code and try again.",
        generic: "The revocation could not be completed.",
    },
    ko: {
        alreadyRevoked: "이미 회수된 권한입니다.",
        rateLimited: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
        invalidSignature:
            "서명이 이 계정의 소유자와 일치하지 않습니다. 소유자 지갑으로 다시 서명해 주세요.",
        senderBusy: "이 계정의 다른 회수가 처리 중입니다. 잠시 후 다시 시도해 주세요.",
        budgetExhausted:
            "오늘 대납 가능한 회수 한도를 모두 사용했습니다. 잠시 후 다시 시도해 주세요.",
        feeBelowBaseFee: "네트워크 수수료가 일시적으로 높습니다. 잠시 후 다시 시도해 주세요.",
        pathNotReady: "회수 경로가 일시적으로 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.",
        invalidSubmission: "제출이 거절되었습니다. 권한 코드를 다시 확인해 주세요.",
        generic: "회수를 완료하지 못했습니다.",
    },
};

export function revokeRefusalMessage(
    reason: string | undefined,
    locale: Locale = "en",
): string {
    const t = REFUSAL_COPY[locale];
    switch (reason) {
        case "already_revoked":
            return t.alreadyRevoked;
        case "rate_limited":
            return t.rateLimited;
        case "invalid_account_signature":
            return t.invalidSignature;
        case "sender_busy":
            return t.senderBusy;
        case "budget_exhausted":
        case "sponsor_unfunded":
            return t.budgetExhausted;
        case "fee_below_basefee":
            return t.feeBelowBaseFee;
        case "base_fee_unreadable":
        case "relayer_unfunded":
        case "prefund_short":
            return t.pathNotReady;
        case "invalid_submission":
            return t.invalidSubmission;
        default:
            return t.generic;
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
const REQUEST_COPY: Record<Locale, {unreachable: string; unconfirmed: string}> = {
    en: {
        unreachable: "Could not reach the revocation server.",
        unconfirmed:
            "The revocation is not yet confirmed on chain. Refresh the status in a moment.",
    },
    ko: {
        unreachable: "회수 서버에 연결하지 못했습니다.",
        unconfirmed: "회수가 아직 온체인에서 확인되지 않았습니다. 잠시 후 상태를 새로고침해 주세요.",
    },
};

export async function requestSponsoredRevocation(
    params: {
        endpoint: string;
        permissionContext: Hex;
        packed: PackedUserOperation;
        delegation: Delegation;
    },
    locale: Locale = "en",
): Promise<{transaction?: string}> {
    const t = REQUEST_COPY[locale];
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
        throw new Error(t.unreachable);
    }
    const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        transaction?: string;
        reason?: string;
    };
    if (!response.ok || !body.success) {
        throw new Error(revokeRefusalMessage(body.reason, locale));
    }
    const revoked = await isDelegationRevoked({
        publicClient,
        delegationManager: deployment.environment.DelegationManager,
        delegation: params.delegation,
    });
    if (!revoked) {
        throw new Error(t.unconfirmed);
    }
    return {transaction: body.transaction};
}

/**
 * Wait until a revocation the submitter already confirmed becomes visible to *this*
 * client's RPC.
 *
 * The submitter answers only after the receipt lands on its own node, but the Studio
 * re-reads through the public endpoint's load balancer — on the first live revocation
 * (2026-08-04) a single immediate re-read hit a replica still one or two seconds behind
 * and rendered the grant as active until the user reloaded by hand. GIWA produces a
 * block per second, so the lag is short but real; a bounded poll outlasts it. A read
 * that throws counts as not-yet-visible for the same reason it exists at all — the
 * flaky replica IS the scenario. Returns false when the budget runs out; the caller
 * falls back to its ordinary single refresh, which is exactly the pre-poll behavior.
 */
export async function awaitRevocationVisible(params: {
    read: () => Promise<boolean>;
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
    const attempts = params.attempts ?? 8;
    const intervalMs = params.intervalMs ?? 1_500;
    const sleep =
        params.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(intervalMs);
        try {
            if (await params.read()) return true;
        } catch {
            // not yet visible on this replica — keep waiting
        }
    }
    return false;
}
