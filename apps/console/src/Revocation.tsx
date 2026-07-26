import {
    DEFAULT_REVOCATION_GAS,
    buildRevocationUserOperation,
    finalizeRevocationUserOperation,
    readAccountOwner,
    readRevocationNonce,
    readRevocationPrefundState,
    revocationPrefund,
    type RevocationPrefundState,
} from "@mapae/delegation/revocation";
import {buildRevocationSubmissionBody} from "@mapae/delegation/revocation-submission";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {useQuery} from "@tanstack/react-query";
import {useState} from "react";
import {formatEther, type Address, type Hex} from "viem";
import {explorerTxUrl} from "@mapae/shared";
import {short} from "./Engraving";
import {useAccount, useConnect, useSignTypedData} from "wagmi";
import {chain, configuredSubmitterUrl, deployment, publicClient, rpcUrl} from "./config";
import {faultLine} from "./fault";
import {judgeRevokeGate, revokeButtonLabel, type RevokeProgress} from "./revoke-state";

/**
 * The prefund a single revocation needs. A pure function of the gas parameters, so the
 * readiness display never fetches a nonce to build an operation nobody will sign.
 */
export const REQUIRED_PREFUND = revocationPrefund(DEFAULT_REVOCATION_GAS);

/**
 * Presentation only, so the branches that matter are testable without a query client.
 */
export function RevocationFundingView({
    state,
    required,
}: {
    state: RevocationPrefundState;
    required: bigint;
}) {
    const {deposit, nativeBalance, shortfall, ready} = state;

    return (
        <>
            <dl>
                <div className="row">
                    <dt>킬 스위치</dt>
                    <dd>
                        <span className="state" data-tone={ready ? "ok" : "bad"}>
                            {ready ? "장전됨" : "미장전 — 예치금 부족"}
                        </span>
                    </dd>
                </div>
                <div className="row">
                    <dt>EntryPoint 예치금</dt>
                    <dd>{formatEther(deposit)} ETH</dd>
                </div>
                <div className="row">
                    <dt>1회 필요액</dt>
                    <dd>{formatEther(required)} ETH</dd>
                </div>
                {shortfall > 0n ? (
                    <div className="row">
                        <dt>부족분</dt>
                        <dd>{formatEther(shortfall)} ETH</dd>
                    </div>
                ) : null}
                {/* Kept visible even at zero — especially at zero. Gaslessness is the
                    demo's central claim, and a number that only appears when it is
                    non-zero is a number nobody can verify stayed at zero. */}
                <div className="row">
                    <dt>지불 계정 ETH</dt>
                    <dd>{formatEther(nativeBalance)} ETH</dd>
                </div>
            </dl>
            <p className="note">
                {ready
                    ? "회수 가스는 지불 계정의 EntryPoint 예치금에서 걷힙니다. 계정의 ETH 잔액이 아닙니다."
                    : "예치금이 없으면 회수는 AA21로 실패합니다. relayer가 EntryPoint.depositTo 로 채워야 하며, 그래도 지불 계정의 ETH 잔액은 0으로 유지됩니다 — 대신 relayer는 그 예치금을 되돌려 받을 수 없습니다."}{" "}
                예치금이 필요 없는 백스톱은 <code>DelegationManager.pause()</code>이며, 이건
                Framework 소유자의 평범한 EOA 트랜잭션입니다.
            </p>
        </>
    );
}

/**
 * Whether the kill switch can actually fire.
 *
 * Revocation is the one operation that cannot avoid the EntryPoint, and the EntryPoint
 * charges the account's *deposit*, not its ETH. With no deposit the operation fails
 * `AA21` — so a revoke panel showing only a button claims a capability the chain may
 * not currently have. This holds its own query: it is supplementary, and a failed read
 * here must not blank the delegation screen around it.
 */
export function RevocationFunding({payer}: {payer: Address}) {
    const funding = useQuery({
        queryKey: ["prefund", payer, rpcUrl],
        queryFn: () =>
            readRevocationPrefundState({
                publicClient,
                entryPoint: deployment.environment.EntryPoint,
                sender: payer,
                requiredPrefund: REQUIRED_PREFUND,
            }),
        refetchInterval: 10_000,
    });

    if (funding.isPending) return <p className="note">재원을 읽는 중…</p>;
    if (funding.isError) {
        return <p className="note">재원 상태를 읽지 못했습니다 — {faultLine(funding.error)}</p>;
    }
    return <RevocationFundingView state={funding.data} required={REQUIRED_PREFUND} />;
}

/**
 * The kill switch, wired.
 *
 * Three things happen here that are worth stating, because each replaces a failure mode
 * that reads as something else:
 *
 * 1. The connected wallet is compared against the account's `owner()` *before* anything is
 *    signed. The account validates through ERC-1271, so a wrong signer comes back from the
 *    EntryPoint as `AA24 signature error` — indistinguishable, to a person, from a nonce or
 *    gas problem.
 * 2. The nonce is read at click time and the operation is built from it in one shot.
 *    `buildRevocationUserOperation` is pure precisely so nothing can be re-read between
 *    building and signing; a value that drifts in between produces a stale digest and,
 *    again, `AA24`.
 * 3. The body is built by `buildRevocationSubmissionBody` — the same module the submitter
 *    validates with — so the encoder and decoder of this wire format cannot drift apart.
 */
export function RevokeButton({
    delegation,
    permissionContext,
    payer,
    revoked,
}: {
    delegation: Delegation;
    /**
     * Forwarded verbatim from configuration, not re-encoded from `delegation`. The
     * submitter takes the root as `decodeDelegations(context).at(-1)`, so re-encoding here
     * would introduce a second encoder for a value that already exists — the same class of
     * drift the EIP-712 domain once cost this repo.
     */
    permissionContext: Hex;
    payer: Address;
    revoked: boolean;
}) {
    // Not thrown. `vite.config.ts` already refuses a non-loopback value at build time, so
    // reaching this catch means something bypassed the build — and an uncaught throw during
    // render unmounts the root and leaves a blank page with no hint of which variable was
    // wrong. Same lesson as `useRootDelegation`.
    let submitterUrl: string | undefined;
    let submitterFault: string | undefined;
    try {
        submitterUrl = configuredSubmitterUrl();
    } catch (error) {
        submitterFault = faultLine(error);
    }
    // `useAccount().chainId` rather than `useChainId()`: the latter falls back to the
    // config's first chain while disconnected, so it can never report a mismatch, and a
    // guard that cannot fire is worse than none.
    const {address: connected, chainId: connectedChainId} = useAccount();
    const {connect, connectors, isPending: connecting, error: connectError} = useConnect();
    const {signTypedDataAsync} = useSignTypedData();
    const [progress, setProgress] = useState<RevokeProgress>({phase: "idle"});

    const owner = useQuery({
        queryKey: ["owner", payer, rpcUrl],
        queryFn: () => readAccountOwner({publicClient, account: payer}),
        staleTime: Infinity,
    });

    const funding = useQuery({
        queryKey: ["prefund", payer, rpcUrl],
        queryFn: () =>
            readRevocationPrefundState({
                publicClient,
                entryPoint: deployment.environment.EntryPoint,
                sender: payer,
                requiredPrefund: REQUIRED_PREFUND,
            }),
        refetchInterval: 10_000,
    });

    const gate = judgeRevokeGate({
        submitterUrl,
        revoked,
        connected,
        connectedChainId,
        expectedChainId: chain.id,
        owner: owner.data,
        shortfall: funding.data?.shortfall,
    });

    async function run(): Promise<void> {
        if (gate.kind !== "ready" || !submitterUrl) return;
        try {
            setProgress({phase: "signing"});
            const entryPoint = deployment.environment.EntryPoint;
            const nonce = await readRevocationNonce({publicClient, entryPoint, sender: payer});
            const built = buildRevocationUserOperation({
                delegation,
                entryPoint,
                chainId: chain.id,
                nonce,
                gas: DEFAULT_REVOCATION_GAS,
            });
            const signature = await signTypedDataAsync({
                domain: built.typedData.domain,
                types: built.typedData.types,
                primaryType: "PackedUserOperation",
                message: built.typedData.message,
            });
            const final = finalizeRevocationUserOperation(built, signature as Hex);

            setProgress({phase: "submitting"});
            const response = await fetch(`${submitterUrl}/revoke`, {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify(
                    buildRevocationSubmissionBody({
                        permissionContext,
                        packed: final.packed,
                    }),
                ),
            });
            const body = (await response.json()) as {
                success?: boolean;
                transaction?: string;
                reason?: string;
                detail?: Record<string, string>;
            };
            if (!response.ok || !body.success) {
                setProgress({phase: "failed", reason: describeRefusal(body)});
                return;
            }
            setProgress({phase: "done", transaction: body.transaction ?? ""});
            void owner.refetch();
            void funding.refetch();
        } catch (error) {
            setProgress({phase: "failed", reason: faultLine(error)});
        }
    }

    const busy = progress.phase === "signing" || progress.phase === "submitting";

    return (
        <>
            <button
                type="button"
                disabled={busy || connecting || (gate.kind !== "ready" && gate.kind !== "disconnected")}
                onClick={() => {
                    if (gate.kind === "disconnected") {
                        const connector = connectors[0];
                        if (connector) connect({connector});
                        return;
                    }
                    void run();
                }}
            >
                {busy
                    ? progress.phase === "signing"
                        ? "지갑에서 서명 대기 중…"
                        : "제출 중…"
                    : revokeButtonLabel(gate)}
            </button>
            {submitterFault ? (
                <p className="note fault">
                    <code>VITE_REVOCATION_SUBMITTER_URL</code>이 잘못되었습니다 — {submitterFault}
                </p>
            ) : (
                <RevokeGateNote gate={gate} />
            )}
            <RevokeConnectNote error={connectError} />
            <RevokeProgressNote progress={progress} />
        </>
    );
}

/**
 * Turn the submitter's machine-readable refusal into the sentence it stands for.
 *
 * Exported for the same reason `revokeButtonLabel` is: these five sentences are the only
 * thing an owner sees when the kill switch does not fire, and each names a different party
 * who has to act. Getting `prefund_short` and `relayer_unfunded` the wrong way round would
 * send someone to top up the wrong account.
 */
export function describeRefusal(body: {reason?: string; detail?: Record<string, string>}): string {
    const detail = body.detail ?? {};
    switch (body.reason) {
        case "prefund_short":
            return `EntryPoint 예치금이 ${detail["shortfall"] ?? "?"} wei 모자랍니다 — relayer가 depositTo로 채워야 합니다`;
        case "base_fee_unreadable":
            return "현재 base fee를 읽지 못해, 서명된 수수료가 회수 가능한지 판단할 수 없습니다 — 다시 시도해 주세요";
        case "fee_below_basefee":
            return `서명된 maxFeePerGas(${detail["maxFeePerGas"] ?? "?"})가 현재 base fee(${detail["baseFeePerGas"] ?? "?"}) 아래라, 제출자가 회수할 수 없는 비용을 떠안게 됩니다`;
        case "relayer_unfunded":
            return "제출자 relayer의 ETH가 부족해 트랜잭션을 먼저 낼 수 없습니다";
        case "invalid_submission":
            return `제출이 거절되었습니다 — ${detail["message"] ?? "형식 오류"}`;
        default:
            return detail["message"] ?? body.reason ?? "제출에 실패했습니다";
    }
}

export function RevokeGateNote({gate}: {gate: ReturnType<typeof judgeRevokeGate>}) {
    switch (gate.kind) {
        case "no-submitter":
            return (
                <p className="note">
                    <code>VITE_REVOCATION_SUBMITTER_URL</code>이 설정되지 않았습니다. 서명을
                    보낼 곳이 없으므로 버튼은 비활성입니다 — 보낼 곳 없는 서명을 받아두는
                    쪽이 더 나쁩니다.
                </p>
            );
        case "wrong-chain":
            return (
                <p className="note">
                    지갑이 체인 {gate.connected}에 있습니다. 이 서명은 GIWA Sepolia(
                    {gate.expected}) 전용이라 지갑이 서명 창을 띄우지도 않습니다 —
                    EIP-712 <code>domain.chainId</code>가 선택된 네트워크와 다르기 때문입니다.
                    지갑 네트워크를 GIWA Sepolia로 바꾸세요.
                </p>
            );
        case "wrong-wallet":
            return (
                <p className="note">
                    연결된 지갑 {short(gate.connected)}은 이 계정의 소유자가 아닙니다. 소유자는{" "}
                    {short(gate.owner)}입니다. 이대로 서명하면 EntryPoint가{" "}
                    <code>AA24 signature error</code>로 거절합니다.
                </p>
            );
        case "unarmed":
            return (
                <p className="note">
                    예치금이 {formatEther(gate.shortfall)} ETH 모자랍니다. 회수는{" "}
                    <code>AA21</code>로 실패하므로 버튼을 잠급니다.
                </p>
            );
        default:
            return null;
    }
}

/**
 * Why the wallet never appeared.
 *
 * `useConnect`'s error was previously read by nobody. With no extension installed the
 * injected connector throws `ProviderNotFoundError`, and the entire symptom was a button
 * that did nothing when clicked — indistinguishable from a dead handler, which is what
 * anyone would go looking for first.
 *
 * Pure and exported for the same reason the other three notes here are: the branch cannot
 * be reached by rendering `RevokeButton`, because a static render has no failed
 * connection attempt in it. Extracting it is what makes the branch provable at all.
 */
export function RevokeConnectNote({error}: {error: Error | null}) {
    if (!error) return null;
    return <p className="note fault">지갑에 연결하지 못했습니다 — {faultLine(error)}</p>;
}

export function RevokeProgressNote({progress}: {progress: RevokeProgress}) {
    if (progress.phase === "done") {
        return (
            <p className="note">
                회수 완료 —{" "}
                {progress.transaction ? (
                    <a
                        href={explorerTxUrl(progress.transaction)}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {short(progress.transaction)}
                    </a>
                ) : (
                    "트랜잭션 해시가 반환되지 않았습니다"
                )}
                . 이 세션키는 더 이상 지불할 수 없습니다.
            </p>
        );
    }
    if (progress.phase === "failed") {
        return <p className="note fault">회수하지 못했습니다 — {progress.reason}</p>;
    }
    return null;
}
