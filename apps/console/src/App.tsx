import {
    readDelegationStatus,
    readSettlementReceipts,
    type SettlementReceipt,
} from "@mapae/delegation/delegation-status";
import {buildRevocationCall} from "@mapae/delegation/revocation";
import {explorerTxUrl, fromTokenAmount} from "@mapae/shared";
import {decodeDelegations, hashDelegation} from "@metamask/smart-accounts-kit/utils";
import {useQuery} from "@tanstack/react-query";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {useMemo, useState} from "react";
import type {Hex} from "viem";
import {
    RECEIPT_LOOKBACK_BLOCKS,
    chain,
    configuredPermissionContext,
    deployment,
    publicClient,
    rpcUrl,
} from "./config";

import {Engraving, short, stamp} from "./Engraving";
import {faultLine} from "./fault";
import {RevocationFunding, RevokeButton} from "./Revocation";

/**
 * `context` rides along rather than being re-derived at the point of use. The revoke
 * button forwards it to the submitter verbatim, and the alternative — narrowing the
 * component's own `Hex | undefined` with a cast — is exactly the "validate, never cast"
 * pattern this repo already got burned by.
 */
type RootDelegation = {root: Delegation; chainLength: number; context: Hex};

/**
 * `decodeDelegations` throws on hex that is well-formed hex but not a
 * `Delegation[]` — a truncated paste of a ~2 kB permission context is the likely
 * first-run mistake, and `config.ts` can only check that it is hex at all. This
 * runs during render with no error boundary above it, so an uncaught throw
 * unmounts the root and leaves a blank page: no message, no hint, nothing but
 * the grain overlay. The failure is reported instead of thrown.
 */
export type RootDelegationState =
    | {kind: "unset"}
    | {kind: "invalid"; reason: string}
    | {kind: "ok"; value: RootDelegation};

/**
 * The console's entry gate: which of the three first screens the operator gets.
 *
 * Pure and exported so it can be tested without a React tree or a provider, the same
 * split as `revoke-state.ts`. Three things here are load-bearing.
 *
 * **An absent context is `unset`, never `invalid`.** The committed `.env.example` ships
 * `VITE_PERMISSION_CONTEXT=0x`, which `configuredPermissionContext` reads as absent, so
 * this is the literal first-run state for anyone following the README. `unset` prints
 * "set this variable"; `invalid` prints "this could not be decoded" — the second sends a
 * new reader looking for a corrupted value they never had.
 *
 * **The root is the last link, not the first.** `decodeDelegations` returns leaf-first,
 * and the leaf is the throwaway the agent mints per 402. Taking `[0]` would put that
 * leaf's single-payment allowance on screen as though it were the account's delegated
 * cap.
 *
 * **A bad context returns a reason instead of throwing.** A throw here unmounts the whole
 * page, and this repo has already paid for that twice — `configuredSubmitterUrl` did it,
 * and the note at `Revocation.tsx:151` records the same lesson.
 */
export function resolveRootDelegation(context: Hex | undefined): RootDelegationState {
    if (!context) return {kind: "unset"};
    try {
        // `chainLength` is carried along because in a re-delegated chain every link has
        // its own caveats and an intermediate one can be tighter than the root shown here.
        const chain = decodeDelegations(context);
        const root = chain.at(-1);
        if (!root) return {kind: "invalid", reason: "위임이 하나도 들어 있지 않습니다"};
        return {kind: "ok", value: {root, chainLength: chain.length, context}};
    } catch (error) {
        return {kind: "invalid", reason: faultLine(error)};
    }
}

function useRootDelegation(context: Hex | undefined): RootDelegationState {
    return useMemo(() => resolveRootDelegation(context), [context]);
}

function DelegationScreen({delegation}: {delegation: RootDelegation}) {
    const {root, chainLength, context} = delegation;

    const status = useQuery({
        queryKey: ["status", root.delegate, rpcUrl],
        queryFn: () =>
            readDelegationStatus({
                publicClient,
                environment: deployment.environment,
                delegation: root,
            }),
        refetchInterval: 10_000,
    });

    if (status.isPending) return <div className="panel note">체인에서 읽는 중…</div>;
    if (status.isError) {
        return (
            <div className="panel fault">상태를 읽지 못했습니다 — {faultLine(status.error)}</div>
        );
    }

    const value = status.data;
    const revocation = buildRevocationCall(root);
    const live = !value.revoked && !value.expired && !value.notYetActive;

    return (
        <div className="stagger">
            <section className="panel">
                <h2>주기 한도</h2>
                <Engraving status={value} />
                {chainLength > 1 ? (
                    <p className="note">
                        재위임 {chainLength}단 체인입니다. 여기 표시된 한도는 루트 기준이며,
                        중간 위임이 더 좁을 수 있습니다 — 실제 구속 한도는 체인에서 가장 좁은
                        링크입니다.
                    </p>
                ) : null}
            </section>

            <section className="panel">
                <h2>각인</h2>
                <dl>
                    <div className="row">
                        <dt>상태</dt>
                        <dd>
                            <span className="state" data-tone={live ? "ok" : "bad"}>
                                {value.revoked
                                    ? "회수됨"
                                    : value.expired
                                      ? "만료됨"
                                      : value.notYetActive
                                        ? "미개시"
                                        : "유효"}
                            </span>
                        </dd>
                    </div>
                    <div className="row">
                        <dt>지불 계정</dt>
                        <dd>{value.delegator}</dd>
                    </div>
                    <div className="row">
                        <dt>세션키</dt>
                        <dd>{value.delegate}</dd>
                    </div>
                    {/* `TimestampEnforcer` tests each half with `> 0`, so a
                        one-sided window is a supported configuration and a zero
                        threshold means unbounded — not 1970. The reader already
                        encodes that (`judgeValidity`); gating on the caveat's mere
                        existence made the renderer contradict it, printing
                        "만료 1970-01-01" beside a 유효 badge. */}
                    {value.validity && value.validity.notBefore > 0n ? (
                        <div className="row">
                            <dt>개시</dt>
                            <dd>{stamp(value.validity.notBefore)}</dd>
                        </div>
                    ) : null}
                    {value.validity && value.validity.notAfter > 0n ? (
                        <div className="row">
                            <dt>만료</dt>
                            <dd>{stamp(value.validity.notAfter)}</dd>
                        </div>
                    ) : null}
                    <div className="row">
                        <dt>위임 해시</dt>
                        <dd>{short(value.delegationHash)}</dd>
                    </div>
                </dl>
            </section>

            <section className="panel revoke">
                <h2>회수</h2>
                <p>
                    한도는 온체인 caveat이 강제합니다. 회수는 그 권한을 즉시 끊는 유일한
                    수단이며, 지불 계정 자신만 실행할 수 있습니다.
                </p>
                <RevokeButton
                    delegation={root}
                    permissionContext={context}
                    payer={value.delegator}
                    revoked={value.revoked}
                />
                <RevocationFunding payer={value.delegator} />
                <div className="calldata">
                    <b>to</b> {revocation.to}
                    <br />
                    <b>data</b> {short(revocation.data)}
                    <br />
                    <b>경로</b> DeleGatorCore.disableDelegation — onlyEntryPointOrSelf 이므로
                    EntryPoint UserOperation 으로만 제출됩니다.
                </div>
            </section>
        </div>
    );
}

function ReceiptScreen({delegation}: {delegation: RootDelegation}) {
    const {root} = delegation;

    const receipts = useQuery({
        queryKey: ["receipts", root.delegate, rpcUrl],
        queryFn: async (): Promise<SettlementReceipt[]> => {
            const head = await publicClient.getBlockNumber();
            const from = head > RECEIPT_LOOKBACK_BLOCKS ? head - RECEIPT_LOOKBACK_BLOCKS : 0n;
            // The delegation hash is a pure function of the struct the console
            // already decoded, so asking the chain for it would be a second
            // round-trip on every 10s refetch for a value we can derive.
            return readSettlementReceipts({
                publicClient,
                environment: deployment.environment,
                delegationHash: hashDelegation(root),
                fromBlock: from,
            });
        },
        refetchInterval: 10_000,
    });

    if (receipts.isPending) return <div className="panel note">체인에서 읽는 중…</div>;
    if (receipts.isError) {
        return (
            <div className="panel fault">영수증을 읽지 못했습니다 — {faultLine(receipts.error)}</div>
        );
    }

    return (
        <section className="panel">
            <h2>정산 영수증 · 최근 {String(RECEIPT_LOOKBACK_BLOCKS)} 블록</h2>
            {receipts.data.length === 0 ? (
                <p className="note">이 창에는 정산 기록이 없습니다.</p>
            ) : (
                receipts.data
                    .slice()
                    .reverse()
                    .map((receipt) => (
                        <a
                            key={receipt.transactionHash}
                            className="receipt"
                            href={explorerTxUrl(receipt.transactionHash)}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            <div className="receipt-head">
                                <span className="amount">
                                    {receipt.amount !== undefined
                                        ? `${fromTokenAmount(receipt.amount)} mUSDC`
                                        : `주기 누적 ${fromTokenAmount(receipt.transferredInCurrentPeriod)} mUSDC`}
                                </span>
                                <span className="when">{stamp(receipt.transferTimestamp)}</span>
                            </div>
                            <div className="hash">{receipt.transactionHash}</div>
                        </a>
                    ))
            )}
            <p className="note" style={{marginTop: 14}}>
                영수증은 <code>ERC20PeriodTransferEnforcer</code>의{" "}
                <code>TransferredInPeriod</code> 이벤트에서 직접 읽습니다. 별도 원장도,
                계정 체계도 없습니다.
            </p>
        </section>
    );
}

export default function App() {
    const [tab, setTab] = useState<"delegation" | "receipts">("delegation");
    const context = configuredPermissionContext();
    const delegation = useRootDelegation(context);

    return (
        <main className="tally">
            <header className="crest">
                <h1>馬牌</h1>
                <p>bounded authority</p>
            </header>

            {/* Rendered only when there is something behind them. Unconfigured is
                the default first run — there is no .env here — and the tabs gave
                full active-state feedback over a panel that never changed, so the
                very first interaction anyone tried read as a dead button. */}
            {delegation.kind === "ok" ? (
                <nav className="tabs">
                    <button
                        type="button"
                        data-active={tab === "delegation"}
                        onClick={() => setTab("delegation")}
                    >
                        위임 · 한도
                    </button>
                    <button
                        type="button"
                        data-active={tab === "receipts"}
                        onClick={() => setTab("receipts")}
                    >
                        영수증
                    </button>
                </nav>
            ) : null}

            {delegation.kind === "unset" ? (
                <div className="panel note">
                    검사할 위임이 설정되지 않았습니다. <code>VITE_PERMISSION_CONTEXT</code>에
                    서명된 permission context를 넣고 다시 실행하세요.
                </div>
            ) : delegation.kind === "invalid" ? (
                <div className="panel fault">
                    <code>VITE_PERMISSION_CONTEXT</code>를 위임 체인으로 해석하지 못했습니다 —{" "}
                    {delegation.reason}
                    <br />
                    서명된 permission context 전체가 잘렸는지 확인하세요.
                </div>
            ) : tab === "delegation" ? (
                <DelegationScreen delegation={delegation.value} />
            ) : (
                <ReceiptScreen delegation={delegation.value} />
            )}

            <p className="footnote">
                {chain.name} · {new URL(rpcUrl).host} · read-only
            </p>
        </main>
    );
}
