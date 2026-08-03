import {fromTokenAmount} from "@mapae/shared";
import {
    ArrowRight,
    Bot,
    Check,
    Clipboard,
    Clock3,
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

export function AgentGrantList({
    grants,
    selectedContext,
    onSelect,
    onCreate,
}: {
    grants: SessionGrant[];
    selectedContext: string;
    onSelect: (grant: SessionGrant) => void;
    onCreate: () => void;
}) {
    const [copied, setCopied] = useState<string>();
    const [copyFault, setCopyFault] = useState<string>();

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
            setCopyFault("브라우저가 클립보드 접근을 허용하지 않았습니다.");
        }
    }

    async function copyBundle(grant: SessionGrant) {
        if (!grant.agentKey) return;
        const bundle = buildMcpBundle({
            permissionContext: grant.artifact.permissionContext,
            agentKey: grant.agentKey,
            frameworkAdmin: deployment.admin.owner,
        });
        try {
            await navigator.clipboard.writeText(bundle.bundleText);
            setCopyFault(undefined);
            setCopied(`bundle:${grant.id}`);
        } catch {
            setCopyFault("브라우저가 클립보드 접근을 허용하지 않았습니다.");
        }
    }

    return (
        <div className="studio-agents-page">
            <header className="studio-agents-head">
                <div>
                    <span className="studio-kicker">GRANTED AGENTS</span>
                    <h1>내 에이전트</h1>
                    <p>이 Studio 세션에서 서명하거나 불러온 결제 권한을 관리합니다.</p>
                </div>
                <button type="button" className="studio-wallet-button" onClick={onCreate}>
                    <Plus size={17} />
                    새 권한
                </button>
            </header>

            <div className="studio-session-note">
                <Info size={17} />
                <p>
                    위임 발급은 오프체인 서명이므로 체인에서 전체 목록을 자동 복구할 수
                    없습니다. 민감한 권한 코드를 브라우저 저장소에 남기지 않기 위해 이
                    목록은 현재 탭에만 유지됩니다.
                </p>
            </div>
            {copyFault ? (
                <p className="studio-agent-copy-fault" role="alert">
                    {copyFault}
                </p>
            ) : null}

            {grants.length === 0 ? (
                <section className="studio-agents-empty">
                    <span>
                        <Bot size={27} />
                    </span>
                    <h2>아직 등록된 에이전트가 없습니다.</h2>
                    <p>
                        자산·금액·기간·수취인 경계를 정하고 지갑에서 서명하면 여기에 바로
                        추가됩니다.
                    </p>
                    <button type="button" className="studio-primary-button" onClick={onCreate}>
                        첫 권한 만들기
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
                                            주기 한도
                                        </dt>
                                        <dd>
                                            {grant.amount !== undefined
                                                ? `${fromTokenAmount(grant.amount)} mUSDC`
                                                : "체인에서 확인"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <Clock3 size={14} />
                                            결제 주기
                                        </dt>
                                        <dd>
                                            {grant.periodSeconds
                                                ? durationLabel(grant.periodSeconds)
                                                : "체인에서 확인"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <UserRoundCheck size={14} />
                                            수취인
                                        </dt>
                                        <dd>
                                            {grant.recipient
                                                ? short(grant.recipient)
                                                : grant.source === "signed"
                                                  ? "모든 수취인"
                                                  : "체인에서 확인"}
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
                                                ? "복사됨"
                                                : "MCP 연결 번들 복사"}
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
                                        {copied === grant.id ? "복사됨" : "권한 코드 복사"}
                                    </button>
                                    <button
                                        type="button"
                                        className="studio-agent-open"
                                        onClick={() => onSelect(grant)}
                                    >
                                        {selected ? "현재 열림" : "권한 보기"}
                                        <ArrowRight size={15} />
                                    </button>
                                </footer>
                                {grant.agentKey ? (
                                    <p className="studio-bundle-note">
                                        번들에는 이 탭에서 만든 에이전트 세션키가
                                        들어갑니다. 파일로 옮긴 뒤 붙여넣은 텍스트는
                                        폐기하고, 클립보드 기록·기기 간 동기화를 쓴다면
                                        그 기록도 지우세요 — 탭을 닫으면 다시 받을 수
                                        없습니다.
                                    </p>
                                ) : null}
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function durationLabel(seconds: number): string {
    if (seconds % 2_592_000 === 0) return `${seconds / 2_592_000}개월`;
    if (seconds % 604_800 === 0) return `${seconds / 604_800}주`;
    if (seconds % 86_400 === 0) return `${seconds / 86_400}일`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600}시간`;
    return `${seconds}초`;
}
