import {signRootPeriodPermission, toMapaeOwnerSmartAccount} from "@mapae/delegation/signing";
import {MOCK_USDC, redactUrls} from "@mapae/shared";
import {getAddress, isAddress} from "viem";
import {
    ArrowRight,
    BadgeCheck,
    Bot,
    Check,
    ChevronDown,
    CircleAlert,
    Coins,
    FileKey2,
    KeyRound,
    Link2,
    LockKeyhole,
    ShieldCheck,
    UserRoundCheck,
    Wallet,
} from "lucide-react";
import {useEffect, useMemo, useState, type FormEvent} from "react";
import {
    useAccount,
    useConnect,
    useDisconnect,
    useSwitchChain,
    useWalletClient,
} from "wagmi";
import {bootstrapAvailability, chain, deployment, publicClient} from "../lib/config";
import {
    requestSponsoredBootstrap,
    signedSessionGrant,
    tokenLabel,
    validateGrantDraft,
    verifyPermissionArtifact,
    type GrantDraft,
    type SessionGrant,
} from "../lib/grant";
import {parsePermissionContext, type ParsedPermission} from "../lib/permission";
import {generateAgentSessionKey, type AgentSessionKey} from "../lib/agent-key";
import {short} from "../lib/dial";

type AccountReadiness =
    | {kind: "idle"}
    | {kind: "loading"}
    | {kind: "ready"; smartAccount: `0x${string}`}
    | {kind: "missing"; smartAccount: `0x${string}`}
    | {kind: "error"; reason: string};

type SigningProgress =
    | {kind: "idle"}
    | {kind: "signing"}
    | {kind: "bootstrapping"}
    | {kind: "verifying"}
    | {kind: "error"; reason: string};

// `recipientMode: "any"` is the default on purpose. The natural first payment is
// to the hosted demo seller, whose address a new user has no way to know; a
// fixed-recipient default with an empty field steers them into pinning a wrong
// address, and every payment then dies at the enforcer. Narrowing to one
// recipient stays one click away and the form warns about the open scope.
const INITIAL_DRAFT: GrantDraft = {
    agentName: "",
    delegate: "",
    amount: "",
    periodSeconds: "86400",
    expirySeconds: "2592000",
    recipientMode: "any",
    recipient: "",
};

export function GrantOnboarding({
    onGranted,
    onImported,
}: {
    onGranted: (grant: SessionGrant) => void;
    onImported: (permissionContext: `0x${string}`) => Promise<void>;
}) {
    const [draft, setDraft] = useState<GrantDraft>(INITIAL_DRAFT);
    const [attempted, setAttempted] = useState(false);
    const [progress, setProgress] = useState<SigningProgress>({kind: "idle"});
    const [generatedKey, setGeneratedKey] = useState<AgentSessionKey>();
    const {address, chainId, isConnected} = useAccount();
    const {connect, connectors, isPending: connecting, error: connectError} = useConnect();
    const {disconnect} = useDisconnect();
    const {switchChain, isPending: switching} = useSwitchChain();
    const {data: walletClient} = useWalletClient({chainId: chain.id});
    const [accountReadiness, setAccountReadiness] = useState<AccountReadiness>({
        kind: "idle",
    });
    const validation = useMemo(() => validateGrantDraft(draft), [draft]);
    // Read once: it comes from a build-time constant, and re-deriving it per render would
    // suggest it can change while the page is open.
    const sponsor = useMemo(() => bootstrapAvailability(), []);
    const wrongChain = isConnected && chainId !== chain.id;

    useEffect(() => {
        let current = true;
        if (!address || wrongChain || !walletClient) {
            setAccountReadiness({kind: "idle"});
            return () => {
                current = false;
            };
        }

        setAccountReadiness({kind: "loading"});
        void (async () => {
            try {
                const smartAccount = await toMapaeOwnerSmartAccount({
                    publicClient:
                        publicClient as Parameters<typeof toMapaeOwnerSmartAccount>[0]["publicClient"],
                    walletClient:
                        walletClient as Parameters<typeof toMapaeOwnerSmartAccount>[0]["walletClient"],
                    environment: deployment.environment,
                    accountOwner: address,
                });
                const code = await publicClient.getCode({address: smartAccount.address});
                if (!current) return;
                setAccountReadiness(
                    code && code !== "0x"
                        ? {kind: "ready", smartAccount: smartAccount.address}
                        : {kind: "missing", smartAccount: smartAccount.address},
                );
            } catch (error) {
                if (!current) return;
                setAccountReadiness({kind: "error", reason: faultLine(error)});
            }
        })();

        return () => {
            current = false;
        };
    }, [address, walletClient, wrongChain]);

    function update<K extends keyof GrantDraft>(key: K, value: GrantDraft[K]) {
        setDraft((current) => ({...current, [key]: value}));
        setProgress({kind: "idle"});
        // A hand-edited delegate is no longer the key this tab generated; keeping the
        // key around would export a bundle whose address and grant disagree. Compare
        // the normalized address, not the raw string — validation accepts any casing
        // of the same address, and an edit-then-undo or lowercase re-paste of the
        // generated address must not destroy the only copy of the key.
        if (key === "delegate" && generatedKey) {
            const raw = typeof value === "string" ? value.trim() : "";
            const sameAddress = isAddress(raw) && getAddress(raw) === generatedKey.address;
            if (!sameAddress) setGeneratedKey(undefined);
        }
    }

    function createAgentKey() {
        const key = generateAgentSessionKey();
        setGeneratedKey(key);
        setDraft((current) => ({...current, delegate: key.address}));
        setProgress({kind: "idle"});
    }

    async function signGrant(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setAttempted(true);
        // Readiness no longer gates signing. The signature is what proves ownership to
        // the sponsor, so it must come first; `DelegationManager` still requires the
        // account to exist before any payment, which is why the sponsor runs immediately
        // after. Only an unreadable account state blocks — signing against an address we
        // could not derive would produce a grant nobody can place.
        if (
            validation.kind !== "ok" ||
            !address ||
            !walletClient ||
            accountReadiness.kind === "loading" ||
            accountReadiness.kind === "error" ||
            (accountReadiness.kind === "missing" && sponsor.kind !== "configured")
        ) {
            return;
        }

        try {
            setProgress({kind: "signing"});
            const head = await publicClient.getBlock();
            const startDate = Math.max(0, Number(head.timestamp) - 1);
            const artifact = await signRootPeriodPermission({
                publicClient:
                    publicClient as Parameters<typeof signRootPeriodPermission>[0]["publicClient"],
                walletClient:
                    walletClient as Parameters<typeof signRootPeriodPermission>[0]["walletClient"],
                environment: deployment.environment,
                accountOwner: address,
                delegate: validation.value.delegate,
                policy: {
                    role: validation.value.recipient ? "vendor-agent" : "open-agent",
                    token: MOCK_USDC.address,
                    periodAmount: validation.value.periodAmount,
                    periodDurationSeconds: validation.value.periodDurationSeconds,
                    expiresAfterSeconds: validation.value.expiresAfterSeconds,
                    recipient: validation.value.recipient,
                },
                startDate,
            });
            if (accountReadiness.kind === "missing" && sponsor.kind === "configured") {
                setProgress({kind: "bootstrapping"});
                await requestSponsoredBootstrap(sponsor.url, artifact);
                setAccountReadiness({kind: "ready", smartAccount: artifact.delegator});
            }
            setProgress({kind: "verifying"});
            await verifyPermissionArtifact(artifact);
            const agentKey =
                generatedKey && generatedKey.address === validation.value.delegate
                    ? generatedKey
                    : undefined;
            setDraft(INITIAL_DRAFT);
            setAttempted(false);
            // Clear only the key this submission consumed — a key generated while the
            // wallet prompt was open belongs to the next grant, not to the void.
            setGeneratedKey((current) => (current === agentKey ? undefined : current));
            setProgress({kind: "idle"});
            onGranted(signedSessionGrant(artifact, validation.value, agentKey));
        } catch (error) {
            setProgress({kind: "error", reason: faultLine(error)});
        }
    }

    const connector = connectors[0];
    const busy =
        progress.kind === "signing" ||
        progress.kind === "bootstrapping" ||
        progress.kind === "verifying";
    const formReady =
        validation.kind === "ok" &&
        (accountReadiness.kind === "ready" ||
            (accountReadiness.kind === "missing" && sponsor.kind === "configured")) &&
        !busy;

    return (
        <div className="studio-create-page">
            <header className="studio-create-head">
                <div>
                    <span className="studio-kicker">CREATE AUTHORITY</span>
                    <h1>
                        에이전트가 쓸 수 있는
                        <strong>경계를 먼저 정하세요.</strong>
                    </h1>
                    <p>
                        자산·금액·기간·수취인을 확인한 뒤 지갑에서 한 번 서명합니다.
                        생성된 권한 코드는 Studio가 바로 연결하고 에이전트 목록에
                        추가합니다.
                    </p>
                </div>
                <WalletState
                    address={address}
                    chainId={chainId}
                    connecting={connecting}
                    switching={switching}
                    connectorName={connector?.name}
                    connectError={connectError ? faultLine(connectError) : undefined}
                    onConnect={() => {
                        if (connector) connect({connector});
                    }}
                    onSwitch={() => switchChain({chainId: chain.id})}
                    onDisconnect={() => disconnect()}
                />
            </header>

            <div className="studio-create-layout">
                <form className="studio-grant-form" onSubmit={(event) => void signGrant(event)}>
                    <div className="studio-form-section">
                        <FormSectionHead
                            index="01"
                            icon={Bot}
                            title="어떤 에이전트에게 맡길까요?"
                            description="이름은 Studio에서만 식별용으로 쓰고, 주소가 실제 권한 수신자입니다."
                        />
                        <div className="studio-form-grid">
                            <Field
                                label="에이전트 이름"
                                htmlFor="grant-agent-name"
                                error={fieldError(validation, attempted, "agentName")}
                            >
                                <input
                                    id="grant-agent-name"
                                    value={draft.agentName}
                                    maxLength={40}
                                    placeholder="예: Invoice agent"
                                    onChange={(event) => update("agentName", event.target.value)}
                                />
                            </Field>
                            <Field
                                label="에이전트 지갑 주소"
                                htmlFor="grant-delegate"
                                error={fieldError(validation, attempted, "delegate")}
                            >
                                <div className="studio-delegate-row">
                                    <input
                                        id="grant-delegate"
                                        value={draft.delegate}
                                        spellCheck={false}
                                        autoComplete="off"
                                        placeholder="0x… 또는 오른쪽 버튼으로 새로 생성"
                                        onChange={(event) =>
                                            update("delegate", event.target.value)
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="studio-keygen-button"
                                        disabled={busy}
                                        onClick={createAgentKey}
                                    >
                                        <KeyRound size={14} />
                                        새 에이전트 키
                                    </button>
                                </div>
                                {generatedKey ? (
                                    <small className="studio-keygen-note">
                                        이 브라우저에서 방금 만든 키입니다. 서버로 전송되지
                                        않으며, 서명 후 &lsquo;내 에이전트&rsquo;의 MCP 연결
                                        번들로만 받을 수 있습니다.
                                    </small>
                                ) : null}
                            </Field>
                        </div>
                    </div>

                    <div className="studio-form-section">
                        <FormSectionHead
                            index="02"
                            icon={Coins}
                            title="얼마나, 얼마나 자주 쓸 수 있나요?"
                            description="한 번의 숫자가 아니라 매 주기마다 다시 열리는 총한도입니다."
                        />
                        <div className="studio-form-grid studio-form-grid-three">
                            <Field label="자산" htmlFor="grant-asset">
                                <div className="studio-select-wrap">
                                    <select id="grant-asset" value="musdc" disabled>
                                        <option value="musdc">{tokenLabel()}</option>
                                    </select>
                                    <ChevronDown size={15} />
                                </div>
                            </Field>
                            <Field
                                label="주기 한도"
                                htmlFor="grant-amount"
                                error={fieldError(validation, attempted, "amount")}
                            >
                                <div className="studio-input-suffix">
                                    <input
                                        id="grant-amount"
                                        inputMode="decimal"
                                        value={draft.amount}
                                        placeholder="25"
                                        onChange={(event) => update("amount", event.target.value)}
                                    />
                                    <span>mUSDC</span>
                                </div>
                            </Field>
                            <Field
                                label="결제 주기"
                                htmlFor="grant-period"
                                error={fieldError(validation, attempted, "periodSeconds")}
                            >
                                <div className="studio-select-wrap">
                                    <select
                                        id="grant-period"
                                        value={draft.periodSeconds}
                                        onChange={(event) =>
                                            update("periodSeconds", event.target.value)
                                        }
                                    >
                                        <option value="3600">매시간</option>
                                        <option value="86400">매일</option>
                                        <option value="604800">매주</option>
                                        <option value="2592000">매 30일</option>
                                    </select>
                                    <ChevronDown size={15} />
                                </div>
                            </Field>
                        </div>
                    </div>

                    <div className="studio-form-section">
                        <FormSectionHead
                            index="03"
                            icon={UserRoundCheck}
                            title="누구에게, 언제까지 지불할 수 있나요?"
                            description="특정 수취인을 고정하면 다른 주소로 향하는 결제는 체인이 거절합니다."
                        />
                        <div className="studio-segmented" aria-label="수취인 범위">
                            <button
                                type="button"
                                data-active={draft.recipientMode === "fixed"}
                                onClick={() => update("recipientMode", "fixed")}
                            >
                                특정 수취인만
                            </button>
                            <button
                                type="button"
                                data-active={draft.recipientMode === "any"}
                                onClick={() => update("recipientMode", "any")}
                            >
                                모든 수취인
                            </button>
                        </div>
                        <div className="studio-form-grid">
                            {draft.recipientMode === "fixed" ? (
                                <Field
                                    label="허용 수취인 주소"
                                    htmlFor="grant-recipient"
                                    error={fieldError(validation, attempted, "recipient")}
                                >
                                    <input
                                        id="grant-recipient"
                                        value={draft.recipient}
                                        spellCheck={false}
                                        autoComplete="off"
                                        placeholder="0x…"
                                        onChange={(event) =>
                                            update("recipient", event.target.value)
                                        }
                                    />
                                </Field>
                            ) : (
                                <div className="studio-any-recipient">
                                    <CircleAlert size={17} />
                                    <span>
                                        에이전트가 어떤 주소로든 결제할 수 있습니다. 필요한
                                        경우에만 선택하세요.
                                    </span>
                                </div>
                            )}
                            <Field
                                label="권한 유효 기간"
                                htmlFor="grant-expiry"
                                error={fieldError(validation, attempted, "expirySeconds")}
                            >
                                <div className="studio-select-wrap">
                                    <select
                                        id="grant-expiry"
                                        value={draft.expirySeconds}
                                        onChange={(event) =>
                                            update("expirySeconds", event.target.value)
                                        }
                                    >
                                        <option value="86400">1일</option>
                                        <option value="604800">7일</option>
                                        <option value="2592000">30일</option>
                                        <option value="7776000">90일</option>
                                    </select>
                                    <ChevronDown size={15} />
                                </div>
                            </Field>
                        </div>
                    </div>

                    <AccountGate state={accountReadiness} sponsor={sponsor} />

                    {progress.kind === "error" ? (
                        <div className="studio-sign-error" role="alert">
                            <CircleAlert size={17} />
                            <span>{progress.reason}</span>
                        </div>
                    ) : null}

                    <button type="submit" className="studio-primary-button" disabled={!formReady}>
                        {progress.kind === "signing"
                            ? "지갑에서 서명해 주세요…"
                            : progress.kind === "bootstrapping"
                              ? "지불 계정을 준비하는 중…"
                              : progress.kind === "verifying"
                                ? "온체인 서명 확인 중…"
                                : !isConnected
                                  ? "먼저 지갑을 연결하세요"
                                  : wrongChain
                                    ? "GIWA Sepolia로 전환하세요"
                                    : "범위 확인하고 권한 만들기"}
                        {progress.kind === "idle" ? <ArrowRight size={17} /> : null}
                    </button>
                    <p className="studio-privacy">
                        <LockKeyhole size={15} />
                        이 단계는 토큰을 전송하지 않습니다. 서명은 표시된 범위의 위임
                        권한만 만들며, 실제 결제 때 체인이 다시 검사합니다.
                    </p>
                </form>

                <GrantPreview draft={draft} validation={validation} />
            </div>

            <ManualPermissionImport onImported={onImported} />
        </div>
    );
}

function WalletState({
    address,
    chainId,
    connecting,
    switching,
    connectorName,
    connectError,
    onConnect,
    onSwitch,
    onDisconnect,
}: {
    address?: `0x${string}`;
    chainId?: number;
    connecting: boolean;
    switching: boolean;
    connectorName?: string;
    connectError?: string;
    onConnect: () => void;
    onSwitch: () => void;
    onDisconnect: () => void;
}) {
    if (!address) {
        return (
            <div className="studio-wallet-block">
                <button
                    type="button"
                    className="studio-wallet-button"
                    disabled={connecting}
                    onClick={onConnect}
                >
                    <Wallet size={17} />
                    {connecting ? "지갑 연결 중…" : "지갑 연결"}
                </button>
                <small>{connectError ?? `${connectorName ?? "브라우저 지갑"} 사용`}</small>
            </div>
        );
    }
    if (chainId !== chain.id) {
        return (
            <div className="studio-wallet-block" data-tone="warning">
                <button
                    type="button"
                    className="studio-wallet-button"
                    disabled={switching}
                    onClick={onSwitch}
                >
                    <CircleAlert size={17} />
                    {switching ? "네트워크 전환 중…" : "GIWA Sepolia로 전환"}
                </button>
                <small>현재 네트워크에서는 서명하지 않습니다.</small>
            </div>
        );
    }
    return (
        <div className="studio-wallet-connected">
            <span>
                <i />
                {short(address)}
            </span>
            <button type="button" onClick={onDisconnect}>
                연결 해제
            </button>
        </div>
    );
}

function FormSectionHead({
    index,
    icon: Icon,
    title,
    description,
}: {
    index: string;
    icon: typeof Bot;
    title: string;
    description: string;
}) {
    return (
        <header className="studio-form-section-head">
            <span>{index}</span>
            <i aria-hidden="true">
                <Icon size={18} />
            </i>
            <div>
                <h2>{title}</h2>
                <p>{description}</p>
            </div>
        </header>
    );
}

function Field({
    label,
    htmlFor,
    error,
    children,
}: {
    label: string;
    htmlFor: string;
    error?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="studio-field" htmlFor={htmlFor} data-invalid={Boolean(error)}>
            <span>{label}</span>
            {children}
            {error ? <small>{error}</small> : null}
        </label>
    );
}

function AccountGate({
    state,
    sponsor,
}: {
    state: AccountReadiness;
    sponsor: ReturnType<typeof bootstrapAvailability>;
}) {
    if (state.kind === "idle") {
        return (
            <div className="studio-account-gate">
                <Wallet size={18} />
                <div>
                    <strong>소유자 지갑을 연결해 주세요.</strong>
                    <p>연결 후 사용할 지불 계정이 GIWA에 준비되어 있는지 확인합니다.</p>
                </div>
            </div>
        );
    }
    if (state.kind === "loading") {
        return (
            <div className="studio-account-gate">
                <i className="studio-mini-spinner" />
                <div>
                    <strong>지불 계정 확인 중</strong>
                    <p>서명 전에 배포 상태를 GIWA에서 읽고 있습니다.</p>
                </div>
            </div>
        );
    }
    if (state.kind === "missing") {
        // Two different situations wear the same chain state. With a sponsor configured
        // this is a normal first visit and costs the user nothing; without one there is
        // no path forward from the browser, and saying so is more useful than a spinner.
        if (sponsor.kind === "configured") {
            return (
                <div className="studio-account-gate" data-tone="ready">
                    <BadgeCheck size={18} />
                    <div>
                        <strong>첫 권한과 함께 지불 계정이 준비됩니다.</strong>
                        <p>
                            지불 계정 {short(state.smartAccount)}은 아직 만들어지지
                            않았습니다. 권한에 서명하면 계정 생성 수수료는 Mapae가
                            대신 냅니다. 지갑에서 승인할 것은 서명 한 번뿐입니다.
                        </p>
                    </div>
                </div>
            );
        }
        return (
            <div className="studio-account-gate" data-tone="warning">
                <CircleAlert size={18} />
                <div>
                    <strong>지불 계정 준비가 필요합니다.</strong>
                    <p>
                        예상 계정 {short(state.smartAccount)}이 아직 배포되지 않았습니다.
                        이 환경에는 계정 준비 서버가 설정되어 있지 않아 권한 서명을
                        진행할 수 없습니다.
                    </p>
                </div>
            </div>
        );
    }
    if (state.kind === "error") {
        return (
            <div className="studio-account-gate" data-tone="warning">
                <CircleAlert size={18} />
                <div>
                    <strong>지불 계정을 확인하지 못했습니다.</strong>
                    <p>{state.reason}</p>
                </div>
            </div>
        );
    }
    return (
        <div className="studio-account-gate" data-tone="ready">
            <BadgeCheck size={18} />
            <div>
                <strong>지불 계정 준비 완료</strong>
                <p>{short(state.smartAccount)} · 서명 후 ERC-1271 검증까지 진행합니다.</p>
            </div>
        </div>
    );
}

function GrantPreview({
    draft,
    validation,
}: {
    draft: GrantDraft;
    validation: ReturnType<typeof validateGrantDraft>;
}) {
    const amount = draft.amount.trim() || "—";
    const recipient =
        draft.recipientMode === "fixed"
            ? draft.recipient.trim()
                ? short(draft.recipient)
                : "미지정"
            : "모든 수취인";
    return (
        <aside className="studio-grant-preview">
            <div className="studio-preview-orbit" aria-hidden="true">
                <span />
                <ShieldCheck size={35} />
            </div>
            <span className="studio-kicker">SIGNING PREVIEW</span>
            <h2>{draft.agentName.trim() || "새 에이전트 권한"}</h2>
            <p>지갑에는 아래 범위를 한 번에 확인할 수 있는 위임 서명이 표시됩니다.</p>
            <dl>
                <div>
                    <dt>자산</dt>
                    <dd>{MOCK_USDC.symbol}</dd>
                </div>
                <div>
                    <dt>주기 한도</dt>
                    <dd>{amount === "—" ? amount : `${amount} mUSDC`}</dd>
                </div>
                <div>
                    <dt>주기</dt>
                    <dd>{durationLabel(Number(draft.periodSeconds))}</dd>
                </div>
                <div>
                    <dt>수취인</dt>
                    <dd>{recipient}</dd>
                </div>
                <div>
                    <dt>유효 기간</dt>
                    <dd>{durationLabel(Number(draft.expirySeconds))}</dd>
                </div>
            </dl>
            <div className="studio-preview-check">
                {validation.kind === "ok" ? <Check size={16} /> : <Link2 size={16} />}
                <span>
                    {validation.kind === "ok"
                        ? "입력한 경계가 서명 가능한 상태입니다."
                        : "모든 필드를 채우면 최종 경계를 확인합니다."}
                </span>
            </div>
        </aside>
    );
}

function ManualPermissionImport({
    onImported,
}: {
    onImported: (permissionContext: `0x${string}`) => Promise<void>;
}) {
    const [draft, setDraft] = useState("");
    const [progress, setProgress] = useState<"idle" | "verifying">("idle");
    const [fault, setFault] = useState<string>();
    const parsed: ParsedPermission = useMemo(() => parsePermissionContext(draft), [draft]);

    return (
        <details className="studio-manual-import">
            <summary>
                <span>
                    <FileKey2 size={17} />
                    기존 권한 코드가 있나요?
                </span>
                <small>고급 복구</small>
            </summary>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (parsed.kind !== "ok") return;
                    setProgress("verifying");
                    setFault(undefined);
                    void onImported(parsed.context)
                        .catch((error: unknown) => {
                            setProgress("idle");
                            setFault(faultLine(error));
                        });
                }}
            >
                <div>
                    <h2>기존 마패 권한 코드 불러오기</h2>
                    <p>
                        다른 도구에서 이미 승인한 경우에만 사용하세요. 새 권한은 위의
                        범위 설정 화면에서 만드는 편이 안전합니다.
                    </p>
                </div>
                <textarea
                    value={draft}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="0x로 시작하는 전체 권한 코드"
                    onChange={(event) => setDraft(event.target.value)}
                />
                {parsed.kind === "invalid" || fault ? (
                    <p className="studio-import-error">
                        {parsed.kind === "invalid" ? parsed.reason : fault}
                    </p>
                ) : null}
                <button
                    type="submit"
                    className="studio-secondary-button"
                    disabled={parsed.kind !== "ok" || progress === "verifying"}
                >
                    {progress === "verifying"
                        ? "온체인 서명 확인 중…"
                        : "코드 확인하고 불러오기"}
                </button>
            </form>
        </details>
    );
}

function fieldError(
    state: ReturnType<typeof validateGrantDraft>,
    attempted: boolean,
    field: keyof GrantDraft,
): string | undefined {
    return attempted && state.kind === "invalid" && state.field === field
        ? state.reason
        : undefined;
}

function durationLabel(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "—";
    if (seconds % 2_592_000 === 0) return `${seconds / 2_592_000}개월`;
    if (seconds % 604_800 === 0) return `${seconds / 604_800}주`;
    if (seconds % 86_400 === 0) return `${seconds / 86_400}일`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600}시간`;
    return `${seconds}초`;
}

/**
 * The one message an error is allowed to become on screen.
 *
 * `redactUrls` is not optional here. viem embeds the whole transport URL in every error it
 * raises, a private GIWA endpoint carries its API key in the URL *path*, and this string is
 * rendered straight into the DOM. `bun run check:logging` only inspects `console.*`, so a
 * response body or a JSX expression is a sink no gate would catch — which is exactly the
 * edge CLAUDE.md flags as "still on you".
 */
function faultLine(error: unknown): string {
    if (error instanceof Error && error.message) return redactUrls(error.message);
    return "요청을 완료하지 못했습니다. 지갑과 네트워크 상태를 확인해 주세요.";
}
