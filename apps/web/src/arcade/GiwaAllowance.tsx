import {useEffect, useRef, useState, type Ref} from "react";
import {ArrowRight, Check, ChevronDown, ExternalLink, ShieldCheck, Ticket, Wallet} from "lucide-react";
import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";
import type {useGiwaTickets} from "./useGiwaTickets";
import {localizeUrl} from "../lib/i18n";
import {appUrl, explorerAddressUrl} from "../lib/config";
import {ArcadeRevocations} from "./ArcadeRevocations";
import {AllowanceProgress} from "./AllowanceProgress";
import {AllowanceAmount} from "./AllowanceAmount";
import {GuardianAvatar} from "./GuardianAvatar";
import type {Companion} from "./state";
import {MAX_ALLOWANCE_ADMISSIONS} from "./allowance";
import "./allowance.css";

export function GiwaAllowance({ref, giwa, members, onAmountChange, editable, saved, ko, reducedMotion, onLaunch, canLaunch, autoAdvance, onAutoAdvance}: {
    ref: Ref<HTMLElement>; giwa: ReturnType<typeof useGiwaTickets>;
    members: Companion[]; onAmountChange: (id: string, admissions: number) => void;
    editable: boolean; saved: boolean; ko: boolean; reducedMotion: boolean; onLaunch: () => void; canLaunch: boolean;
    autoAdvance: boolean; onAutoAdvance: (value: boolean) => void;
}) {
    const [invalid, setInvalid] = useState<Record<string, boolean>>({});
    const prepared = members.length > 0 && members.every(c => giwa.remainingFor(c.id) > 0);
    const requests = members.filter(c => giwa.remainingFor(c.id) === 0).map(c => ({characterId: c.id, name: c.name, admissions: c.agent.rounds}));
    const available = members.reduce((sum, c) => sum + giwa.remainingFor(c.id), 0);
    const admissions = members.reduce((sum, c) => sum + (giwa.remainingFor(c.id) || c.agent.rounds), 0);
    const valid = members.every(c => !invalid[c.id]);
    const feedback = useRef<HTMLDivElement>(null);
    const wasBusy = useRef(false);
    useEffect(() => {
        const finished = wasBusy.current && !giwa.busy;
        wasBusy.current = giwa.busy;
        if (!finished) return;
        // Restore focus after the progress dialog unmounts, including on failure.
        const frame = requestAnimationFrame(() => feedback.current?.focus({preventScroll: true}));
        return () => cancelAnimationFrame(frame);
    }, [giwa.busy]);
    return <section id="arcade-allowance" className="arc-ticket-desk" ref={ref} aria-labelledby="allowance-title" tabIndex={-1}>
        <div className="arc-desk-heading"><span className="arc-overline">02 / {ko ? "출발 준비" : "BEFORE YOU GO"}</span><span className="arc-test-badge">GIWA {ko ? "테스트넷" : "TESTNET"}</span></div>
        <h2 id="allowance-title">{ko ? "친구에게 쥐여 줄 용돈" : "A little allowance to explore"}</h2>
        <p className="arc-desk-intro">{ko ? "친구마다 용돈을 정해 주세요. 각자 받은 한도 안에서 놀아요." : "Set an allowance for each friend. Each plays within their own limit."}</p>
        <div className="arc-friend-allowances">{members.map(c => {
            const permission = giwa.allowances[c.id], active = giwa.remainingFor(c.id) > 0;
            return <article className={`arc-friend-allowance ${active ? "is-ready" : ""}`} key={c.id}>
                <div className="arc-friend-identity"><GuardianAvatar appearance={c.appearance} color={c.color} portrait /><div><strong>{c.name}</strong><small>{c.agent.mode === "llm" ? "LLM" : ko ? "규칙 기반 봇" : "Rule bot"}</small></div>{active && <span><Check size={14} />{ko ? "준비 완료" : "Ready"}</span>}</div>
                <AllowanceAmount name={c.name} value={active ? permission!.limit : c.agent.rounds} disabled={!editable || active || giwa.busy || !!giwa.pending} ko={ko} onChange={count => onAmountChange(c.id, count)} onValidityChange={ok => setInvalid(previous => previous[c.id] === !ok ? previous : {...previous, [c.id]: !ok})} />
                {active && <div className="arc-friend-remaining"><strong>{ko ? "남은 용돈" : "Remaining"} {giwa.remainingFor(c.id) * ARCADE_TICKET_COST} {MOCK_USDC.symbol}</strong><button type="button" disabled={giwa.busy || !!giwa.pending} onClick={() => giwa.finish(c.id)}>{ko ? "이 용돈 사용 중단" : "Stop this allowance"}</button></div>}
            </article>;
        })}</div>
        {members.length > 0 && <p className="arc-desk-help">{ko ? `친구당 1–${MAX_ALLOWANCE_ADMISSIONS} ${MOCK_USDC.symbol} · 승인 후 30분 동안 사용해요.` : `1–${MAX_ALLOWANCE_ADMISSIONS} ${MOCK_USDC.symbol} per friend · Valid for 30 minutes after approval.`}</p>}
        <div className={`arc-allowance-ticket ${prepared ? "is-ready" : ""}`}>
            <div className="arc-ticket-caption"><Ticket size={18} /><span>{ko ? "선택한 친구들의 용돈 합계" : "Total for your selected friends"}</span></div>
            <strong>{(prepared ? available : admissions) * ARCADE_TICKET_COST}<small>{MOCK_USDC.symbol}</small></strong>
            <div className="arc-ticket-visits"><span>{ko ? `${members.length}명 · 최대 ${prepared ? available : admissions}회` : `${members.length} friends · up to ${prepared ? available : admissions} visits`}</span><span>{ko ? "서로의 용돈을 쓰지 않아요" : "Each budget stays separate"}</span></div>
        </div>
        <div className="arc-desk-balance"><span><Wallet size={16} />{ko ? "내 스마트 계정 잔액" : "My smart-account balance"}</span><b>{giwa.balance ?? "—"} <small>{MOCK_USDC.symbol}</small></b></div>
        <label className="arc-allowance-auto mapae-check"><input type="checkbox" checked={autoAdvance} disabled={giwa.busy} onChange={event => onAutoAdvance(event.target.checked)} /><span>{ko ? "용돈 안에서 다음 놀이도 자동으로" : "Keep playing within each allowance"}<small>{ko ? `한 번 입장할 때 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · 언제든 멈출 수 있어요` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} per admission · Stop whenever you like`}</small></span></label>
        <div ref={feedback} tabIndex={-1} className="arc-allowance-feedback">
        {giwa.busy ? <AllowanceProgress phase={giwa.phase} target={giwa.approvalTarget} walletName={giwa.walletName} ko={ko} reducedMotion={reducedMotion} /> : <>
            {prepared && <p className="arc-allowance-ready" role="status"><Check size={17} />{ko ? "용돈 준비 완료! 이제 친구를 출발시켜 주세요." : "Allowance ready! Send your friends on their way."}</p>}
            {(prepared || giwa.pending) && <button className="arc-button arc-approve-button" disabled={!canLaunch} onClick={onLaunch}>{giwa.pending ? ko ? "입장권 복구" : "Recover ticket" : ko ? "친구 출발시키기" : "Send your friends out"}<ArrowRight size={18} /></button>}
            {!prepared && !giwa.pending && <button className="arc-button arc-approve-button" disabled={!editable || giwa.otherWalletPending || !giwa.recoveryReady || !members.length || !saved || !valid} onClick={() => void giwa.approve(requests)}>{giwa.error ? ko ? "남은 친구 용돈 준비하기" : "Prepare remaining allowances" : ko ? "친구별 용돈 승인하기" : "Approve each friend's allowance"}<ArrowRight size={18} /></button>}
            {!prepared && !giwa.pending && <p className="arc-desk-help">{!members.length ? ko ? "먼저 함께 놀 친구를 선택해 주세요." : "Choose your friends first." : ko ? `친구별 한도를 따로 서명해요 · 이번에 ${requests.length}번 서명` : `Each friend gets a separate signed limit · ${requests.length} signatures`}</p>}
        </>}
        {giwa.error && <p className="arc-notice" role="alert">{giwa.error}</p>}
        </div>
        {!giwa.recoveryReady && saved && <p className="arc-notice" role="status">{ko ? "이전 입장권을 확인하고 있어요…" : "Checking your previous ticket…"}</p>}
        {giwa.pending && <p className="arc-notice" role="status">{ko ? "진행 중인 입장권이 있어요. ‘입장권 복구’로 이어 가세요. 새 결제는 만들지 않아요." : "A ticket is pending. Choose Recover ticket to continue without a new charge."}<br /><small>{ko ? "문의 번호" : "Support ID"}: {giwa.pending.requestId}</small></p>}
        {giwa.otherWalletPending && <p className="arc-notice" role="alert">{ko ? "다른 지갑의 입장권이 진행 중이에요. 해당 지갑으로 다시 연결해 먼저 복구해 주세요." : "Another wallet has a pending ticket. Reconnect that wallet to recover it first."}</p>}
        <div className="arc-desk-assurance"><ShieldCheck size={16} /><span>{ko ? "서명한 한도 안에서만 · 플레이 중 추가 결제 없음" : "Within your signed limit · no in-game charges"}</span></div>
        <details className="arc-permission-details"><summary>{ko ? "용돈 규칙과 승인 기록" : "Allowance rules & permissions"}<ChevronDown size={16} /></summary><div>
            <p>{ko ? "각 친구의 한도는 30분 동안 적용돼요. 테스트 토큰은 내 스마트 계정에 보관되고, 입장할 때만 1 mUSDC씩 사용해요. 탭을 닫거나 지갑을 바꾸면 자동 플레이가 멈추며 다시 서명이 필요해요." : "Each signed limit lasts 30 minutes. Test tokens stay in your smart account; each admission uses 1 mUSDC. Closing the tab or changing wallets stops play and requires a new signature."}</p>
            {giwa.payer && <a href={explorerAddressUrl(giwa.payer)} target="_blank" rel="noreferrer">{ko ? "내 스마트 계정 확인" : "View my smart account"}<ExternalLink size={14} /></a>}
            <a href={localizeUrl(appUrl, ko ? "ko" : "en")}>Mapae Studio<ExternalLink size={14} /></a>
            {giwa.remaining > 0 && <button className="arc-text-button" disabled={giwa.busy || !!giwa.pending} onClick={() => giwa.finish()}>{ko ? "모든 친구의 용돈 사용 중단" : "Stop all allowances in this tab"}</button>}<small>{ko ? "탭에서 중단해도 온체인 권한은 남아요. 즉시 철회하려면 아래 승인 기록에서 지갑으로 서명해 주세요." : "Stopping this tab does not revoke on-chain permission. Sign from the record below to revoke it now."}</small>
            <ArcadeRevocations grants={giwa.grants.filter(grant => giwa.payer && grant.artifact.delegator.toLowerCase() === giwa.payer.toLowerCase() && grant.artifact.createdAt + 1800 > Date.now() / 1000)} ko={ko} onRevoked={giwa.revoked} />
        </div></details>
    </section>;
}
