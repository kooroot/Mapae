import {
    readDelegationStatus,
    readSettlementReceipts,
    type DelegationStatus,
    type SettlementReceipt,
} from "@mapae/delegation/delegation-status";
import {fromTokenAmount} from "@mapae/shared";
import {
    Activity,
    ArrowLeft,
    ArrowUpRight,
    CircleGauge,
    Clock3,
    FileKey2,
    Fingerprint,
    KeyRound,
    LockKeyhole,
    RefreshCw,
    RotateCcwKey,
    ShieldCheck,
    ShieldOff,
    Sparkles,
    TimerReset,
    WalletCards,
    type LucideIcon,
} from "lucide-react";
import {useEffect, useMemo, useState} from "react";
import {PassEmblem, Wordmark} from "../brand/marks";
import {AgentGrantList} from "./AgentGrantList";
import {GrantOnboarding} from "./GrantOnboarding";
import {Web3Providers} from "./Web3Providers";
import {
    chain,
    deployment,
    docsUrl,
    explorerAddressUrl,
    explorerTxUrl,
    landingUrl,
    publicClient,
    publicSubmitterAvailability,
    submitterAvailability,
} from "../lib/config";
import {RevokeButton} from "./RevokeButton";
import {awaitRevocationVisible} from "../lib/revoke";
import {short, struckPercent} from "../lib/dial";
import {
    importedSessionGrant,
    judgeSpendable,
    readPayerBalance,
    type SessionGrant,
    verifyPermissionArtifact,
} from "../lib/grant";
import {parsePermissionContext, type ParsedPermission} from "../lib/permission";

type LoadedPermission = Extract<ParsedPermission, {kind: "ok"}>;
type DetailSection = "overview" | "activity" | "security";
type StudioSection = "create" | "agents" | DetailSection;
type ReadState<T> =
    | {kind: "idle"}
    | {kind: "loading"}
    | {kind: "error"; reason: string}
    | {kind: "ok"; value: T};

type ReceiptWindow = {
    receipts: SettlementReceipt[];
    fromBlock: bigint;
    openedAt?: bigint;
};

const RECEIPT_LOOKBACK_BLOCKS = 50_000n;

const SECTION_META: Record<
    DetailSection,
    {label: string; eyebrow: string; title: string; description: string; icon: LucideIcon}
> = {
    overview: {
        label: "권한",
        eyebrow: "LIVE AUTHORITY",
        title: "위임된 권한",
        description: "체인이 지금 허용하는 범위를 읽습니다.",
        icon: CircleGauge,
    },
    activity: {
        label: "활동",
        eyebrow: "ONCHAIN ACTIVITY",
        title: "정산 기록",
        description: "별도 원장 없이 enforcer 이벤트를 조회합니다.",
        icon: Activity,
    },
    security: {
        label: "회수",
        eyebrow: "OWNER CONTROL",
        title: "회수와 보안",
        description: "권한을 끝내는 경로와 현재 준비 상태를 확인합니다.",
        icon: ShieldCheck,
    },
};

export function Studio() {
    return (
        <Web3Providers>
            <StudioBody />
        </Web3Providers>
    );
}

function StudioBody() {
    const [loadedRaw, setLoadedRaw] = useState("");
    const [section, setSection] = useState<StudioSection>("create");
    const [grants, setGrants] = useState<SessionGrant[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    const loadedState = useMemo(() => parsePermissionContext(loadedRaw), [loadedRaw]);
    const permission = loadedState.kind === "ok" ? loadedState : undefined;
    const status = useDelegationStatus(permission, refreshKey);
    const delegationHash =
        status.kind === "ok" ? status.value.delegationHash : undefined;
    const receipts = useSettlementReceipts(
        delegationHash,
        Boolean(permission) && section === "activity",
        refreshKey,
    );

    function openGrant(grant: SessionGrant) {
        setLoadedRaw(grant.artifact.permissionContext);
        setSection("overview");
    }

    function addGrant(grant: SessionGrant) {
        setGrants((current) => [
            grant,
            ...current.filter(
                (item) =>
                    item.artifact.permissionContext !== grant.artifact.permissionContext,
            ),
        ]);
        openGrant(grant);
    }

    async function importPermission(permissionContext: `0x${string}`) {
        const grant = importedSessionGrant(permissionContext);
        await verifyPermissionArtifact(grant.artifact);
        addGrant(grant);
    }

    function chooseAnotherPermission() {
        setLoadedRaw("");
        setSection("agents");
    }

    const meta =
        section === "overview" || section === "activity" || section === "security"
            ? SECTION_META[section]
            : SECTION_META.overview;

    return (
        <div className="studio-shell">
            <StudioSidebar
                section={section}
                hasPermission={Boolean(permission)}
                onSectionChange={setSection}
            />

            <main className="studio-main">
                <header className="studio-topbar">
                    <a className="studio-mobile-brand" href={landingUrl} aria-label="Mapae 홈">
                        <span className="studio-mobile-mark">
                            <PassEmblem size={18} />
                        </span>
                        <Wordmark height={14} />
                    </a>
                    <div className="studio-network">
                        <i aria-hidden="true" />
                        <span>{chain.name}</span>
                        <b>{chain.id}</b>
                    </div>
                </header>

                {section === "create" ? (
                    <GrantOnboarding
                        onGranted={addGrant}
                        onImported={importPermission}
                    />
                ) : section === "agents" || !permission ? (
                    <AgentGrantList
                        grants={grants}
                        selectedContext={loadedRaw}
                        onSelect={openGrant}
                        onCreate={() => setSection("create")}
                    />
                ) : (
                    <div className="studio-workspace">
                        <header className="studio-page-head">
                            <div>
                                <span className="studio-kicker">{meta.eyebrow}</span>
                                <h1>{meta.title}</h1>
                                <p>{meta.description}</p>
                            </div>
                            <div className="studio-head-actions">
                                <button
                                    type="button"
                                    className="studio-icon-button"
                                    aria-label="온체인 상태 새로고침"
                                    title="온체인 상태 새로고침"
                                    onClick={() => setRefreshKey((value) => value + 1)}
                                >
                                    <RefreshCw size={17} />
                                </button>
                                <button
                                    type="button"
                                    className="studio-secondary-button"
                                    onClick={chooseAnotherPermission}
                                >
                                    내 에이전트
                                </button>
                            </div>
                        </header>

                        {status.kind === "loading" || status.kind === "idle" ? (
                            <LoadingWorkspace />
                        ) : status.kind === "error" ? (
                            <ReadFault
                                reason={status.reason}
                                onRetry={() => setRefreshKey((value) => value + 1)}
                            />
                        ) : section === "overview" ? (
                            <Overview permission={permission} status={status.value} />
                        ) : section === "activity" ? (
                            <ActivityView receipts={receipts} />
                        ) : (
                            <SecurityView
                                permission={permission}
                                status={status.value}
                                onRevoked={() => {
                                    // The submitter confirmed the receipt on its own node,
                                    // but this client re-reads through the public RPC's
                                    // load balancer — a single immediate re-read can hit a
                                    // replica still a block or two behind and render the
                                    // grant as active (measured on the first live
                                    // revocation). Poll until the flip is visible, then
                                    // run the ordinary refresh once, authoritatively; on
                                    // timeout the refresh still runs, which is exactly the
                                    // old behavior.
                                    void awaitRevocationVisible({
                                        read: async () =>
                                            (
                                                await readDelegationStatus({
                                                    publicClient,
                                                    environment: deployment.environment,
                                                    delegation: permission.root,
                                                })
                                            ).revoked,
                                    }).finally(() => setRefreshKey((value) => value + 1));
                                }}
                            />
                        )}
                    </div>
                )}
            </main>
        </div>
    );
}

function StudioSidebar({
    section,
    hasPermission,
    onSectionChange,
}: {
    section: StudioSection;
    hasPermission: boolean;
    onSectionChange: (section: StudioSection) => void;
}) {
    return (
        <aside className="studio-sidebar">
            <a className="studio-brand" href={landingUrl} aria-label="Mapae 랜딩으로 이동">
                <span>
                    <PassEmblem size={27} />
                </span>
                <span className="studio-brand-copy">
                    <Wordmark height={15} />
                    <small>STUDIO</small>
                </span>
            </a>

            <nav className="studio-nav" aria-label="Studio 메뉴">
                <button
                    type="button"
                    data-active={section === "create"}
                    onClick={() => onSectionChange("create")}
                >
                    <FileKey2 size={18} />
                    <span>권한 만들기</span>
                </button>
                <button
                    type="button"
                    data-active={section === "agents"}
                    onClick={() => onSectionChange("agents")}
                >
                    <WalletCards size={18} />
                    <span>내 에이전트</span>
                </button>
                {hasPermission ? (
                    (Object.entries(SECTION_META) as Array<
                        [DetailSection, (typeof SECTION_META)[DetailSection]]
                    >).map(([key, item]) => {
                        const Icon = item.icon;
                        return (
                            <button
                                type="button"
                                key={key}
                                data-active={section === key}
                                onClick={() => onSectionChange(key)}
                            >
                                <Icon size={18} />
                                <span>{item.label}</span>
                            </button>
                        );
                    })
                ) : null}
            </nav>

            <div className="studio-sidebar-foot">
                <a href={landingUrl}>
                    <ArrowLeft size={15} />
                    <span>Mapae 소개</span>
                </a>
                <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                    <span>기술 문서</span>
                    <ArrowUpRight size={15} />
                </a>
                <p>TESTNET · WALLET SIGNING</p>
            </div>
        </aside>
    );
}

/**
 * The payer's token balance, refreshed alongside the delegation status.
 *
 * Deliberately separate from `readDelegationStatus`: that function reads the enforcers,
 * which know the cap and nothing about the balance. Folding a token read into it would put
 * an ERC-20 dependency inside the delegation package for the benefit of one screen.
 */
function usePayerBalance(payer: `0x${string}` | undefined): bigint | undefined {
    const [balance, setBalance] = useState<bigint | undefined>(undefined);
    useEffect(() => {
        if (!payer) {
            setBalance(undefined);
            return;
        }
        let current = true;
        void readPayerBalance(payer).then((value) => {
            if (current) setBalance(value);
        });
        return () => {
            current = false;
        };
    }, [payer]);
    return balance;
}

function Overview({
    permission,
    status,
}: {
    permission: LoadedPermission;
    status: DelegationStatus;
}) {
    const balance = usePayerBalance(permission.root.delegator as `0x${string}`);
    const live = !status.revoked && !status.expired && !status.notYetActive;
    const started = (status.currentPeriod ?? 0n) > 0n;
    const cap = status.limit?.periodAmount;
    const remaining = cap === undefined ? undefined : started ? status.remaining : cap;
    const available = remaining ?? cap;
    const spent =
        cap === undefined || remaining === undefined || cap <= remaining ? 0n : cap - remaining;
    const usedPercent =
        cap === undefined || remaining === undefined ? 0 : struckPercent(cap, remaining);

    return (
        <div className="studio-overview">
            <section className="studio-authority-card" data-halted={!live}>
                <div className="studio-authority-copy">
                    <div className="studio-card-label">
                        <span>CURRENT SPENDING AUTHORITY</span>
                        <StatusPill status={status} />
                    </div>

                    {available !== undefined && cap !== undefined ? (
                        <>
                            <p className="studio-amount-label">현재 사용 가능</p>
                            <div className="studio-amount">
                                <strong>
                                    {fromTokenAmount(
                                        judgeSpendable({available, balance}).spendable,
                                    )}
                                </strong>
                                <span>mUSDC</span>
                            </div>
                            {judgeSpendable({available, balance}).limitedBy === "balance" ? (
                                // The cap is not the binding constraint right now. Saying
                                // so here is the difference between a user who funds the
                                // account and one who reads an unexplained payment failure.
                                <p className="studio-amount-note">
                                    한도는 {fromTokenAmount(available)} mUSDC이지만 지불 계정
                                    잔액이 {fromTokenAmount(balance ?? 0n)} mUSDC입니다. 결제하려면
                                    지불 계정에 mUSDC를 채워 주세요.
                                </p>
                            ) : null}
                            <div
                                className="studio-cap-track"
                                role="progressbar"
                                aria-label="현재 주기 사용률"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(usedPercent)}
                            >
                                <i style={{width: `${usedPercent}%`}} />
                            </div>
                            <div className="studio-cap-legend">
                                <span>사용 {fromTokenAmount(spent)} mUSDC</span>
                                <span>한도 {fromTokenAmount(cap)} mUSDC</span>
                            </div>
                        </>
                    ) : (
                        <div className="studio-no-cap">
                            <CircleGauge size={30} />
                            <p>이 위임에는 주기 한도 caveat이 없습니다.</p>
                        </div>
                    )}
                </div>

                <div className="studio-authority-emblem" aria-hidden="true">
                    <span />
                    <PassEmblem size={118} />
                </div>
            </section>

            <section className="studio-metric-grid" aria-label="권한 핵심 정보">
                <Metric
                    icon={WalletCards}
                    label="지불 계정"
                    value={short(status.delegator)}
                    detail="자금이 보관된 스마트 계정"
                    href={explorerAddressUrl(status.delegator)}
                />
                <Metric
                    icon={Clock3}
                    label="주기"
                    value={
                        status.limit ? formatDuration(status.limit.periodDuration) : "제한 없음"
                    }
                    detail={
                        started
                            ? `현재 #${String(status.currentPeriod)} 주기`
                            : "아직 첫 주기 시작 전"
                    }
                />
                <Metric
                    icon={TimerReset}
                    label="만료"
                    value={
                        status.validity?.notAfter
                            ? formatTimestamp(status.validity.notAfter)
                            : "설정 없음"
                    }
                    detail={status.expired ? "이미 만료된 권한" : "체인 시각 기준"}
                />
                <Metric
                    icon={KeyRound}
                    label="위임 깊이"
                    value={`${permission.links}단`}
                    detail={permission.links > 1 ? "중간 링크가 더 좁을 수 있음" : "직접 위임"}
                />
            </section>

            <section className="studio-detail-card">
                <header>
                    <div>
                        <span className="studio-kicker">AUTHORITY DETAILS</span>
                        <h2>체인이 읽은 각인</h2>
                    </div>
                    <a
                        href={explorerAddressUrl(status.delegator)}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        Explorer
                        <ArrowUpRight size={15} />
                    </a>
                </header>
                <dl className="studio-detail-list">
                    <DetailRow label="Delegator" value={status.delegator} />
                    <DetailRow label="Delegate" value={status.delegate} />
                    <DetailRow label="Delegation hash" value={status.delegationHash} />
                    {status.limit ? (
                        <DetailRow label="Asset" value={status.limit.token} />
                    ) : null}
                    {status.validity?.notBefore ? (
                        <DetailRow
                            label="Starts"
                            value={formatTimestamp(status.validity.notBefore)}
                        />
                    ) : null}
                </dl>
            </section>
        </div>
    );
}

function Metric({
    icon: Icon,
    label,
    value,
    detail,
    href,
}: {
    icon: LucideIcon;
    label: string;
    value: string;
    detail: string;
    href?: string;
}) {
    const content = (
        <>
            <i aria-hidden="true">
                <Icon size={19} />
            </i>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
            {href ? <ArrowUpRight className="studio-metric-arrow" size={15} /> : null}
        </>
    );

    return href ? (
        <a className="studio-metric" href={href} target="_blank" rel="noreferrer noopener">
            {content}
        </a>
    ) : (
        <article className="studio-metric">{content}</article>
    );
}

function DetailRow({label, value}: {label: string; value: string}) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function ActivityView({receipts}: {receipts: ReadState<ReceiptWindow>}) {
    if (receipts.kind === "loading" || receipts.kind === "idle") {
        return <LoadingWorkspace compact />;
    }
    if (receipts.kind === "error") {
        return <ReadFault reason={receipts.reason} />;
    }

    const {receipts: rows, fromBlock, openedAt} = receipts.value;
    const windowLabel =
        fromBlock === 0n
            ? "전체 이력"
            : openedAt
              ? `${formatTimestamp(openedAt)} 이후`
              : `최근 ${String(RECEIPT_LOOKBACK_BLOCKS)} 블록`;

    return (
        <div className="studio-activity-view">
            <section className="studio-activity-summary">
                <div>
                    <span className="studio-kicker">SETTLEMENT RECEIPTS</span>
                    <strong>{rows.length}</strong>
                    <p>조회 구간에서 확인된 정산</p>
                </div>
                <div>
                    <span>조회 범위</span>
                    <strong>{windowLabel}</strong>
                    <p>GIWA 공개 RPC의 로그 범위 안에서 읽었습니다.</p>
                </div>
            </section>

            <section className="studio-receipt-card">
                <header>
                    <h2>온체인 활동</h2>
                    <span>ERC20PeriodTransferEnforcer</span>
                </header>
                {rows.length === 0 ? (
                    <div className="studio-empty-activity">
                        <Activity size={26} />
                        <h3>이 조회 구간에는 정산이 없습니다.</h3>
                        <p>
                            이는 결제가 한 번도 없었다는 뜻이 아닐 수 있습니다. 현재 창은 블록{" "}
                            {String(fromBlock)}부터 시작합니다.
                        </p>
                    </div>
                ) : (
                    <div className="studio-receipt-list">
                        {rows
                            .slice()
                            .reverse()
                            .map((receipt) => (
                                <a
                                    key={receipt.transactionHash}
                                    href={explorerTxUrl(receipt.transactionHash)}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                >
                                    <i aria-hidden="true">
                                        <Sparkles size={17} />
                                    </i>
                                    <div>
                                        <strong>
                                            {receipt.amount !== undefined
                                                ? `${fromTokenAmount(receipt.amount)} mUSDC`
                                                : `주기 누적 ${fromTokenAmount(
                                                      receipt.transferredInCurrentPeriod,
                                                  )} mUSDC`}
                                        </strong>
                                        <span>{formatTimestamp(receipt.transferTimestamp)}</span>
                                    </div>
                                    <code>{short(receipt.transactionHash)}</code>
                                    <ArrowUpRight size={17} />
                                </a>
                            ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function SecurityView({
    permission,
    status,
    onRevoked,
}: {
    permission: LoadedPermission;
    status: DelegationStatus;
    onRevoked: () => void;
}) {
    const submitter = submitterAvailability();
    const sponsored = publicSubmitterAvailability();
    const halted = status.revoked || status.expired;

    return (
        <div className="studio-security-view">
            <section className="studio-revoke-card" data-halted={halted}>
                <div className="studio-revoke-icon" aria-hidden="true">
                    {halted ? <ShieldOff size={28} /> : <RotateCcwKey size={28} />}
                </div>
                <div>
                    <span className="studio-kicker">OWNER KILL SWITCH</span>
                    <h2>
                        {status.revoked
                            ? "이 권한은 이미 회수되었습니다."
                            : status.expired
                              ? "이 권한은 만료되었습니다."
                              : "소유자만 권한을 끝낼 수 있습니다."}
                    </h2>
                    <p>
                        소유자 지갑의 EIP-712 서명 한 번으로 이 위임을 온체인에서
                        비활성화합니다. EntryPoint 예치금은 회수 시점에 스폰서가
                        대납하므로, 소유자 지갑에 GIWA ETH가 없어도 됩니다.
                    </p>
                    {status.revoked ? null : (
                        <RevokeButton
                            delegation={permission.root}
                            permissionContext={permission.context}
                            revoked={status.revoked}
                            onRevoked={onRevoked}
                        />
                    )}
                </div>
                <StatusPill status={status} />
            </section>

            <section className="studio-security-grid">
                <SecurityCheck
                    icon={ShieldCheck}
                    title="한도 강제"
                    state="ONCHAIN"
                    body="금액과 주기는 backend가 아니라 ERC20PeriodTransferEnforcer가 검사합니다."
                />
                <SecurityCheck
                    icon={Fingerprint}
                    title="소유자 검증"
                    state="ERC-1271"
                    body="회수 서명자는 smart account의 실제 owner와 일치해야 합니다."
                />
                <SecurityCheck
                    icon={LockKeyhole}
                    title="입력 보존"
                    state="MEMORY ONLY"
                    body="마패 권한 코드는 URL이나 브라우저 저장소에 기록하지 않습니다."
                />
                <SecurityCheck
                    icon={RotateCcwKey}
                    title="회수 경로"
                    state={
                        sponsored.kind === "configured"
                            ? "SPONSORED"
                            : submitter.kind === "configured"
                              ? "LOCAL READY"
                              : "NOT CONFIGURED"
                    }
                    body={
                        sponsored.kind === "configured"
                            ? "회수 예치금은 스폰서가 대납합니다. 서명 권한은 소유자 지갑에만 있습니다."
                            : submitter.kind === "configured"
                              ? "이 로컬 환경에는 회수 제출기가 구성되어 있습니다."
                              : "회수 엔드포인트가 설정되지 않았습니다."
                    }
                />
            </section>

            <section className="studio-security-detail">
                <header>
                    <div>
                        <span className="studio-kicker">REVOCATION PATH</span>
                        <h2>회수 경로</h2>
                    </div>
                    <span>{permission.links} LINK AUTHORITY</span>
                </header>
                <ol>
                    <li>
                        <span>01</span>
                        <div>
                            <strong>소유자 지갑 확인</strong>
                            <p>연결 지갑과 smart account owner를 먼저 대조합니다.</p>
                        </div>
                    </li>
                    <li>
                        <span>02</span>
                        <div>
                            <strong>UserOperation 서명</strong>
                            <p>현재 nonce와 GIWA chain ID를 넣은 EIP-712 메시지를 서명합니다.</p>
                        </div>
                    </li>
                    <li>
                        <span>03</span>
                        <div>
                            <strong>EntryPoint 제출 · 대납</strong>
                            <p>
                                스폰서가 예치금을 채우고 릴레이어가 제출하면 DelegationManager가
                                해당 위임을 비활성화합니다.
                            </p>
                        </div>
                    </li>
                </ol>
            </section>
        </div>
    );
}

function SecurityCheck({
    icon: Icon,
    title,
    state,
    body,
}: {
    icon: LucideIcon;
    title: string;
    state: string;
    body: string;
}) {
    return (
        <article className="studio-security-check">
            <i aria-hidden="true">
                <Icon size={20} />
            </i>
            <span>{state}</span>
            <h3>{title}</h3>
            <p>{body}</p>
        </article>
    );
}

function StatusPill({status}: {status: DelegationStatus}) {
    const state = status.revoked
        ? {label: "회수됨", tone: "halted"}
        : status.expired
          ? {label: "만료됨", tone: "halted"}
          : status.notYetActive
            ? {label: "미개시", tone: "waiting"}
            : {label: "유효", tone: "live"};

    return (
        <span className="studio-status-pill" data-tone={state.tone}>
            <i aria-hidden="true" />
            {state.label}
        </span>
    );
}

function LoadingWorkspace({compact = false}: {compact?: boolean}) {
    return (
        <div className="studio-loading" data-compact={compact}>
            <i />
            <span>GIWA에서 권한 상태를 읽고 있습니다</span>
        </div>
    );
}

function ReadFault({reason, onRetry}: {reason: string; onRetry?: () => void}) {
    return (
        <div className="studio-read-fault" role="alert">
            <ShieldOff size={25} />
            <div>
                <h2>체인 상태를 읽지 못했습니다.</h2>
                <p>{reason}</p>
            </div>
            {onRetry ? (
                <button type="button" onClick={onRetry}>
                    다시 시도
                </button>
            ) : null}
        </div>
    );
}

function useDelegationStatus(
    permission: LoadedPermission | undefined,
    refreshKey: number,
): ReadState<DelegationStatus> {
    const [state, setState] = useState<ReadState<DelegationStatus>>({kind: "idle"});

    useEffect(() => {
        if (!permission) {
            setState({kind: "idle"});
            return;
        }
        let current = true;
        setState({kind: "loading"});
        readDelegationStatus({
            publicClient,
            environment: deployment.environment,
            delegation: permission.root,
        })
            .then((value) => current && setState({kind: "ok", value}))
            .catch(() => {
                if (current) {
                    setState({
                        kind: "error",
                        reason: "공개 GIWA RPC 응답을 확인하고 다시 시도해 주세요.",
                    });
                }
            });
        return () => {
            current = false;
        };
    }, [permission, refreshKey]);

    return state;
}

function useSettlementReceipts(
    delegationHash: DelegationStatus["delegationHash"] | undefined,
    enabled: boolean,
    refreshKey: number,
): ReadState<ReceiptWindow> {
    const [state, setState] = useState<ReadState<ReceiptWindow>>({kind: "idle"});

    useEffect(() => {
        if (!delegationHash || !enabled) {
            setState({kind: "idle"});
            return;
        }
        let current = true;
        setState({kind: "loading"});

        async function read(): Promise<ReceiptWindow> {
            if (!delegationHash) throw new Error("delegation hash is absent");
            const head = await publicClient.getBlockNumber();
            const fromBlock =
                head > RECEIPT_LOOKBACK_BLOCKS ? head - RECEIPT_LOOKBACK_BLOCKS : 0n;
            const [receipts, openedAt] = await Promise.all([
                readSettlementReceipts({
                    publicClient,
                    environment: deployment.environment,
                    delegationHash,
                    fromBlock,
                }),
                publicClient
                    .getBlock({blockNumber: fromBlock})
                    .then((block) => block.timestamp)
                    .catch(() => undefined),
            ]);
            return {receipts, fromBlock, openedAt};
        }

        read()
            .then((value) => current && setState({kind: "ok", value}))
            .catch(() => {
                if (current) {
                    setState({
                        kind: "error",
                        reason: "정산 이벤트를 읽지 못했습니다. 조회 범위 또는 RPC 상태를 확인해 주세요.",
                    });
                }
            });

        return () => {
            current = false;
        };
    }, [delegationHash, enabled, refreshKey]);

    return state;
}

function formatDuration(seconds: bigint): string {
    if (seconds <= 0n) return "제한 없음";
    if (seconds % 86_400n === 0n) return `${String(seconds / 86_400n)}일`;
    if (seconds % 3_600n === 0n) return `${String(seconds / 3_600n)}시간`;
    if (seconds % 60n === 0n) return `${String(seconds / 60n)}분`;
    return `${String(seconds)}초`;
}

function formatTimestamp(seconds: bigint): string {
    if (seconds <= 0n || seconds > 8_640_000_000_000n) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
    }).format(new Date(Number(seconds) * 1000));
}
