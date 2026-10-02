import {useEffect, useRef, type Ref} from "react";
import {ArrowRight, Check, ChevronDown, ExternalLink, ShieldCheck, Ticket, Wallet} from "lucide-react";
import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";
import type {useGiwaTickets} from "./useGiwaTickets";
import {localizeUrl} from "../lib/i18n";
import {appUrl, explorerAddressUrl} from "../lib/config";
import {ArcadeRevocations} from "./ArcadeRevocations";
import {AllowanceProgress} from "./AllowanceProgress";

export function GiwaAllowance({ref, giwa, admissions, saved, ko, reducedMotion, onLaunch, canLaunch}: {
    ref: Ref<HTMLElement>; giwa: ReturnType<typeof useGiwaTickets>;
    admissions: number; saved: boolean; ko: boolean; reducedMotion: boolean; onLaunch: () => void; canLaunch: boolean;
}) {
    const prepared = giwa.remaining > 0;
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
        <p className="arc-desk-intro">{ko ? "잔액은 내 계정에, 쓸 수 있는 만큼만 친구에게." : "Funds stay in your account. Your friends get a spending limit."}</p>
        <div className={`arc-allowance-ticket ${prepared ? "is-ready" : ""}`}>
            <div className="arc-ticket-caption"><Ticket size={18} /><span>{prepared ? ko ? "지금 사용할 수 있는 용돈" : "Available allowance" : ko ? "이번에 승인할 최대 용돈" : "Maximum allowance to approve"}</span></div>
            <strong>{(prepared ? giwa.remaining : admissions) * ARCADE_TICKET_COST}<small>{MOCK_USDC.symbol}</small></strong>
            <div className="arc-ticket-visits"><span>{prepared ? ko ? `${giwa.remaining}회 입장 가능` : `${giwa.remaining} entries available` : ko ? `선택한 친구들 · 최대 ${admissions}회` : `Selected friends · up to ${admissions} visits`}</span><span>{ko ? `1회 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} / entry`}</span></div>
        </div>
        <div className="arc-desk-balance"><span><Wallet size={16} />{ko ? "내 스마트 계정 잔액" : "My smart-account balance"}</span><b>{giwa.balance ?? "—"} <small>{MOCK_USDC.symbol}</small></b></div>
        <div ref={feedback} tabIndex={-1} className="arc-allowance-feedback">
        {giwa.busy ? <AllowanceProgress phase={giwa.phase} walletName={giwa.walletName} ko={ko} reducedMotion={reducedMotion} /> : <>
            {prepared && <p className="arc-allowance-ready" role="status"><Check size={17} />{ko ? "용돈 준비 완료! 이제 친구를 출발시켜 주세요." : "Allowance ready! Send your friends on their way."}</p>}
            {(prepared || giwa.pending) && <button className="arc-button arc-approve-button" disabled={!canLaunch} onClick={onLaunch}>{giwa.pending ? ko ? "입장권 복구" : "Recover ticket" : ko ? "친구 출발시키기" : "Send your friends out"}<ArrowRight size={18} /></button>}
            {!prepared && !giwa.pending && <button className="arc-button arc-approve-button" disabled={giwa.otherWalletPending || admissions === 0 || !saved} onClick={() => void giwa.approve(admissions)}>{giwa.error ? ko ? "용돈 준비 다시 시도" : "Retry allowance setup" : ko ? "테스트 용돈 준비하기" : "Prepare test allowance"}<ArrowRight size={18} /></button>}
            {!prepared && !giwa.pending && <p className="arc-desk-help">{admissions === 0 ? ko ? "먼저 함께 놀 친구를 선택해 주세요." : "Choose your friends first." : ko ? "지갑 서명 → 계정 준비 → 출발. 필요한 단계는 안내해 드려요." : "Sign → prepare account → head out. We will guide each step."}</p>}
        </>}
        {giwa.error && <p className="arc-notice" role="alert">{giwa.error}</p>}
        </div>
        {giwa.pending && <p className="arc-notice" role="status">{ko ? "진행 중인 입장권이 있어요. ‘입장권 복구’로 이어 가세요. 새 결제는 만들지 않아요." : "A ticket is pending. Choose Recover ticket to continue without a new charge."}</p>}
        {giwa.otherWalletPending && <p className="arc-notice" role="alert">{ko ? "다른 지갑의 입장권이 진행 중이에요. 해당 지갑으로 다시 연결해 먼저 복구해 주세요." : "Another wallet has a pending ticket. Reconnect that wallet to recover it first."}</p>}
        <div className="arc-desk-assurance"><ShieldCheck size={16} /><span>{ko ? "서명한 한도 안에서만 · 플레이 중 추가 결제 없음" : "Within your signed limit · no in-game charges"}</span></div>
        <details className="arc-permission-details"><summary>{ko ? "용돈 규칙과 승인 기록" : "Allowance rules & permissions"}<ChevronDown size={16} /></summary><div>
            <p>{ko ? "용돈은 30분 동안 Mapae Arcade에서만 사용할 수 있어요. 테스트 토큰은 내 스마트 계정에 보관돼요." : "Your allowance lasts 30 minutes and can only be used at Mapae Arcade. Test tokens stay in your smart account."}</p>
            {giwa.payer && <a href={explorerAddressUrl(giwa.payer)} target="_blank" rel="noreferrer">{ko ? "내 스마트 계정 확인" : "View my smart account"}<ExternalLink size={14} /></a>}
            <a href={localizeUrl(appUrl, ko ? "ko" : "en")}>Mapae Studio<ExternalLink size={14} /></a>
            {prepared && <><button className="arc-text-button" onClick={giwa.finish}>{ko ? "이 탭에서 용돈 사용 중단" : "Stop using this allowance in this tab"}</button><small>{ko ? "탭에서 중단해도 온체인 권한은 남아요. 즉시 철회하려면 아래 승인 기록에서 지갑으로 서명해 주세요." : "Stopping this tab does not revoke on-chain permission. Sign from the record below to revoke it now."}</small></>}
            <ArcadeRevocations grants={giwa.grants.filter(grant => giwa.payer && grant.artifact.delegator.toLowerCase() === giwa.payer.toLowerCase() && grant.artifact.createdAt + 1800 > Date.now() / 1000)} ko={ko} onRevoked={giwa.revoked} />
        </div></details>
    </section>;
}
