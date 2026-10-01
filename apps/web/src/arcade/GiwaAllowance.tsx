import type {Ref} from "react";
import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";
import type {useGiwaTickets} from "./useGiwaTickets";
import {appUrl, chain, explorerAddressUrl} from "../lib/config";
import {ArcadeRevocations} from "./ArcadeRevocations";

export function GiwaAllowance({ref, giwa, admissions, saved, ko}: {
    ref: Ref<HTMLDetailsElement>; giwa: ReturnType<typeof useGiwaTickets>;
    admissions: number; saved: boolean; ko: boolean;
}) {
    const phases = ko ? {idle: "", catalogue: "입장권 확인 중…", wallet: "지갑 연결 확인 중…", switching: "GIWA 전환 확인 중…", preparing: "서명 준비 중…", signing: "지갑에서 메시지 서명…", bootstrap: "스마트 계정 준비 중…", verifying: "GIWA 잔액 확인 중…"} : {idle: "", catalogue: "Checking tickets…", wallet: "Checking wallet…", switching: "Switch to GIWA…", preparing: "Preparing signature…", signing: "Sign message in wallet…", bootstrap: "Preparing smart account…", verifying: "Checking GIWA balance…"};
    return <details className="agent-customize agent-giwa" ref={ref}>
        <summary><span><b>{ko ? "함께 쓰는 GIWA 용돈" : "One shared GIWA allowance"}</b><small>{ko ? `입장권당 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · 플레이 중 추가 결제 없음` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} per ticket · no in-game charges`}</small></span><span>GIWA ↗</span></summary>
        <div className="agent-giwa-body">
            <p>{ko ? "테스트 토큰은 내 스마트 계정에 있어요. 선택한 캐릭터들은 내가 서명한 총 용돈 안에서만 사용할 수 있어요." : "Test tokens stay in your smart account. Your characters can spend only within the total allowance you sign."}</p>
            <p className="agent-wallet-network">{giwa.walletName} · {giwa.chainId === chain.id ? `${chain.name} · ${chain.id}` : ko ? "GIWA 네트워크 전환 필요" : "Switch to GIWA required"}</p>
            <dl><div><dt>{ko ? "스마트 계정 잔액" : "Smart-account balance"}</dt><dd>{giwa.balance ?? "—"} {MOCK_USDC.symbol}</dd></div><div><dt>{ko ? "이번에 승인할 총 용돈" : "Total allowance to approve"}</dt><dd>{(admissions * ARCADE_TICKET_COST).toFixed(2)} {MOCK_USDC.symbol} · {admissions} {ko ? "회" : "entries"}</dd></div><div><dt>{ko ? "유효기간 / 수취인" : "Validity / recipient"}</dt><dd>{ko ? "30분 / Mapae Arcade만" : "30 minutes / Mapae Arcade only"}</dd></div></dl>
            {giwa.payer && <a href={explorerAddressUrl(giwa.payer)} target="_blank" rel="noreferrer">{ko ? "내 스마트 계정 확인" : "View my smart account"} ↗</a>}
            {giwa.pending && <p role="status">{ko ? "진행 중인 입장권이 있어요. 입장권 복구를 눌러 주세요. 새 결제는 만들지 않아요." : "A ticket is pending. Recover the same ticket without a new charge."}</p>}
            <div className="agent-giwa-actions"><button className="arc-button" disabled={giwa.busy || !!giwa.pending || giwa.otherWalletPending || admissions === 0 || !saved || giwa.remaining > 0} onClick={() => void giwa.approve(admissions)}>{giwa.busy ? phases[giwa.phase] : giwa.remaining > 0 ? ko ? `${giwa.remaining}회 용돈 준비됨` : `${giwa.remaining} entries ready` : ko ? "테스트 용돈 승인" : "Approve test allowance"}</button>{giwa.remaining > 0 && <button className="arc-text-button" onClick={giwa.finish}>{ko ? "이 탭에서 사용 중단" : "Stop in this tab"}</button>}<a className="arc-text-button" href={appUrl}>Mapae Studio ↗</a></div>
            {giwa.remaining > 0 && <small>{ko ? "탭에서 사용을 멈춰도 온체인 권한은 철회되지 않아요. 즉시 철회하려면 아래 승인 기록에서 지갑으로 서명해 주세요." : "Stopping this tab does not revoke the on-chain permission. To revoke now, sign from the permission record below."}</small>}
            <ArcadeRevocations grants={giwa.grants.filter(grant => giwa.payer && grant.artifact.delegator.toLowerCase() === giwa.payer.toLowerCase() && grant.artifact.createdAt + 1800 > Date.now() / 1000)} ko={ko} onRevoked={giwa.revoked} />
            {giwa.busy && <p role="status">{phases[giwa.phase]}{giwa.phase === "signing" && (ko ? ` ${giwa.walletName}에서 mapae.io의 메시지 서명을 확인해 주세요. ETH 보내기 거래를 요청하지 않아요.` : ` Check the mapae.io message signature in ${giwa.walletName}. No ETH transfer is requested.`)}</p>}
            <small>{ko ? "서명하면 필요한 경우 스마트 계정 생성과 테스트 토큰 충전을 요청해요. 진행 중인 결제를 복구할 수 있도록 탭을 닫지 마세요." : "Signing may request sponsored account deployment and test tokens. Keep this tab open while a payment is pending."}</small>
            {giwa.otherWalletPending && <p className="arc-notice" role="alert">{ko ? "다른 지갑의 입장권이 진행 중이에요. 해당 지갑으로 다시 연결해 먼저 복구해 주세요." : "Another wallet has a pending ticket. Reconnect that wallet to recover it first."}</p>}
            {giwa.error && <p className="arc-notice" role="alert">{giwa.error}</p>}
        </div>
    </details>;
}
