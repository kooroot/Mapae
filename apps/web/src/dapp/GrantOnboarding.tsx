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
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";

const COPY: Record<
    Locale,
    {
        headTitleLead: string;
        headTitleStrong: string;
        headIntro: string;
        s1Title: string;
        s1Desc: string;
        agentNameLabel: string;
        agentNamePlaceholder: string;
        delegateLabel: string;
        newAgentKey: string;
        keygenNote: string;
        s2Title: string;
        s2Desc: string;
        assetLabel: string;
        periodCapLabel: string;
        paymentPeriodLabel: string;
        periodHourly: string;
        periodDaily: string;
        periodWeekly: string;
        period30Days: string;
        s3Title: string;
        s3Desc: string;
        recipientScopeAria: string;
        fixedRecipientOnly: string;
        anyRecipient: string;
        allowedRecipientLabel: string;
        anyRecipientWarning: string;
        expiryLabel: string;
        expiry1Day: string;
        expiry7Days: string;
        expiry30Days: string;
        expiry90Days: string;
        submitSigning: string;
        submitBootstrapping: string;
        verifyingOnChain: string;
        submitConnectFirst: string;
        submitSwitchChain: string;
        submitCreate: string;
        privacyNote: string;
        walletConnecting: string;
        walletConnect: string;
        walletBrowserFallback: string;
        walletUsing: (name: string) => string;
        walletSwitching: string;
        walletSwitch: string;
        walletNoSignHere: string;
        walletDisconnect: string;
        gateIdleTitle: string;
        gateIdleBody: string;
        gateLoadingTitle: string;
        gateLoadingBody: string;
        gateSponsoredTitle: string;
        gateSponsoredBody: (account: string) => string;
        gateMissingTitle: string;
        gateMissingBody: (account: string) => string;
        gateErrorTitle: string;
        gateReadyTitle: string;
        gateReadyBody: (account: string) => string;
        previewUnset: string;
        previewFallbackName: string;
        previewIntro: string;
        previewAsset: string;
        previewPeriodCap: string;
        previewPeriod: string;
        previewRecipient: string;
        previewValidity: string;
        previewReady: string;
        previewIncomplete: string;
        importSummary: string;
        importBadge: string;
        importTitle: string;
        importBody: string;
        importPlaceholder: string;
        importSubmit: string;
        faultFallback: string;
    }
> = {
    en: {
        headTitleLead: "Before the agent can spend, ",
        headTitleStrong: "set the boundaries.",
        headIntro:
            "Review the asset, amount, period, and recipient, then sign once in your wallet. Studio connects the resulting permission code right away and adds it to your agent list.",
        s1Title: "Which agent are you delegating to?",
        s1Desc:
            "The name identifies the agent in Studio only; the address is the actual recipient of the permission.",
        agentNameLabel: "Agent name",
        agentNamePlaceholder: "e.g. Invoice agent",
        delegateLabel: "Agent wallet address",
        newAgentKey: "New agent key",
        keygenNote:
            "This key was just generated in this browser. It is never sent to a server; after signing, it is available only as the MCP connection bundle in ‘My agents’.",
        s2Title: "How much, and how often?",
        s2Desc: "Not a one-time amount — a total limit that reopens every period.",
        assetLabel: "Asset",
        periodCapLabel: "Period cap",
        paymentPeriodLabel: "Payment period",
        periodHourly: "Every hour",
        periodDaily: "Every day",
        periodWeekly: "Every week",
        period30Days: "Every 30 days",
        s3Title: "Who can be paid, and until when?",
        s3Desc: "Fix a specific recipient and the chain refuses payments toward any other address.",
        recipientScopeAria: "Recipient scope",
        fixedRecipientOnly: "Fixed recipient only",
        anyRecipient: "Any recipient",
        allowedRecipientLabel: "Allowed recipient address",
        anyRecipientWarning: "The agent can pay any address. Choose this only when you need it.",
        expiryLabel: "Permission validity",
        expiry1Day: "1 day",
        expiry7Days: "7 days",
        expiry30Days: "30 days",
        expiry90Days: "90 days",
        submitSigning: "Sign in your wallet…",
        submitBootstrapping: "Preparing the payer account…",
        verifyingOnChain: "Verifying the signature on-chain…",
        submitConnectFirst: "Connect a wallet first",
        submitSwitchChain: "Switch to GIWA Sepolia",
        submitCreate: "Confirm the scope and create the permission",
        privacyNote:
            "This step transfers no tokens. The signature only creates delegated authority within the scope shown, and the chain checks it again at every actual payment.",
        walletConnecting: "Connecting wallet…",
        walletConnect: "Connect wallet",
        walletBrowserFallback: "browser wallet",
        walletUsing: (name) => `Using ${name}`,
        walletSwitching: "Switching network…",
        walletSwitch: "Switch to GIWA Sepolia",
        walletNoSignHere: "Nothing is signed on the current network.",
        walletDisconnect: "Disconnect",
        gateIdleTitle: "Connect the owner wallet.",
        gateIdleBody:
            "After you connect, Studio checks whether the payer account it will use is ready on GIWA.",
        gateLoadingTitle: "Checking the payer account",
        gateLoadingBody: "Reading its deployment state from GIWA before you sign.",
        gateSponsoredTitle: "The payer account is created together with your first permission.",
        gateSponsoredBody: (account) =>
            `Payer account ${account} does not exist yet. Sign the permission and Mapae covers the account creation fee. The only thing your wallet approves is a single signature.`,
        gateMissingTitle: "The payer account needs to be set up.",
        gateMissingBody: (account) =>
            `The expected account ${account} is not deployed yet. No account setup service is configured in this environment, so the permission cannot be signed.`,
        gateErrorTitle: "Could not check the payer account.",
        gateReadyTitle: "Payer account ready",
        gateReadyBody: (account) => `${account} · ERC-1271 verification runs after signing.`,
        previewUnset: "Not set",
        previewFallbackName: "New agent permission",
        previewIntro: "Your wallet shows one delegation signature covering the entire scope below.",
        previewAsset: "Asset",
        previewPeriodCap: "Period cap",
        previewPeriod: "Period",
        previewRecipient: "Recipient",
        previewValidity: "Validity",
        previewReady: "The boundaries you entered are ready to sign.",
        previewIncomplete: "Fill in every field to review the final boundaries.",
        importSummary: "Already have a permission code?",
        importBadge: "Advanced recovery",
        importTitle: "Import an existing Mapae permission code",
        importBody:
            "Use this only if you already approved in another tool. A new permission is safer to create in the scope form above.",
        importPlaceholder: "The full permission code, starting with 0x",
        importSubmit: "Verify the code and import",
        faultFallback: "The request could not be completed. Check your wallet and network connection.",
    },
    ko: {
        headTitleLead: "에이전트가 쓸 수 있는 ",
        headTitleStrong: "경계를 먼저 정하세요.",
        headIntro:
            "자산·금액·기간·수취인을 확인한 뒤 지갑에서 한 번 서명합니다. 생성된 권한 코드는 Studio가 바로 연결하고 에이전트 목록에 추가합니다.",
        s1Title: "어떤 에이전트에게 맡길까요?",
        s1Desc: "이름은 Studio에서만 식별용으로 쓰고, 주소가 실제 권한 수신자입니다.",
        agentNameLabel: "에이전트 이름",
        agentNamePlaceholder: "예: Invoice agent",
        delegateLabel: "에이전트 지갑 주소",
        newAgentKey: "새 에이전트 키",
        keygenNote:
            "이 브라우저에서 방금 만든 키입니다. 서버로 전송되지 않으며, 서명 후 ‘내 에이전트’의 MCP 연결 번들로만 받을 수 있습니다.",
        s2Title: "얼마나, 얼마나 자주 쓸 수 있나요?",
        s2Desc: "한 번의 숫자가 아니라 매 주기마다 다시 열리는 총한도입니다.",
        assetLabel: "자산",
        periodCapLabel: "주기 한도",
        paymentPeriodLabel: "결제 주기",
        periodHourly: "매시간",
        periodDaily: "매일",
        periodWeekly: "매주",
        period30Days: "매 30일",
        s3Title: "누구에게, 언제까지 지불할 수 있나요?",
        s3Desc: "특정 수취인을 고정하면 다른 주소로 향하는 결제는 체인이 거절합니다.",
        recipientScopeAria: "수취인 범위",
        fixedRecipientOnly: "특정 수취인만",
        anyRecipient: "모든 수취인",
        allowedRecipientLabel: "허용 수취인 주소",
        anyRecipientWarning: "에이전트가 어떤 주소로든 결제할 수 있습니다. 필요한 경우에만 선택하세요.",
        expiryLabel: "권한 유효 기간",
        expiry1Day: "1일",
        expiry7Days: "7일",
        expiry30Days: "30일",
        expiry90Days: "90일",
        submitSigning: "지갑에서 서명해 주세요…",
        submitBootstrapping: "지불 계정을 준비하는 중…",
        verifyingOnChain: "온체인 서명 확인 중…",
        submitConnectFirst: "먼저 지갑을 연결하세요",
        submitSwitchChain: "GIWA Sepolia로 전환하세요",
        submitCreate: "범위 확인하고 권한 만들기",
        privacyNote:
            "이 단계는 토큰을 전송하지 않습니다. 서명은 표시된 범위의 위임 권한만 만들며, 실제 결제 때 체인이 다시 검사합니다.",
        walletConnecting: "지갑 연결 중…",
        walletConnect: "지갑 연결",
        walletBrowserFallback: "브라우저 지갑",
        walletUsing: (name) => `${name} 사용`,
        walletSwitching: "네트워크 전환 중…",
        walletSwitch: "GIWA Sepolia로 전환",
        walletNoSignHere: "현재 네트워크에서는 서명하지 않습니다.",
        walletDisconnect: "연결 해제",
        gateIdleTitle: "소유자 지갑을 연결해 주세요.",
        gateIdleBody: "연결 후 사용할 지불 계정이 GIWA에 준비되어 있는지 확인합니다.",
        gateLoadingTitle: "지불 계정 확인 중",
        gateLoadingBody: "서명 전에 배포 상태를 GIWA에서 읽고 있습니다.",
        gateSponsoredTitle: "첫 권한과 함께 지불 계정이 준비됩니다.",
        gateSponsoredBody: (account) =>
            `지불 계정 ${account}은 아직 만들어지지 않았습니다. 권한에 서명하면 계정 생성 수수료는 Mapae가 대신 냅니다. 지갑에서 승인할 것은 서명 한 번뿐입니다.`,
        gateMissingTitle: "지불 계정 준비가 필요합니다.",
        gateMissingBody: (account) =>
            `예상 계정 ${account}이 아직 배포되지 않았습니다. 이 환경에는 계정 준비 서버가 설정되어 있지 않아 권한 서명을 진행할 수 없습니다.`,
        gateErrorTitle: "지불 계정을 확인하지 못했습니다.",
        gateReadyTitle: "지불 계정 준비 완료",
        gateReadyBody: (account) => `${account} · 서명 후 ERC-1271 검증까지 진행합니다.`,
        previewUnset: "미지정",
        previewFallbackName: "새 에이전트 권한",
        previewIntro: "지갑에는 아래 범위를 한 번에 확인할 수 있는 위임 서명이 표시됩니다.",
        previewAsset: "자산",
        previewPeriodCap: "주기 한도",
        previewPeriod: "주기",
        previewRecipient: "수취인",
        previewValidity: "유효 기간",
        previewReady: "입력한 경계가 서명 가능한 상태입니다.",
        previewIncomplete: "모든 필드를 채우면 최종 경계를 확인합니다.",
        importSummary: "기존 권한 코드가 있나요?",
        importBadge: "고급 복구",
        importTitle: "기존 마패 권한 코드 불러오기",
        importBody:
            "다른 도구에서 이미 승인한 경우에만 사용하세요. 새 권한은 위의 범위 설정 화면에서 만드는 편이 안전합니다.",
        importPlaceholder: "0x로 시작하는 전체 권한 코드",
        importSubmit: "코드 확인하고 불러오기",
        faultFallback: "요청을 완료하지 못했습니다. 지갑과 네트워크 상태를 확인해 주세요.",
    },
};

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
    const {locale} = useLocale();
    const t = COPY[locale];
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
    const validation = useMemo(() => validateGrantDraft(draft, locale), [draft, locale]);
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
                setAccountReadiness({kind: "error", reason: faultLine(error, locale)});
            }
        })();

        return () => {
            current = false;
        };
    }, [address, locale, walletClient, wrongChain]);

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
                await requestSponsoredBootstrap(sponsor.url, artifact, locale);
                setAccountReadiness({kind: "ready", smartAccount: artifact.delegator});
            }
            setProgress({kind: "verifying"});
            await verifyPermissionArtifact(artifact, locale);
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
            setProgress({kind: "error", reason: faultLine(error, locale)});
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
                        {t.headTitleLead}
                        <strong>{t.headTitleStrong}</strong>
                    </h1>
                    <p>{t.headIntro}</p>
                </div>
                <WalletState
                    address={address}
                    chainId={chainId}
                    connecting={connecting}
                    switching={switching}
                    connectorName={connector?.name}
                    connectError={connectError ? faultLine(connectError, locale) : undefined}
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
                            title={t.s1Title}
                            description={t.s1Desc}
                        />
                        <div className="studio-form-grid">
                            <Field
                                label={t.agentNameLabel}
                                htmlFor="grant-agent-name"
                                error={fieldError(validation, attempted, "agentName")}
                            >
                                <input
                                    id="grant-agent-name"
                                    value={draft.agentName}
                                    maxLength={40}
                                    placeholder={t.agentNamePlaceholder}
                                    onChange={(event) => update("agentName", event.target.value)}
                                />
                            </Field>
                            <Field
                                label={t.delegateLabel}
                                htmlFor="grant-delegate"
                                error={fieldError(validation, attempted, "delegate")}
                            >
                                <div className="studio-delegate-row">
                                    <input
                                        id="grant-delegate"
                                        value={draft.delegate}
                                        spellCheck={false}
                                        autoComplete="off"
                                        placeholder="0x…"
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
                                        {t.newAgentKey}
                                    </button>
                                </div>
                                {generatedKey ? (
                                    <small className="studio-keygen-note">{t.keygenNote}</small>
                                ) : null}
                            </Field>
                        </div>
                    </div>

                    <div className="studio-form-section">
                        <FormSectionHead
                            index="02"
                            icon={Coins}
                            title={t.s2Title}
                            description={t.s2Desc}
                        />
                        <div className="studio-form-grid studio-form-grid-three">
                            <Field label={t.assetLabel} htmlFor="grant-asset">
                                <div className="studio-select-wrap">
                                    <select id="grant-asset" value="musdc" disabled>
                                        <option value="musdc">{tokenLabel()}</option>
                                    </select>
                                    <ChevronDown size={15} />
                                </div>
                            </Field>
                            <Field
                                label={t.periodCapLabel}
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
                                    <span>tUSDC</span>
                                </div>
                            </Field>
                            <Field
                                label={t.paymentPeriodLabel}
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
                                        <option value="3600">{t.periodHourly}</option>
                                        <option value="86400">{t.periodDaily}</option>
                                        <option value="604800">{t.periodWeekly}</option>
                                        <option value="2592000">{t.period30Days}</option>
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
                            title={t.s3Title}
                            description={t.s3Desc}
                        />
                        <div className="studio-segmented" aria-label={t.recipientScopeAria}>
                            <button
                                type="button"
                                data-active={draft.recipientMode === "fixed"}
                                onClick={() => update("recipientMode", "fixed")}
                            >
                                {t.fixedRecipientOnly}
                            </button>
                            <button
                                type="button"
                                data-active={draft.recipientMode === "any"}
                                onClick={() => update("recipientMode", "any")}
                            >
                                {t.anyRecipient}
                            </button>
                        </div>
                        <div className="studio-form-grid">
                            {draft.recipientMode === "fixed" ? (
                                <Field
                                    label={t.allowedRecipientLabel}
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
                                    <span>{t.anyRecipientWarning}</span>
                                </div>
                            )}
                            <Field
                                label={t.expiryLabel}
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
                                        <option value="86400">{t.expiry1Day}</option>
                                        <option value="604800">{t.expiry7Days}</option>
                                        <option value="2592000">{t.expiry30Days}</option>
                                        <option value="7776000">{t.expiry90Days}</option>
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
                            ? t.submitSigning
                            : progress.kind === "bootstrapping"
                              ? t.submitBootstrapping
                              : progress.kind === "verifying"
                                ? t.verifyingOnChain
                                : !isConnected
                                  ? t.submitConnectFirst
                                  : wrongChain
                                    ? t.submitSwitchChain
                                    : t.submitCreate}
                        {progress.kind === "idle" ? <ArrowRight size={17} /> : null}
                    </button>
                    <p className="studio-privacy">
                        <LockKeyhole size={15} />
                        {t.privacyNote}
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
    const {locale} = useLocale();
    const t = COPY[locale];
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
                    {connecting ? t.walletConnecting : t.walletConnect}
                </button>
                <small>
                    {connectError ?? t.walletUsing(connectorName ?? t.walletBrowserFallback)}
                </small>
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
                    {switching ? t.walletSwitching : t.walletSwitch}
                </button>
                <small>{t.walletNoSignHere}</small>
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
                {t.walletDisconnect}
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
    const {locale} = useLocale();
    const t = COPY[locale];
    if (state.kind === "idle") {
        return (
            <div className="studio-account-gate">
                <Wallet size={18} />
                <div>
                    <strong>{t.gateIdleTitle}</strong>
                    <p>{t.gateIdleBody}</p>
                </div>
            </div>
        );
    }
    if (state.kind === "loading") {
        return (
            <div className="studio-account-gate">
                <i className="studio-mini-spinner" />
                <div>
                    <strong>{t.gateLoadingTitle}</strong>
                    <p>{t.gateLoadingBody}</p>
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
                        <strong>{t.gateSponsoredTitle}</strong>
                        <p>{t.gateSponsoredBody(short(state.smartAccount))}</p>
                    </div>
                </div>
            );
        }
        return (
            <div className="studio-account-gate" data-tone="warning">
                <CircleAlert size={18} />
                <div>
                    <strong>{t.gateMissingTitle}</strong>
                    <p>{t.gateMissingBody(short(state.smartAccount))}</p>
                </div>
            </div>
        );
    }
    if (state.kind === "error") {
        return (
            <div className="studio-account-gate" data-tone="warning">
                <CircleAlert size={18} />
                <div>
                    <strong>{t.gateErrorTitle}</strong>
                    <p>{state.reason}</p>
                </div>
            </div>
        );
    }
    return (
        <div className="studio-account-gate" data-tone="ready">
            <BadgeCheck size={18} />
            <div>
                <strong>{t.gateReadyTitle}</strong>
                <p>{t.gateReadyBody(short(state.smartAccount))}</p>
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
    const {locale} = useLocale();
    const t = COPY[locale];
    const amount = draft.amount.trim() || "—";
    const recipient =
        draft.recipientMode === "fixed"
            ? draft.recipient.trim()
                ? short(draft.recipient)
                : t.previewUnset
            : t.anyRecipient;
    return (
        <aside className="studio-grant-preview">
            <div className="studio-preview-orbit" aria-hidden="true">
                <span />
                <ShieldCheck size={35} />
            </div>
            <span className="studio-kicker">SIGNING PREVIEW</span>
            <h2>{draft.agentName.trim() || t.previewFallbackName}</h2>
            <p>{t.previewIntro}</p>
            <dl>
                <div>
                    <dt>{t.previewAsset}</dt>
                    <dd>{MOCK_USDC.symbol}</dd>
                </div>
                <div>
                    <dt>{t.previewPeriodCap}</dt>
                    <dd>{amount === "—" ? amount : `${amount} tUSDC`}</dd>
                </div>
                <div>
                    <dt>{t.previewPeriod}</dt>
                    <dd>{durationLabel(Number(draft.periodSeconds), locale)}</dd>
                </div>
                <div>
                    <dt>{t.previewRecipient}</dt>
                    <dd>{recipient}</dd>
                </div>
                <div>
                    <dt>{t.previewValidity}</dt>
                    <dd>{durationLabel(Number(draft.expirySeconds), locale)}</dd>
                </div>
            </dl>
            <div className="studio-preview-check">
                {validation.kind === "ok" ? <Check size={16} /> : <Link2 size={16} />}
                <span>
                    {validation.kind === "ok" ? t.previewReady : t.previewIncomplete}
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
    const {locale} = useLocale();
    const t = COPY[locale];
    const [draft, setDraft] = useState("");
    const [progress, setProgress] = useState<"idle" | "verifying">("idle");
    const [fault, setFault] = useState<string>();
    const parsed: ParsedPermission = useMemo(
        () => parsePermissionContext(draft, locale),
        [draft, locale],
    );

    return (
        <details className="studio-manual-import">
            <summary>
                <span>
                    <FileKey2 size={17} />
                    {t.importSummary}
                </span>
                <small>{t.importBadge}</small>
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
                            setFault(faultLine(error, locale));
                        });
                }}
            >
                <div>
                    <h2>{t.importTitle}</h2>
                    <p>{t.importBody}</p>
                </div>
                <textarea
                    value={draft}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t.importPlaceholder}
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
                    {progress === "verifying" ? t.verifyingOnChain : t.importSubmit}
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

const DURATION_UNITS: Record<
    Locale,
    {month: string; week: string; day: string; hour: string; second: string}
> = {
    en: {month: "month", week: "week", day: "day", hour: "hour", second: "second"},
    ko: {month: "개월", week: "주", day: "일", hour: "시간", second: "초"},
};

function durationLabel(seconds: number, locale: Locale): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "—";
    if (seconds % 2_592_000 === 0) return unitLabel(seconds / 2_592_000, "month", locale);
    if (seconds % 604_800 === 0) return unitLabel(seconds / 604_800, "week", locale);
    if (seconds % 86_400 === 0) return unitLabel(seconds / 86_400, "day", locale);
    if (seconds % 3_600 === 0) return unitLabel(seconds / 3_600, "hour", locale);
    return unitLabel(seconds, "second", locale);
}

function unitLabel(
    count: number,
    unit: keyof (typeof DURATION_UNITS)["en"],
    locale: Locale,
): string {
    // Korean counters attach the unit directly with no plural; English pluralizes.
    if (locale === "ko") return `${count}${DURATION_UNITS.ko[unit]}`;
    const noun = DURATION_UNITS.en[unit];
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
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
function faultLine(error: unknown, locale: Locale): string {
    if (error instanceof Error && error.message) return redactUrls(error.message);
    return COPY[locale].faultFallback;
}
