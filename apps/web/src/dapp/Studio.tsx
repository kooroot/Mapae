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
import {pick, type Locale} from "../lib/i18n";
import {LocaleSwitch, useLocale} from "../lib/locale";

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

/** Locale-independent section chrome; the kickers are English in both locales. */
const SECTION_META: Record<DetailSection, {eyebrow: string; icon: LucideIcon}> = {
    overview: {eyebrow: "LIVE AUTHORITY", icon: CircleGauge},
    activity: {eyebrow: "ONCHAIN ACTIVITY", icon: Activity},
    security: {eyebrow: "OWNER CONTROL", icon: ShieldCheck},
};

const COPY: Record<
    Locale,
    {
        sections: Record<DetailSection, {label: string; title: string; description: string}>;
        mobileHomeAria: string;
        refreshAria: string;
        myAgents: string;
        landingAria: string;
        navAria: string;
        createGrant: string;
        aboutMapae: string;
        techDocs: string;
        availableNow: string;
        haltRevoked: {label: string; note: string};
        haltExpired: {label: string; note: string};
        haltNotStarted: {label: string; note: string};
        balanceNote: (cap: string, balance: string) => string;
        usageAria: string;
        spentLegend: (amount: string) => string;
        capLegend: (amount: string) => string;
        noCapCaveat: string;
        metricsAria: string;
        payerAccount: string;
        payerAccountDetail: string;
        period: string;
        noLimit: string;
        currentPeriodDetail: (period: string) => string;
        firstPeriodPending: string;
        expiry: string;
        notSet: string;
        alreadyExpired: string;
        chainTime: string;
        delegationDepth: string;
        depthValue: (links: number) => string;
        depthIndirect: string;
        depthDirect: string;
        engravingTitle: string;
        fullHistory: string;
        since: (timestamp: string) => string;
        lastBlocks: (blocks: string) => string;
        settlementsInWindow: string;
        readWindow: string;
        readWindowDetail: string;
        onchainActivity: string;
        emptyWindowTitle: string;
        emptyWindowNote: (fromBlock: string) => string;
        periodTotal: (amount: string) => string;
        revokedHeading: string;
        expiredHeading: string;
        ownerOnlyHeading: string;
        killSwitchBody: string;
        capCheckTitle: string;
        capCheckBody: string;
        ownerCheckTitle: string;
        ownerCheckBody: string;
        inputCheckTitle: string;
        inputCheckBody: string;
        revocationPathTitle: string;
        revocationSponsoredBody: string;
        revocationLocalBody: string;
        revocationAbsentBody: string;
        stepOwnerTitle: string;
        stepOwnerBody: string;
        stepSignTitle: string;
        stepSignBody: string;
        stepSubmitTitle: string;
        stepSubmitBody: string;
        pillRevoked: string;
        pillExpired: string;
        pillNotStarted: string;
        pillActive: string;
        loading: string;
        readFaultHeading: string;
        retry: string;
        statusReadError: string;
        receiptsReadError: string;
    }
> = {
    en: {
        sections: {
            overview: {
                label: "Authority",
                title: "Delegated authority",
                description: "Reads what the chain allows right now.",
            },
            activity: {
                label: "Activity",
                title: "Settlement history",
                description: "Reads enforcer events — no separate ledger.",
            },
            security: {
                label: "Revoke",
                title: "Revocation and security",
                description: "The path that ends this permission, and its current readiness.",
            },
        },
        mobileHomeAria: "Mapae home",
        refreshAria: "Refresh on-chain state",
        myAgents: "My agents",
        landingAria: "Go to the Mapae landing page",
        navAria: "Studio menu",
        createGrant: "Create a grant",
        aboutMapae: "About Mapae",
        techDocs: "Technical docs",
        availableNow: "Available now",
        haltRevoked: {
            label: "No longer available",
            note: "This permission was revoked on chain. The payer account refuses any payment that presents it, whatever the cap below says.",
        },
        haltExpired: {
            label: "No longer available",
            note: "This permission is past its expiry. The payer account refuses any payment that presents it, whatever the cap below says.",
        },
        haltNotStarted: {
            label: "Not yet available",
            note: "This permission has not reached its start time. Payments made with it are rejected until then.",
        },
        balanceNote: (cap, balance) =>
            `The cap is ${cap} mUSDC, but the payer account balance is ${balance} mUSDC. Fund the payer account with mUSDC to pay.`,
        usageAria: "Current period usage",
        spentLegend: (amount) => `Spent ${amount} mUSDC`,
        capLegend: (amount) => `Cap ${amount} mUSDC`,
        noCapCaveat: "This delegation has no period cap caveat.",
        metricsAria: "Key permission details",
        payerAccount: "Payer account",
        payerAccountDetail: "The smart account holding the funds",
        period: "Period",
        noLimit: "No limit",
        currentPeriodDetail: (period) => `Now in period #${period}`,
        firstPeriodPending: "First period not started yet",
        expiry: "Expiry",
        notSet: "Not set",
        alreadyExpired: "Already expired",
        chainTime: "By chain time",
        delegationDepth: "Delegation depth",
        depthValue: (links) => `${links} ${links === 1 ? "link" : "links"}`,
        depthIndirect: "Intermediate links may be narrower",
        depthDirect: "Direct delegation",
        engravingTitle: "The engraving the chain reads",
        fullHistory: "Full history",
        since: (timestamp) => `Since ${timestamp}`,
        lastBlocks: (blocks) => `Last ${blocks} blocks`,
        settlementsInWindow: "Settlements found in this window",
        readWindow: "Read window",
        readWindowDetail: "Read within the public GIWA RPC's log range.",
        onchainActivity: "On-chain activity",
        emptyWindowTitle: "No settlements in this window.",
        emptyWindowNote: (fromBlock) =>
            `This does not necessarily mean no payment ever happened. The current window starts at block ${fromBlock}.`,
        periodTotal: (amount) => `Period total ${amount} mUSDC`,
        revokedHeading: "This permission has already been revoked.",
        expiredHeading: "This permission has expired.",
        ownerOnlyHeading: "Only the owner can end this permission.",
        killSwitchBody:
            "A single EIP-712 signature from the owner wallet disables this delegation on chain. The sponsor covers the EntryPoint deposit at revocation time, so the owner wallet needs no GIWA ETH.",
        capCheckTitle: "Cap enforcement",
        capCheckBody:
            "The amount and period are checked by ERC20PeriodTransferEnforcer, not by a backend.",
        ownerCheckTitle: "Owner verification",
        ownerCheckBody: "The revocation signer must match the smart account's actual owner.",
        inputCheckTitle: "Input handling",
        inputCheckBody:
            "The Mapae permission code is never written to a URL or to browser storage.",
        revocationPathTitle: "Revocation path",
        revocationSponsoredBody:
            "The revocation deposit is covered by the sponsor. Signing authority stays with the owner wallet alone.",
        revocationLocalBody: "A revocation submitter is configured in this local environment.",
        revocationAbsentBody: "No revocation endpoint is configured.",
        stepOwnerTitle: "Owner wallet check",
        stepOwnerBody: "The connected wallet is checked against the smart account owner first.",
        stepSignTitle: "UserOperation signature",
        stepSignBody:
            "The owner signs an EIP-712 message carrying the current nonce and the GIWA chain ID.",
        stepSubmitTitle: "EntryPoint submission · sponsored",
        stepSubmitBody:
            "The sponsor tops up the deposit, the relayer submits, and DelegationManager disables the delegation.",
        pillRevoked: "Revoked",
        pillExpired: "Expired",
        pillNotStarted: "Not started",
        pillActive: "Active",
        loading: "Reading permission state from GIWA",
        readFaultHeading: "Could not read chain state.",
        retry: "Try again",
        statusReadError: "Check the public GIWA RPC response and try again.",
        receiptsReadError:
            "Could not read settlement events. Check the read window or the RPC status.",
    },
    ko: {
        sections: {
            overview: {
                label: "권한",
                title: "위임된 권한",
                description: "체인이 지금 허용하는 범위를 읽습니다.",
            },
            activity: {
                label: "활동",
                title: "정산 기록",
                description: "별도 원장 없이 enforcer 이벤트를 조회합니다.",
            },
            security: {
                label: "회수",
                title: "회수와 보안",
                description: "권한을 끝내는 경로와 현재 준비 상태를 확인합니다.",
            },
        },
        mobileHomeAria: "Mapae 홈",
        refreshAria: "온체인 상태 새로고침",
        myAgents: "내 에이전트",
        landingAria: "Mapae 랜딩으로 이동",
        navAria: "Studio 메뉴",
        createGrant: "권한 만들기",
        aboutMapae: "Mapae 소개",
        techDocs: "기술 문서",
        availableNow: "현재 사용 가능",
        haltRevoked: {
            label: "더 이상 사용 불가",
            note: "이 권한은 온체인에서 회수되었습니다. 아래 한도와 무관하게, 이 권한을 제시하는 결제는 페이어 계정이 거부합니다.",
        },
        haltExpired: {
            label: "더 이상 사용 불가",
            note: "이 권한은 만료되었습니다. 아래 한도와 무관하게, 이 권한을 제시하는 결제는 페이어 계정이 거부합니다.",
        },
        haltNotStarted: {
            label: "아직 사용 불가",
            note: "이 권한은 아직 시작 시각에 도달하지 않았습니다. 그때까지의 결제는 거부됩니다.",
        },
        balanceNote: (cap, balance) =>
            `한도는 ${cap} mUSDC이지만 지불 계정 잔액이 ${balance} mUSDC입니다. 결제하려면 지불 계정에 mUSDC를 채워 주세요.`,
        usageAria: "현재 주기 사용률",
        spentLegend: (amount) => `사용 ${amount} mUSDC`,
        capLegend: (amount) => `한도 ${amount} mUSDC`,
        noCapCaveat: "이 위임에는 주기 한도 caveat이 없습니다.",
        metricsAria: "권한 핵심 정보",
        payerAccount: "지불 계정",
        payerAccountDetail: "자금이 보관된 스마트 계정",
        period: "주기",
        noLimit: "제한 없음",
        currentPeriodDetail: (period) => `현재 #${period} 주기`,
        firstPeriodPending: "아직 첫 주기 시작 전",
        expiry: "만료",
        notSet: "설정 없음",
        alreadyExpired: "이미 만료된 권한",
        chainTime: "체인 시각 기준",
        delegationDepth: "위임 깊이",
        depthValue: (links) => `${links}단`,
        depthIndirect: "중간 링크가 더 좁을 수 있음",
        depthDirect: "직접 위임",
        engravingTitle: "체인이 읽은 각인",
        fullHistory: "전체 이력",
        since: (timestamp) => `${timestamp} 이후`,
        lastBlocks: (blocks) => `최근 ${blocks} 블록`,
        settlementsInWindow: "조회 구간에서 확인된 정산",
        readWindow: "조회 범위",
        readWindowDetail: "GIWA 공개 RPC의 로그 범위 안에서 읽었습니다.",
        onchainActivity: "온체인 활동",
        emptyWindowTitle: "이 조회 구간에는 정산이 없습니다.",
        emptyWindowNote: (fromBlock) =>
            `이는 결제가 한 번도 없었다는 뜻이 아닐 수 있습니다. 현재 창은 블록 ${fromBlock}부터 시작합니다.`,
        periodTotal: (amount) => `주기 누적 ${amount} mUSDC`,
        revokedHeading: "이 권한은 이미 회수되었습니다.",
        expiredHeading: "이 권한은 만료되었습니다.",
        ownerOnlyHeading: "소유자만 권한을 끝낼 수 있습니다.",
        killSwitchBody:
            "소유자 지갑의 EIP-712 서명 한 번으로 이 위임을 온체인에서 비활성화합니다. EntryPoint 예치금은 회수 시점에 스폰서가 대납하므로, 소유자 지갑에 GIWA ETH가 없어도 됩니다.",
        capCheckTitle: "한도 강제",
        capCheckBody:
            "금액과 주기는 backend가 아니라 ERC20PeriodTransferEnforcer가 검사합니다.",
        ownerCheckTitle: "소유자 검증",
        ownerCheckBody: "회수 서명자는 smart account의 실제 owner와 일치해야 합니다.",
        inputCheckTitle: "입력 보존",
        inputCheckBody: "마패 권한 코드는 URL이나 브라우저 저장소에 기록하지 않습니다.",
        revocationPathTitle: "회수 경로",
        revocationSponsoredBody:
            "회수 예치금은 스폰서가 대납합니다. 서명 권한은 소유자 지갑에만 있습니다.",
        revocationLocalBody: "이 로컬 환경에는 회수 제출기가 구성되어 있습니다.",
        revocationAbsentBody: "회수 엔드포인트가 설정되지 않았습니다.",
        stepOwnerTitle: "소유자 지갑 확인",
        stepOwnerBody: "연결 지갑과 smart account owner를 먼저 대조합니다.",
        stepSignTitle: "UserOperation 서명",
        stepSignBody: "현재 nonce와 GIWA chain ID를 넣은 EIP-712 메시지를 서명합니다.",
        stepSubmitTitle: "EntryPoint 제출 · 대납",
        stepSubmitBody:
            "스폰서가 예치금을 채우고 릴레이어가 제출하면 DelegationManager가 해당 위임을 비활성화합니다.",
        pillRevoked: "회수됨",
        pillExpired: "만료됨",
        pillNotStarted: "미개시",
        pillActive: "유효",
        loading: "GIWA에서 권한 상태를 읽고 있습니다",
        readFaultHeading: "체인 상태를 읽지 못했습니다.",
        retry: "다시 시도",
        statusReadError: "공개 GIWA RPC 응답을 확인하고 다시 시도해 주세요.",
        receiptsReadError:
            "정산 이벤트를 읽지 못했습니다. 조회 범위 또는 RPC 상태를 확인해 주세요.",
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
    const {locale} = useLocale();
    const t = COPY[locale];
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
        const grant = importedSessionGrant(permissionContext, locale);
        await verifyPermissionArtifact(grant.artifact, locale);
        addGrant(grant);
    }

    function chooseAnotherPermission() {
        setLoadedRaw("");
        setSection("agents");
    }

    const detailSection: DetailSection =
        section === "overview" || section === "activity" || section === "security"
            ? section
            : "overview";
    const meta = SECTION_META[detailSection];
    const sectionCopy = t.sections[detailSection];

    return (
        <div className="studio-shell">
            <StudioSidebar
                section={section}
                hasPermission={Boolean(permission)}
                onSectionChange={setSection}
            />

            <main className="studio-main">
                <header className="studio-topbar">
                    <a className="studio-mobile-brand" href={landingUrl} aria-label={t.mobileHomeAria}>
                        <span className="studio-mobile-mark">
                            <PassEmblem size={18} />
                        </span>
                        <Wordmark height={14} />
                    </a>
                    <div className="studio-topbar-meta">
                        <LocaleSwitch />
                        <div className="studio-network">
                            <i aria-hidden="true" />
                            <span>{chain.name}</span>
                            <b>{chain.id}</b>
                        </div>
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
                                <h1>{sectionCopy.title}</h1>
                                <p>{sectionCopy.description}</p>
                            </div>
                            <div className="studio-head-actions">
                                <button
                                    type="button"
                                    className="studio-icon-button"
                                    aria-label={t.refreshAria}
                                    title={t.refreshAria}
                                    onClick={() => setRefreshKey((value) => value + 1)}
                                >
                                    <RefreshCw size={17} />
                                </button>
                                <button
                                    type="button"
                                    className="studio-secondary-button"
                                    onClick={chooseAnotherPermission}
                                >
                                    {t.myAgents}
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
    const {locale} = useLocale();
    const t = COPY[locale];
    return (
        <aside className="studio-sidebar">
            <a className="studio-brand" href={landingUrl} aria-label={t.landingAria}>
                <span>
                    <PassEmblem size={27} />
                </span>
                <span className="studio-brand-copy">
                    <Wordmark height={15} />
                    <small>STUDIO</small>
                </span>
            </a>

            <nav className="studio-nav" aria-label={t.navAria}>
                <button
                    type="button"
                    data-active={section === "create"}
                    onClick={() => onSectionChange("create")}
                >
                    <FileKey2 size={18} />
                    <span>{t.createGrant}</span>
                </button>
                <button
                    type="button"
                    data-active={section === "agents"}
                    onClick={() => onSectionChange("agents")}
                >
                    <WalletCards size={18} />
                    <span>{t.myAgents}</span>
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
                                <span>{t.sections[key].label}</span>
                            </button>
                        );
                    })
                ) : null}
            </nav>

            <div className="studio-sidebar-foot">
                <a href={landingUrl}>
                    <ArrowLeft size={15} />
                    <span>{t.aboutMapae}</span>
                </a>
                <a href={docsUrl} target="_blank" rel="noreferrer noopener">
                    <span>{t.techDocs}</span>
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
    const {locale} = useLocale();
    const t = COPY[locale];
    const balance = usePayerBalance(permission.root.delegator as `0x${string}`);
    const live = !status.revoked && !status.expired && !status.notYetActive;
    const started = (status.currentPeriod ?? 0n) > 0n;
    const cap = status.limit?.periodAmount;
    const remaining = cap === undefined ? undefined : started ? status.remaining : cap;
    const available = remaining ?? cap;
    // One verdict, rendered twice — the headline number and the note under it have to agree
    // about which constraint is binding, and computing them separately is how the headline
    // came to read the full cap over a revoked permission.
    const verdict =
        available === undefined ? undefined : judgeSpendable({available, balance, halted: !live});
    const halt = status.revoked
        ? t.haltRevoked
        : status.expired
          ? t.haltExpired
          : status.notYetActive
            ? t.haltNotStarted
            : undefined;
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

                    {verdict !== undefined && available !== undefined && cap !== undefined ? (
                        <>
                            <p className="studio-amount-label">
                                {halt ? halt.label : t.availableNow}
                            </p>
                            <div className="studio-amount" data-halted={!live}>
                                <strong>{fromTokenAmount(verdict.spendable)}</strong>
                                <span>mUSDC</span>
                            </div>
                            {verdict.limitedBy === "halted" && halt ? (
                                // Why the number is zero. Without it the card reads as an
                                // account that ran out of money, which is a different
                                // problem with a different fix.
                                <p className="studio-amount-note">{halt.note}</p>
                            ) : verdict.limitedBy === "balance" ? (
                                // The cap is not the binding constraint right now. Saying
                                // so here is the difference between a user who funds the
                                // account and one who reads an unexplained payment failure.
                                <p className="studio-amount-note">
                                    {t.balanceNote(
                                        fromTokenAmount(available),
                                        fromTokenAmount(balance ?? 0n),
                                    )}
                                </p>
                            ) : null}
                            <div
                                className="studio-cap-track"
                                role="progressbar"
                                aria-label={t.usageAria}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(usedPercent)}
                            >
                                <i style={{width: `${usedPercent}%`}} />
                            </div>
                            <div className="studio-cap-legend">
                                <span>{t.spentLegend(fromTokenAmount(spent))}</span>
                                <span>{t.capLegend(fromTokenAmount(cap))}</span>
                            </div>
                        </>
                    ) : (
                        <div className="studio-no-cap">
                            <CircleGauge size={30} />
                            <p>{t.noCapCaveat}</p>
                        </div>
                    )}
                </div>

                <div className="studio-authority-emblem" aria-hidden="true">
                    <span className="studio-authority-ring" />
                    <span className="studio-authority-disc">
                        <PassEmblem size={104} />
                    </span>
                </div>
            </section>

            <section className="studio-metric-grid" aria-label={t.metricsAria}>
                <Metric
                    icon={WalletCards}
                    label={t.payerAccount}
                    value={short(status.delegator)}
                    detail={t.payerAccountDetail}
                    href={explorerAddressUrl(status.delegator)}
                />
                <Metric
                    icon={Clock3}
                    label={t.period}
                    value={
                        status.limit
                            ? formatDuration(status.limit.periodDuration, locale)
                            : t.noLimit
                    }
                    detail={
                        started
                            ? t.currentPeriodDetail(String(status.currentPeriod))
                            : t.firstPeriodPending
                    }
                />
                <Metric
                    icon={TimerReset}
                    label={t.expiry}
                    value={
                        status.validity?.notAfter
                            ? formatTimestamp(status.validity.notAfter, locale)
                            : t.notSet
                    }
                    detail={status.expired ? t.alreadyExpired : t.chainTime}
                />
                <Metric
                    icon={KeyRound}
                    label={t.delegationDepth}
                    value={t.depthValue(permission.links)}
                    detail={permission.links > 1 ? t.depthIndirect : t.depthDirect}
                />
            </section>

            <section className="studio-detail-card">
                <header>
                    <div>
                        <span className="studio-kicker">AUTHORITY DETAILS</span>
                        <h2>{t.engravingTitle}</h2>
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
                            value={formatTimestamp(status.validity.notBefore, locale)}
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
    const {locale} = useLocale();
    const t = COPY[locale];
    if (receipts.kind === "loading" || receipts.kind === "idle") {
        return <LoadingWorkspace compact />;
    }
    if (receipts.kind === "error") {
        return <ReadFault reason={receipts.reason} />;
    }

    const {receipts: rows, fromBlock, openedAt} = receipts.value;
    const windowLabel =
        fromBlock === 0n
            ? t.fullHistory
            : openedAt
              ? t.since(formatTimestamp(openedAt, locale))
              : t.lastBlocks(String(RECEIPT_LOOKBACK_BLOCKS));

    return (
        <div className="studio-activity-view">
            <section className="studio-activity-summary">
                <div>
                    <span className="studio-kicker">SETTLEMENT RECEIPTS</span>
                    <strong>{rows.length}</strong>
                    <p>{t.settlementsInWindow}</p>
                </div>
                <div>
                    <span>{t.readWindow}</span>
                    <strong>{windowLabel}</strong>
                    <p>{t.readWindowDetail}</p>
                </div>
            </section>

            <section className="studio-receipt-card">
                <header>
                    <h2>{t.onchainActivity}</h2>
                    <span>ERC20PeriodTransferEnforcer</span>
                </header>
                {rows.length === 0 ? (
                    <div className="studio-empty-activity">
                        <Activity size={26} />
                        <h3>{t.emptyWindowTitle}</h3>
                        <p>{t.emptyWindowNote(String(fromBlock))}</p>
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
                                                : t.periodTotal(
                                                      fromTokenAmount(
                                                          receipt.transferredInCurrentPeriod,
                                                      ),
                                                  )}
                                        </strong>
                                        <span>
                                            {formatTimestamp(receipt.transferTimestamp, locale)}
                                        </span>
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
    const {locale} = useLocale();
    const t = COPY[locale];
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
                            ? t.revokedHeading
                            : status.expired
                              ? t.expiredHeading
                              : t.ownerOnlyHeading}
                    </h2>
                    <p>{t.killSwitchBody}</p>
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
                    title={t.capCheckTitle}
                    state="ONCHAIN"
                    body={t.capCheckBody}
                />
                <SecurityCheck
                    icon={Fingerprint}
                    title={t.ownerCheckTitle}
                    state="ERC-1271"
                    body={t.ownerCheckBody}
                />
                <SecurityCheck
                    icon={LockKeyhole}
                    title={t.inputCheckTitle}
                    state="MEMORY ONLY"
                    body={t.inputCheckBody}
                />
                <SecurityCheck
                    icon={RotateCcwKey}
                    title={t.revocationPathTitle}
                    state={
                        sponsored.kind === "configured"
                            ? "SPONSORED"
                            : submitter.kind === "configured"
                              ? "LOCAL READY"
                              : "NOT CONFIGURED"
                    }
                    body={
                        sponsored.kind === "configured"
                            ? t.revocationSponsoredBody
                            : submitter.kind === "configured"
                              ? t.revocationLocalBody
                              : t.revocationAbsentBody
                    }
                />
            </section>

            <section className="studio-security-detail">
                <header>
                    <div>
                        <span className="studio-kicker">REVOCATION PATH</span>
                        <h2>{t.revocationPathTitle}</h2>
                    </div>
                    <span>{permission.links} LINK AUTHORITY</span>
                </header>
                <ol>
                    <li>
                        <span>01</span>
                        <div>
                            <strong>{t.stepOwnerTitle}</strong>
                            <p>{t.stepOwnerBody}</p>
                        </div>
                    </li>
                    <li>
                        <span>02</span>
                        <div>
                            <strong>{t.stepSignTitle}</strong>
                            <p>{t.stepSignBody}</p>
                        </div>
                    </li>
                    <li>
                        <span>03</span>
                        <div>
                            <strong>{t.stepSubmitTitle}</strong>
                            <p>{t.stepSubmitBody}</p>
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
    const {locale} = useLocale();
    const t = COPY[locale];
    const state = status.revoked
        ? {label: t.pillRevoked, tone: "halted"}
        : status.expired
          ? {label: t.pillExpired, tone: "halted"}
          : status.notYetActive
            ? {label: t.pillNotStarted, tone: "waiting"}
            : {label: t.pillActive, tone: "live"};

    return (
        <span className="studio-status-pill" data-tone={state.tone}>
            <i aria-hidden="true" />
            {state.label}
        </span>
    );
}

function LoadingWorkspace({compact = false}: {compact?: boolean}) {
    const {locale} = useLocale();
    return (
        <div className="studio-loading" data-compact={compact}>
            <i />
            <span>{COPY[locale].loading}</span>
        </div>
    );
}

function ReadFault({reason, onRetry}: {reason: string; onRetry?: () => void}) {
    const {locale} = useLocale();
    const t = COPY[locale];
    return (
        <div className="studio-read-fault" role="alert">
            <ShieldOff size={25} />
            <div>
                <h2>{t.readFaultHeading}</h2>
                <p>{reason}</p>
            </div>
            {onRetry ? (
                <button type="button" onClick={onRetry}>
                    {t.retry}
                </button>
            ) : null}
        </div>
    );
}

function useDelegationStatus(
    permission: LoadedPermission | undefined,
    refreshKey: number,
): ReadState<DelegationStatus> {
    const {locale} = useLocale();
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
                        // `locale` is an effect dependency so a language toggle
                        // re-runs the read: the reason lives in state, and a stale
                        // one would keep rendering in the previous language.
                        reason: COPY[locale].statusReadError,
                    });
                }
            });
        return () => {
            current = false;
        };
    }, [permission, refreshKey, locale]);

    return state;
}

function useSettlementReceipts(
    delegationHash: DelegationStatus["delegationHash"] | undefined,
    enabled: boolean,
    refreshKey: number,
): ReadState<ReceiptWindow> {
    const {locale} = useLocale();
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
                        reason: COPY[locale].receiptsReadError,
                    });
                }
            });

        return () => {
            current = false;
        };
    }, [delegationHash, enabled, refreshKey, locale]);

    return state;
}

function formatDuration(seconds: bigint, locale: Locale): string {
    if (seconds <= 0n) return pick(locale, {en: "No limit", ko: "제한 없음"});
    if (seconds % 86_400n === 0n) {
        const days = seconds / 86_400n;
        return pick(locale, {
            en: `${String(days)} ${days === 1n ? "day" : "days"}`,
            ko: `${String(days)}일`,
        });
    }
    if (seconds % 3_600n === 0n) {
        const hours = seconds / 3_600n;
        return pick(locale, {
            en: `${String(hours)} ${hours === 1n ? "hour" : "hours"}`,
            ko: `${String(hours)}시간`,
        });
    }
    if (seconds % 60n === 0n) {
        const minutes = seconds / 60n;
        return pick(locale, {
            en: `${String(minutes)} ${minutes === 1n ? "minute" : "minutes"}`,
            ko: `${String(minutes)}분`,
        });
    }
    return pick(locale, {
        en: `${String(seconds)} ${seconds === 1n ? "second" : "seconds"}`,
        ko: `${String(seconds)}초`,
    });
}

function formatTimestamp(seconds: bigint, locale: Locale): string {
    if (seconds <= 0n || seconds > 8_640_000_000_000n) return "—";
    return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
    }).format(new Date(Number(seconds) * 1000));
}
