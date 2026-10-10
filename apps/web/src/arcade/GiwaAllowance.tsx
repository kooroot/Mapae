import {useState, type Ref} from 'react';
import {ArrowRight, ExternalLink, ShieldCheck} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {MOCK_USDC} from '@mapae/shared';
import {ARCADE_TICKET_COST} from '@mapae/arcade/tickets';
import type {useGiwaTickets} from './useGiwaTickets';
import {ArcadeRevocations} from './ArcadeRevocations';
import {AllowanceProgress} from './AllowanceProgress';
import {AllowanceAmount} from './AllowanceAmount';
import {GuardianAvatar} from './GuardianAvatar';
import type {Companion} from './state';
import {appUrl} from '../lib/config';
import {localizeUrl} from '../lib/i18n';
import './allowance.css';
import {activeGuardianOuting,type GuardianIdentity} from './nft/outing-model';

export function GiwaAllowance({ref,giwa,members,onAmountChange,editable,saved,ko,onLaunch,canLaunch,choice}: {
    ref: Ref<HTMLElement>; giwa: ReturnType<typeof useGiwaTickets>; members: (Companion & {nft:GuardianIdentity})[];
    onAmountChange:(id:string,admissions:number)=>void; editable:boolean; saved:boolean; ko:boolean;
    onLaunch:()=>void; canLaunch:boolean; choice:GameId|'auto';
}) {
    const [invalid,setInvalid]=useState<Record<string,boolean>>({});
    const total=members.reduce((n,c)=>n+c.agent.rounds,0)*ARCADE_TICKET_COST;
    const valid=members.every(c=>!invalid[c.id]);
    return <section id="arcade-allowance" className="arc-giwa-allowance" ref={ref} tabIndex={-1} aria-labelledby="allowance-heading">
        <span className="arc-overline">02 / {ko?'용돈 쥐여 보내기':'SEND THEM OUT'}</span>
        <h2 id="allowance-heading">{ko?'다녀와, 우리 친구!':'Off on a little adventure'}</h2>
        <p>{ko?'용돈과 놀이를 정하면 화면을 닫아도 계속해요. 돌아오면 모험첩을 펼쳐 보세요.':'Set their allowance and games. They keep going after you leave. Come back to their stories.'}</p>
        <div className="arc-allowance-balance"><span>{ko?'스마트 계정 잔액':'Smart-account balance'}</span><strong>{giwa.balance??'—'} {MOCK_USDC.symbol}</strong></div>
        <div className="arc-friend-allowances">{members.map(c=>{
            const active=giwa.jobs.some(j=>activeGuardianOuting(j,c.nft));
            return <div className="arc-friend-allowance" key={c.id}><div className="arc-friend-identity"><GuardianAvatar appearance={c.appearance} color={c.color} portrait/><div><strong>{c.name}</strong><small>{active?(ko?'외출 기록에서 확인해요':'Check their outing below'):(c.agent.mode==='rules'?(ko?'규칙 기반 봇':'Rule bot'):'LLM')}</small></div></div>
                <AllowanceAmount name={c.name} value={c.agent.rounds} disabled={!editable||active||giwa.busy} ko={ko} onChange={n=>onAmountChange(c.id,n)} onValidityChange={ok=>setInvalid(v=>v[c.id]===!ok?v:{...v,[c.id]:!ok})}/></div>;
        })}</div>
        {!members.length&&<p>{ko?'함께할 친구를 먼저 골라 주세요.':'Choose a friend first.'}</p>}
        <p className="arc-allowance-summary"><b>{ko?`이번 외출 최대 ${total} ${MOCK_USDC.symbol}`:`Up to ${total} ${MOCK_USDC.symbol}`}</b><br/>{ko?'빠른 자동 진행 · 1회 1 mUSDC · 권한은 2시간 뒤 만료':'Fast automatic rounds · 1 mUSDC each · Permission expires in 2 hours'}</p>
        {!giwa.available&&!giwa.pending&&<p role="status" className="arc-notice">{ko?'자동 외출은 잠시 준비 중이에요. 직접 연습은 무료로 즐길 수 있어요.':'Away outings are currently unavailable. You can still practice for free.'}</p>}
        {giwa.error&&<p role="alert" className="arc-notice">{giwa.error}</p>}
        {giwa.busy && giwa.phase !== 'idle'?<AllowanceProgress phase={giwa.phase} walletName={giwa.walletName} target={giwa.approvalTarget} ko={ko}/>:<button className="arc-button arc-approve-button" disabled={giwa.busy||!canLaunch||!valid||!saved} onClick={()=>{if(giwa.pending||giwa.submission)onLaunch();else void giwa.approve(members.map(c=>({...c.nft,goal:c.agent.goal,name:c.name,admissions:c.agent.rounds})),choice);}}>{giwa.busy?(ko?'외출 상태 확인 중…':'Checking outing…'):giwa.pending?(ko?'입장권 복구':'Recover ticket'):giwa.submission?(ko?'외출 요청 확인':'Recover outing request'):(ko?'승인하고 놀러 보내기':'Approve and send')}<ArrowRight size={18}/></button>}
        <p className="arc-allowance-guard"><ShieldCheck size={16}/>{ko?'잔액은 내 스마트 계정에 있어요. 서명한 한도만 사용할 수 있어요.':'Funds stay in your smart account. Only your signed allowance can be spent.'}</p>
        <a className="arc-text-button" href={localizeUrl(appUrl,ko?'ko':'en')}>{ko?'테스트 토큰 충전':'Get test tokens'}<ExternalLink size={14}/></a>
        <ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked}/>
    </section>;
}
