import {useState, type Ref} from 'react';
import {Link} from '@tanstack/react-router';
import {ArrowRight, CircleAlert, ExternalLink, ShieldCheck} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {MOCK_USDC} from '@mapae/shared';
import {ARCADE_TICKET_COST} from '@mapae/arcade/tickets';
import {guardianName} from '@mapae/arcade/guardians';
import type {useGiwaTickets} from './useGiwaTickets';
import {AllowanceProgress} from './AllowanceProgress';
import {AllowanceAmount} from './AllowanceAmount';
import {GuardianAvatar} from './GuardianAvatar';
import {GUARDIAN_NAMES} from './guardian';
import type {Companion} from './state';
import {FAUCET_HINT,faucetHintUrl} from './faucet-hint';
import {arcadeSectionLink} from './sections';
import './allowance.css';
import {activeGuardianOuting,type GuardianIdentity} from './nft/outing-model';
import {TEMPERAMENT_NAMES} from './nft/model';

export function GiwaAllowance({ref,giwa,members,onAmountChange,editable,authenticated,ko,onLaunch,canLaunch,choice}: {
    ref: Ref<HTMLElement>; giwa: ReturnType<typeof useGiwaTickets>; members: (Companion & {nft:GuardianIdentity})[];
    onAmountChange:(id:string,admissions:number)=>void; editable:boolean; authenticated:boolean; ko:boolean;
    onLaunch:()=>void; canLaunch:boolean; choice:GameId|'auto';
}) {
    const [invalid,setInvalid]=useState<Record<string,boolean>>({});
    const total=members.reduce((n,c)=>n+c.agent.rounds,0)*ARCADE_TICKET_COST;
    const valid=members.every(c=>!invalid[c.id]);
    // An outing whose allowance is more than the balance stops at the first round it cannot pay; warn before signing.
    const short=giwa.balance!==null&&members.length>0&&Number(giwa.balance)<total;
    return <section id="arcade-allowance" className="arc-giwa-allowance" ref={ref} tabIndex={-1} aria-labelledby="allowance-heading">
        <span className="arc-overline">{ko?'용돈 쥐여 보내기':'SEND THEM OUT'}</span>
        <h2 id="allowance-heading">{ko?'다녀와, 우리 친구!':'Off on a little adventure'}</h2>
        <p>{ko?'용돈과 놀이를 정하면 화면을 닫아도 계속해요. 돌아오면 모험첩을 펼쳐 보세요.':'Set their allowance and games. They keep going after you leave. Come back to their stories.'}</p>
        <div className="arc-allowance-balance"><span>{ko?'스마트 계정 잔액':'Smart-account balance'}</span><strong>{giwa.balance??'—'} {MOCK_USDC.symbol}</strong><a className="arc-inline-link" href={faucetHintUrl(ko?'ko':'en','musdc')}>{FAUCET_HINT[ko?'ko':'en'].action}<ExternalLink size={14} aria-hidden="true"/></a></div>
        <div className="arc-friend-allowances">{members.map(c=>{
            const active=giwa.jobs.some(j=>activeGuardianOuting(j,c.nft));
            return <div className="arc-friend-allowance" key={c.id}><div className="arc-friend-identity"><GuardianAvatar appearance={c.appearance} color={c.color} portrait/><div><strong>{c.name}</strong><small>{active?(ko?'외출 기록에서 확인해요':'Check their outing below'):`${c.appearance?`${GUARDIAN_NAMES[ko?'ko':'en'][c.appearance.zodiac]} · `:''}${TEMPERAMENT_NAMES[ko?'ko':'en'][c.temperament]}`}</small></div></div>
                <AllowanceAmount name={c.name} value={c.agent.rounds} disabled={!editable||active||giwa.busy} ko={ko} onChange={n=>onAmountChange(c.id,n)} onValidityChange={ok=>setInvalid(v=>v[c.id]===!ok?v:{...v,[c.id]:!ok})}/></div>;
        })}</div>
        {!members.length&&<p>{ko?'함께할 친구를 먼저 골라 주세요.':'Choose a friend first.'}</p>}
        <p className="arc-allowance-summary"><b>{ko?`이번 외출 최대 ${total} ${MOCK_USDC.symbol}`:`Up to ${total} ${MOCK_USDC.symbol}`}</b><small>{ko?'빠른 자동 진행 · 1회 1 mUSDC · 권한은 2시간 뒤 만료':'Fast automatic rounds · 1 mUSDC each · Permission expires in 2 hours'}</small></p>
        {short&&<p role="status" className="arc-notice arc-allowance-short"><CircleAlert size={16} aria-hidden="true"/>{ko?`잔액이 이번 외출 최대 ${total} ${MOCK_USDC.symbol}보다 적어요. 테스트 토큰을 먼저 받으면 끝까지 다녀와요.`:`Your balance is below this outing’s ${total} ${MOCK_USDC.symbol}. Get test tokens first so they can finish.`}</p>}
        {!giwa.available&&<p role="status" className="arc-notice">{ko?'자동 외출은 잠시 준비 중이에요. 직접 연습은 무료로 즐길 수 있어요.':'Away outings are currently unavailable. You can still practice for free.'}</p>}
        {giwa.error&&<p role="alert" className="arc-notice">{giwa.error}</p>}
        {giwa.busy && giwa.phase !== 'idle'?<AllowanceProgress phase={giwa.phase} walletName={giwa.walletName} target={giwa.approvalTarget} ko={ko}/>:<button className="arc-button arc-approve-button" disabled={giwa.busy||!canLaunch||!valid||!authenticated} onClick={()=>{if(giwa.submission)onLaunch();else void giwa.approve(members.map(c=>({...c.nft,goal:c.agent.goal,name:guardianName(c.nft.tokenId,'ko'),admissions:c.agent.rounds})),choice);}}>{giwa.busy?(ko?'외출 상태 확인 중…':'Checking outing…'):giwa.submission?(ko?'외출 요청 확인':'Recover outing request'):(ko?'승인하고 놀러 보내기':'Approve and send')}<ArrowRight size={18}/></button>}
        <p className="arc-allowance-guard"><ShieldCheck size={16}/>{ko?'잔액은 내 스마트 계정에 있어요. 서명한 한도만 사용할 수 있어요.':'Funds stay in your smart account. Only your signed allowance can be spent.'}</p>
        <Link className="arc-inline-link" {...arcadeSectionLink('wallet',ko?'ko':'en')}>{ko?'승인 기록과 회수는 지갑·승인에서':'Approvals and revocation live in Wallet'}<ArrowRight size={14} aria-hidden="true"/></Link>
    </section>;
}
