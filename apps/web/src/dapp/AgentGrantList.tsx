import {fromTokenAmount} from "@mapae/shared";
import {
    ArrowRight,
    Bot,
    Check,
    Clipboard,
    Clock3,
    History,
    Trash2,
    Info,
    KeyRound,
    Plus,
    ShieldCheck,
    UserRoundCheck,
} from "lucide-react";
import {useEffect, useState} from "react";
import {buildMcpBundle} from "../lib/agent-key";
import {deployment} from "../lib/config";
import {short} from "../lib/dial";
import type {SessionGrant} from "../lib/grant";
import type {Locale} from "../lib/i18n";
import {useLocale} from "../lib/locale";

const COPY: Record<
    Locale,
    {
        clipboardFault: string;
        title: string;
        subtitle: string;
        newGrant: string;
        recover: string;
        recovering: string;
        sessionNote: string;
        forget: string;
        forgetWarning: string;
        forgetConfirm: string;
        forgetCancel: string;
        emptyTitle: string;
        emptyBody: string;
        createFirst: string;
        periodCap: string;
        paymentPeriod: string;
        recipient: string;
        readFromChain: string;
        anyRecipient: string;
        copied: string;
        copyBundle: string;
        copyGrantCode: string;
        currentlyOpen: string;
        viewGrant: string;
        bundleNote: string;
    }
> = {
    en: {
        clipboardFault: "The browser did not allow clipboard access.",
        title: "My agents",
        subtitle: "Manage the payment grants signed or imported in this Studio session.",
        newGrant: "New grant",
        recover: "Recover from chain",
        recovering: "Reading chain…",
        sessionNote:
            "Grant issuance is an off-chain signature, so a grant that has never settled exists nowhere but here. This list is kept in this browser — never sent to a server, never placed in a URL. The agent session key is the one thing not kept: copy its bundle before you leave.",
        forget: "Forget",
        forgetWarning:
            "This removes the grant from this browser only. It does not revoke anything — the delegation stays live inside its caveat until it expires or you revoke it. Copy the permission code first if you want to keep it.",
        forgetConfirm: "Forget it",
        forgetCancel: "Keep",
        emptyTitle: "No agents registered yet.",
        emptyBody:
            "Set the asset, amount, period, and recipient boundaries, sign in your wallet, and the grant appears here.",
        createFirst: "Create your first grant",
        periodCap: "Period cap",
        paymentPeriod: "Payment period",
        recipient: "Recipient",
        readFromChain: "Read from chain",
        anyRecipient: "Any recipient",
        copied: "Copied",
        copyBundle: "Copy MCP connection bundle",
        copyGrantCode: "Copy permission code",
        currentlyOpen: "Currently open",
        viewGrant: "View grant",
        bundleNote:
            "The bundle contains the agent session key created in this tab. Once it is moved to a file, discard the pasted text — and if you use clipboard history or cross-device sync, clear that record too. It cannot be retrieved again after the tab closes.",
    },
    ko: {
        clipboardFault: "브라우저가 클립보드 접근을 허용하지 않았습니다.",
        title: "내 에이전트",
        subtitle: "이 Studio 세션에서 서명하거나 불러온 결제 권한을 관리합니다.",
        newGrant: "새 권한",
        recover: "체인에서 복구",
        recovering: "체인 읽는 중…",
        sessionNote:
            "위임 발급은 오프체인 서명이라, 한 번도 정산되지 않은 권한은 여기 말고는 어디에도 없습니다. 이 목록은 이 브라우저에 보관됩니다 — 서버로 보내지 않고 URL에도 남기지 않습니다. 보관하지 않는 단 하나는 에이전트 세션 키이니, 떠나기 전에 번들을 복사해 두세요.",
        forget: "목록에서 지우기",
        forgetWarning:
            "이 브라우저의 목록에서만 지웁니다. 회수가 아닙니다 — 위임은 만료되거나 회수하기 전까지 caveat 안에서 그대로 살아 있습니다. 보관하려면 먼저 권한 코드를 복사하세요.",
        forgetConfirm: "지웁니다",
        forgetCancel: "그대로 두기",
        emptyTitle: "아직 등록된 에이전트가 없습니다.",
        emptyBody: "자산·금액·기간·수취인 경계를 정하고 지갑에서 서명하면 여기에 바로 추가됩니다.",
        createFirst: "첫 권한 만들기",
        periodCap: "주기 한도",
        paymentPeriod: "결제 주기",
        recipient: "수취인",
        readFromChain: "체인에서 확인",
        anyRecipient: "모든 수취인",
        copied: "복사됨",
        copyBundle: "MCP 연결 번들 복사",
        copyGrantCode: "권한 코드 복사",
        currentlyOpen: "현재 열림",
        viewGrant: "권한 보기",
        bundleNote:
            "번들에는 이 탭에서 만든 에이전트 세션키가 들어갑니다. 파일로 옮긴 뒤 붙여넣은 텍스트는 폐기하고, 클립보드 기록·기기 간 동기화를 쓴다면 그 기록도 지우세요 — 탭을 닫으면 다시 받을 수 없습니다.",
    },
};

export function AgentGrantList({
    grants,
    selectedContext,
    onSelect,
    onCreate,
    onForget,
    onRecover,
    recovering,
}: {
    /**
     * `undefined` means the store has not been consulted yet, which is not the same as an
     * empty library. Rendering the "no agents" screen for that one frame shows a returning
     * user the exact message that reads as data loss.
     */
    grants: SessionGrant[] | undefined;
    selectedContext: string;
    onSelect: (grant: SessionGrant) => void;
    onCreate: () => void;
    onForget: (permissionContext: `0x${string}`) => void;
    /** Rebuilds settled grants from chain — see `recoverGrantsFromChain`. */
    onRecover: () => Promise<void>;
    recovering: boolean;
}) {
    const {locale} = useLocale();
    const t = COPY[locale];
    const [copied, setCopied] = useState<string>();
    const [copyFault, setCopyFault] = useState<string>();
    const [confirming, setConfirming] = useState<string>();

    useEffect(() => {
        if (!copied) return;
        const timeout = window.setTimeout(() => setCopied(undefined), 1600);
        return () => window.clearTimeout(timeout);
    }, [copied]);

    async function copyGrant(grant: SessionGrant) {
        try {
            await navigator.clipboard.writeText(grant.artifact.permissionContext);
            setCopyFault(undefined);
            setCopied(grant.id);
        } catch {
            setCopyFault(t.clipboardFault);
        }
    }

    async function copyBundle(grant: SessionGrant) {
        if (!grant.agentKey) return;
        const bundle = buildMcpBundle(
            {
                permissionContext: grant.artifact.permissionContext,
                agentKey: grant.agentKey,
                frameworkAdmin: deployment.admin.owner,
            },
            locale,
        );
        try {
            await navigator.clipboard.writeText(bundle.bundleText);
            setCopyFault(undefined);
            setCopied(`bundle:${grant.id}`);
        } catch {
            setCopyFault(t.clipboardFault);
        }
    }

    return (
        <div className="studio-agents-page">
            <header className="studio-agents-head">
                <div>
                    <span className="studio-kicker">GRANTED AGENTS</span>
                    <h1>{t.title}</h1>
                    <p>{t.subtitle}</p>
                </div>
                <div className="studio-agents-actions">
                    <button
                        type="button"
                        className="studio-secondary-button"
                        onClick={() => void onRecover()}
                        disabled={recovering}
                    >
                        <History size={16} />
                        {recovering ? t.recovering : t.recover}
                    </button>
                    <button type="button" className="studio-wallet-button" onClick={onCreate}>
                        <Plus size={17} />
                        {t.newGrant}
                    </button>
                </div>
            </header>

            <div className="studio-session-note">
                <Info size={17} />
                <p>{t.sessionNote}</p>
            </div>
            {copyFault ? (
                <p className="studio-agent-copy-fault" role="alert">
                    {copyFault}
                </p>
            ) : null}

            {grants === undefined ? (
                <div className="studio-agent-grid" aria-busy="true">
                    <article className="studio-agent-card" data-placeholder="true" />
                    <article className="studio-agent-card" data-placeholder="true" />
                </div>
            ) : grants.length === 0 ? (
                <section className="studio-agents-empty">
                    <span>
                        <Bot size={27} />
                    </span>
                    <h2>{t.emptyTitle}</h2>
                    <p>{t.emptyBody}</p>
                    <button type="button" className="studio-primary-button" onClick={onCreate}>
                        {t.createFirst}
                        <ArrowRight size={17} />
                    </button>
                </section>
            ) : (
                <div className="studio-agent-grid">
                    {grants.map((grant) => {
                        const selected =
                            selectedContext === grant.artifact.permissionContext;
                        return (
                            <article
                                className="studio-agent-card"
                                data-selected={selected}
                                key={grant.id}
                            >
                                <header>
                                    <span>
                                        <Bot size={20} />
                                    </span>
                                    <div>
                                        <h2>{grant.name}</h2>
                                        <p>{short(grant.artifact.delegate)}</p>
                                    </div>
                                    <i>{grant.source === "signed" ? "SIGNED" : "IMPORTED"}</i>
                                </header>
                                <dl>
                                    <div>
                                        <dt>
                                            <ShieldCheck size={14} />
                                            {t.periodCap}
                                        </dt>
                                        <dd>
                                            {grant.amount !== undefined
                                                ? `${fromTokenAmount(grant.amount)} mUSDC`
                                                : t.readFromChain}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <Clock3 size={14} />
                                            {t.paymentPeriod}
                                        </dt>
                                        <dd>
                                            {grant.periodSeconds
                                                ? durationLabel(grant.periodSeconds, locale)
                                                : t.readFromChain}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <UserRoundCheck size={14} />
                                            {t.recipient}
                                        </dt>
                                        <dd>
                                            {grant.recipient
                                                ? short(grant.recipient)
                                                : grant.source === "signed"
                                                  ? t.anyRecipient
                                                  : t.readFromChain}
                                        </dd>
                                    </div>
                                </dl>
                                <footer>
                                    {grant.agentKey ? (
                                        <button
                                            type="button"
                                            className="studio-secondary-button"
                                            onClick={() => void copyBundle(grant)}
                                        >
                                            {copied === `bundle:${grant.id}` ? (
                                                <Check size={15} />
                                            ) : (
                                                <KeyRound size={15} />
                                            )}
                                            {copied === `bundle:${grant.id}`
                                                ? t.copied
                                                : t.copyBundle}
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="studio-secondary-button"
                                        onClick={() => void copyGrant(grant)}
                                    >
                                        {copied === grant.id ? (
                                            <Check size={15} />
                                        ) : (
                                            <Clipboard size={15} />
                                        )}
                                        {copied === grant.id ? t.copied : t.copyGrantCode}
                                    </button>
                                    <button
                                        type="button"
                                        className="studio-agent-open"
                                        onClick={() => onSelect(grant)}
                                    >
                                        {selected ? t.currentlyOpen : t.viewGrant}
                                        <ArrowRight size={15} />
                                    </button>
                                </footer>
                                {grant.agentKey ? (
                                    <p className="studio-bundle-note">{t.bundleNote}</p>
                                ) : null}
                                {confirming === grant.id ? (
                                    // Two-step inline rather than window.confirm: that dialog
                                    // is unstyled and untranslatable through the COPY maps
                                    // every component here uses. The copy has to say what
                                    // forgetting is *not* — this browser holds the only copy,
                                    // and removing it does not revoke anything on chain.
                                    <p className="studio-forget-confirm" role="alert">
                                        <span>{t.forgetWarning}</span>
                                        <button
                                            type="button"
                                            className="studio-forget-go"
                                            onClick={() => {
                                                setConfirming(undefined);
                                                onForget(grant.artifact.permissionContext);
                                            }}
                                        >
                                            {t.forgetConfirm}
                                        </button>
                                        <button
                                            type="button"
                                            className="studio-forget-cancel"
                                            onClick={() => setConfirming(undefined)}
                                        >
                                            {t.forgetCancel}
                                        </button>
                                    </p>
                                ) : (
                                    <button
                                        type="button"
                                        className="studio-forget"
                                        onClick={() => setConfirming(grant.id)}
                                    >
                                        <Trash2 size={13} />
                                        {t.forget}
                                    </button>
                                )}
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const DURATION_UNITS: Record<
    Locale,
    {month: string; week: string; day: string; hour: string; second: string}
> = {
    en: {month: "month", week: "week", day: "day", hour: "hour", second: "second"},
    ko: {month: "개월", week: "주", day: "일", hour: "시간", second: "초"},
};

function durationLabel(seconds: number, locale: Locale = "en"): string {
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
    // Korean counts attach the unit directly with no plural; English pluralizes.
    if (locale === "ko") return `${count}${DURATION_UNITS.ko[unit]}`;
    const noun = DURATION_UNITS.en[unit];
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
