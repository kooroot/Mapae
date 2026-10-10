import {useEffect,useRef,useState} from 'react';
import {Check,CircleAlert,Clock,ExternalLink,Gamepad2,LoaderCircle,Pause,RefreshCw} from 'lucide-react';
import {formatEther,type Address} from 'viem';
import type {AgentGoal,GameId} from '@mapae/arcade';
import {guardianTraits} from '@mapae/arcade/guardians';
import {dailyChallenge} from '@mapae/arcade/challenge';
import {useLocale} from '../../lib/locale';
import {explorerAddressUrl,explorerTxUrl} from '../../lib/config';
import {logoutProfile} from '../profile/client';
import {useArcadeSession} from '../useArcadeSession';
import {SessionAccess} from '../SessionAccess';
import {useGiwaTickets} from '../useGiwaTickets';
import {GiwaAllowance} from '../GiwaAllowance';
import {OutingBoard} from '../OutingBoard';
import {GuardianAvatar} from '../GuardianAvatar';
import {GUARDIAN_NAMES} from '../guardian';
import {GAME_NAMES} from '../game-names';
import {newArcadeState} from '../state';
import {useGuardians} from './useGuardians';
import {dailyObjective,nftCompanion,TEMPERAMENT_NAMES} from './model';
import {GuardianHeader} from './GuardianHeader';
import {BrandSelect} from '../../components/BrandSelect';
import {NftPractice} from './NftPractice';
import type {GuardianToken} from '../profile/guardians';
import {trackEngagement} from '../engagement/client';
import {ArcadeRevocations} from '../ArcadeRevocations';
import {activeGuardianOuting} from './outing-model';
import {TransactionRecovery} from './TransactionRecovery';
import {swapScreen,useArcadeMotion} from '../motion';
import '../arcade.css';import '../agent-arcade.css';import '../arcade-brand.css';import './nft.css';

type Operation={goal:AgentGoal;game:GameId|'auto';admissions:number};
export function GuardianArcade({owner,initialGame,onGuest}:{owner:Address;initialGame:GameId|'auto';onGuest?:()=>void}){
    const {locale}=useLocale(),ko=locale==='ko',session=useArcadeSession(owner),giwa=useGiwaTickets(locale,session.ready),nft=useGuardians(owner,session.ready,ko),still=useArcadeMotion(false);
    const [operations,setOperations]=useState<Record<string,Operation>>({}),[practice,setPractice]=useState<{token:GuardianToken;game:GameId;seed:number}|null>(null),[now,setNow]=useState(Date.now),[disconnecting,setDisconnecting]=useState(false);
    const allowance=useRef<HTMLElement>(null),names=GAME_NAMES[locale];
    useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(t);},[]);
    const token=nft.roster?.guardians.find(t=>t.tokenId===nft.selected),key=token?`${nft.roster?.collection}:${token.tokenId}:${token.ownershipEpoch}`:'';
    const nftIdentity=token&&nft.roster?.collection?{tokenId:token.tokenId,ownershipEpoch:token.ownershipEpoch,collection:nft.roster.collection}:null;
    const activeJob=nftIdentity?giwa.jobs.find(j=>activeGuardianOuting(j,nftIdentity)):undefined,active=!!activeJob;
    const op=activeJob?{goal:activeJob.profile.goal,game:activeJob.choice,admissions:activeJob.admissions}:operations[key]??{goal:'explore',game:initialGame,admissions:1};
    function updateOp(patch:Partial<Operation>){trackEngagement({event:'operator_action',locale});setOperations(v=>({...v,[key]:{...op,...patch}}));}
    const member=token?.revealed?nftCompanion(token,op.goal,op.admissions):null,traits=token?.revealed?guardianTraits(token.seed):null;
    const detail=nft.detail?.guardian.tokenId===token?.tokenId?nft.detail:null;
    const objective=dailyObjective(detail?.results??[],now);
    const crew=(nft.roster?.guardians??[]).filter(t=>t.revealed).map(t=>nftCompanion(t));
    const games=['stamp','race','shop'] as const,refreshing=nft.loading||nft.busy;
    const refreshButton=(label:string)=><button className="arc-text-button" disabled={refreshing} onClick={()=>void nft.refresh()}><RefreshCw size={16} className={nft.loading?'arc-loading-icon':undefined} aria-hidden="true"/>{nft.loading?(ko?'불러오는 중…':'Refreshing…'):label}</button>;
    const drawStatus=nft.roster&&nft.roster.minted>=3?{icon:<Check size={15}/>,label:ko?'이번 지갑의 뽑기 완료':'Wallet draw limit reached'}:nft.roster?.pendingTokenId?{icon:<Clock size={15}/>,label:ko?'진행 중인 뽑기 확인':'Draw in progress'}:nft.paused?{icon:<Pause size={15}/>,label:ko?'뽑기 잠시 준비 중':'Draws currently paused'}:null;
    const presentation={...newArcadeState(),characters:crew,selectedCharacterId:member?.id??null};
    async function disconnect(){setDisconnecting(true);try{await logoutProfile(owner);}finally{giwa.disconnect();setDisconnecting(false);}}
    if(!session.ready)return <SessionAccess owner={owner} session={session} ko={ko} disconnecting={disconnecting} onDisconnect={()=>void disconnect()} onGuest={onGuest}/>;
    if(practice)return <NftPractice {...practice} ko={ko} reducedMotion={still} onClose={()=>swapScreen(still,()=>setPractice(null))}/>;
    return <main className="arcade agent-arcade nft-arcade">
        <GuardianHeader owner={owner} ko={ko} network={ko?'GIWA SEPOLIA · 전령단':'GIWA SEPOLIA · GUARDIANS'} disconnecting={disconnecting} blocked={giwa.busy||nft.busy} onDisconnect={()=>void disconnect()}/>
        <div className="arc-main">
        <section className="nft-intro"><span className="arc-overline">MY MAPAE GUARDIANS</span><h1>{ko?'작은 전령, 커지는 모험.':'Little guardians. Growing adventures.'}</h1><p>{ko?'나만의 전령을 뽑고, 용돈과 작전을 맡겨보세요. 다녀온 모험이 전령의 이력이 됩니다.':'Draw your guardian, choose a strategy and set an allowance. Every verified outing becomes part of their story.'}</p>{onGuest&&<button className="arc-button arc-button-paper" onClick={onGuest}><Gamepad2 size={18} aria-hidden="true"/>{ko?'무료로 직접 한 판':'Play a free round'}</button>}</section>
        {nft.error&&<div className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true"/><p>{nft.error}</p>{refreshButton(ko?'다시 불러오기':'Retry')}</div>}
        {nft.busy&&<p role="status" className="arc-notice nft-notice is-info"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true"/>{nft.phase}</p>}
        {nft.transaction&&<TransactionRecovery transaction={nft.transaction} busy={nft.busy} ko={ko} onCheck={nft.checkTransaction}/>}
        {nft.roster&&!nft.roster.enabled?<section className="nft-panel"><h2>{ko?'전령단이 곧 문을 열어요':'Guardians are preparing to arrive'}</h2><p>{ko?'지금은 무료 게임을 즐길 수 있어요. NFT 뽑기는 준비가 끝나면 열립니다.':'Play the free games while NFT draws are being prepared.'}</p>{onGuest&&<button className="arc-button" onClick={onGuest}>{ko?'무료로 플레이':'Play for free'}</button>}</section>:<>
        <section className="nft-roster" aria-labelledby="nft-roster-title"><div className="nft-section-heading"><div><span className="arc-overline">01 / {ko?'나의 전령단':'MY GUARDIANS'}</span><h2 id="nft-roster-title">{ko?'함께할 친구를 골라요':'Choose your companion'}</h2></div><div className="nft-section-tools"><span>{nft.roster?.guardians.length??0} / 3 {ko?'보유':'owned'}</span>{refreshButton(ko?'새로고침':'Refresh')}</div></div>
            <div className="nft-roster-grid">{nft.roster?.guardians.map(t=>{const c=t.revealed?nftCompanion(t):null;return <button key={t.tokenId} className={`nft-token ${t.tokenId===nft.selected?'is-selected':''}`} aria-pressed={t.tokenId===nft.selected} onClick={()=>void nft.select(t.tokenId)}>{c?<GuardianAvatar appearance={c.appearance} color={c.color} portrait/>:<div className="nft-pending-art" aria-hidden="true">封</div>}<strong>#{t.tokenId}{c?.appearance&&` · ${GUARDIAN_NAMES[locale][c.appearance.zodiac]}`}</strong><span>{t.revealed?`${ko?'레벨':'Level'} ${t.progress.level} · ${t.progress.plays}${ko?'회 모험':' outings'}`:ko?'탄생을 기다리는 중':'Waiting to reveal'}</span></button>;})}
            {(nft.roster?.guardians.length??0)<3&&<div className="nft-draw"><span className="nft-draw-symbol" aria-hidden="true">✦</span><h3>{ko?'새 전령 만나기':'Meet a new guardian'}</h3><p>{ko?'외형·성향·적성이 함께 정해져요. 적성의 총합은 모두 같아요.':'Appearance, temperament and aptitudes are drawn together. Every aptitude total is equal.'}</p>{drawStatus?<p className="nft-draw-status" role="status">{drawStatus.icon}{drawStatus.label}</p>:<button className="arc-button" disabled={!nft.roster?.enabled||nft.busy||giwa.busy||!!nft.transaction} onClick={()=>void nft.mint()}>{ko?'온체인으로 전령 뽑기':'Draw a guardian onchain'}</button>}<small>{nft.roster?.mintFee?`${formatEther(BigInt(nft.roster.mintFee))} test ETH + ${ko?'네트워크 수수료':'network fee'}`:'—'}<br/>{ko?`지갑당 평생 3회 · ${nft.roster?.minted??0}/3회 사용`:`3 lifetime draws per wallet · ${nft.roster?.minted??0}/3 used`}</small></div>}</div>
            {nft.roster?.collection&&<a className="arc-inline-link" href={explorerAddressUrl(nft.roster.collection)} target="_blank" rel="noreferrer">{ko?'NFT 계약 확인':'View NFT collection'}<ExternalLink size={14} aria-hidden="true"/></a>}
        </section>
        {token&&!token.revealed&&<section className="nft-panel" role="status"><h2>{ko?'전령의 탄생을 기다리고 있어요':'Your guardian is on the way'}</h2><p>{ko?`#${token.tokenId} · 뽑기 요청 ${token.sequence}. 이 요청의 결과는 한 번만 정해져요. 화면을 닫아도 이어서 확인할 수 있어요.`:`#${token.tokenId} · Request ${token.sequence}. This request reveals once. You can close the page and return.`}</p><div className="nft-panel-actions"><button className="arc-button" disabled={nft.busy} onClick={()=>void nft.refresh()}>{ko?'결과 다시 확인':'Check reveal'}</button><button className="arc-button arc-button-paper" disabled={nft.busy||!!nft.transaction} onClick={()=>void nft.recover(token)}>{ko?'같은 뽑기 결과 복구':'Recover this same draw'}</button></div><small>{ko?'복구는 같은 난수 증명을 다시 전달하며, 새 뽑기가 아니에요. 네트워크 수수료가 필요할 수 있어요.':'Recovery submits the same randomness proof. It may require a network fee.'}</small></section>}
        {member&&traits&&token&&<><div className="nft-operations"><div className="nft-operations-main"><section className="nft-panel"><span className="arc-overline">{ko?'타고난 재능':'BORN THIS WAY'}</span><h2>#{token.tokenId} · {GUARDIAN_NAMES[locale][traits.zodiac]}</h2><p>{TEMPERAMENT_NAMES[locale][traits.temperament]}</p><div className="nft-aptitudes">{games.map(g=><div key={g}><span>{names[g]}</span><meter min={0} max={6} value={traits.aptitudes[g]} aria-label={`${names[g]} ${traits.aptitudes[g]} / 6`}/><b>{traits.aptitudes[g]} / 6</b></div>)}</div><p className="nft-small">{ko?'외형과 타고난 특성은 바뀌지 않아요. 작전은 내가 정해요.':'Birth traits stay fixed. You choose the strategy.'}</p>
            <div className="nft-controls"><label>{ko?'이번 목표':'Objective'}<BrandSelect<AgentGoal> tone="paper" label={ko?'이번 목표':'Objective'} value={op.goal} disabled={!!active||giwa.busy} onValueChange={goal=>updateOp({goal})} options={[{value:'explore',label:ko?'새 경험 쌓기':'Explore'},{value:'score',label:ko?'최고 기록 도전':'Chase a record'},{value:'save',label:ko?'차분하게 운영':'Play carefully'}]}/></label><label>{ko?'보낼 놀이':'Destination'}<BrandSelect<GameId|'auto'> tone="paper" label={ko?'보낼 놀이':'Destination'} value={op.game} disabled={!!active||giwa.busy} onValueChange={game=>updateOp({game})} options={[{value:'auto',label:ko?'전령이 선택':'Agent chooses'},...games.map(g=>({value:g,label:names[g]}))]}/></label></div>
            <div className="nft-practice-pick"><h3>{ko?'무료로 작전 연습':'Practice your strategy'}</h3><div className="nft-practice-links">{games.map(g=><button className="nft-practice-game" key={g} onClick={()=>swapScreen(still,()=>setPractice({token,game:g,seed:dailyChallenge(g,now).seed}))}><strong>{names[g]}</strong><small>{ko?'적성':'Aptitude'} {traits.aptitudes[g]}/6 · {ko?'무료 연습':'Free practice'} →</small></button>)}</div></div></section>
            <section className="nft-panel nft-daily"><div><span className="arc-overline">{objective.day} · DAILY</span><h2>{objective.completed?(ko?'오늘의 외출 완료!':'Today’s outing complete!'):(ko?`오늘은 ${names[objective.game]}에 도전해요`:`Today, try ${names[objective.game]}`)}</h2><p>{ko?'한국 시간 자정에 새 놀이가 열려요. 전령의 강점과 다른 작전도 시험해 보세요.':'A new destination each midnight in Korea. Try another strategy with your guardian.'}</p></div><button className="arc-button" disabled={!!active||giwa.busy} onClick={()=>{updateOp({game:objective.game});allowance.current?.scrollIntoView({block:'center'});}}>{ko?'오늘의 작전 준비':'Prepare today’s outing'}</button></section></div>
            <GiwaAllowance ref={allowance} giwa={giwa} members={nftIdentity?[{...member,nft:nftIdentity,label:`#${token.tokenId} · ${GUARDIAN_NAMES[locale][traits.zodiac]}`}]:[]} onAmountChange={(_,admissions)=>updateOp({admissions})} editable={!nft.busy&&!active} authenticated={session.ready} ko={ko} choice={op.game} canLaunch={!nft.busy&&!giwa.busy&&(!!giwa.submission||giwa.available&&!active)} onLaunch={()=>void giwa.recoverSubmission()}/></div>
            <section className="nft-growth" aria-labelledby="nft-growth-title"><h2 id="nft-growth-title">{ko?'모험이 쌓이는 전령':'A guardian with a story'}</h2><div className="nft-growth-stats"><div><span>{ko?'NFT에 기록한 경험치':'Experience recorded on NFT'}</span><strong>{token.progress.experience} XP</strong><small>{ko?'레벨':'Level'} {token.progress.level} · {token.progress.victories} {ko?'승리':'victories'}</small></div><div><span>{ko?'검증된 모험 전체':'All verified adventures'}</span>{detail?<><strong>{detail.earned.experience} XP</strong><small>{ko?`${detail.earned.plays}회 모험`:`${detail.earned.plays} outings`}{detail.results.some(r=>!r.claimed)&&(ko?' · 아래에서 성장 기록':' · Record growth below')}</small></>:nft.error&&!nft.loading?<><strong className="nft-stat-missing">{ko?'불러오지 못했어요':'Unavailable'}</strong>{refreshButton(ko?'다시 불러오기':'Retry')}</>:<strong className="nft-stat-missing" role="status">{ko?'불러오는 중…':'Loading…'}</strong>}</div></div>
            <div className="nft-results">{detail?.results.length===0&&<p>{ko?'첫 번째 외출을 보내 모험 기록을 시작해 보세요.':'Send your first outing to begin this story.'}</p>}{detail?.results.map(r=><article key={r.id} className="nft-result"><div><strong>{names[r.game]} · {r.score.toLocaleString()} {ko?'점':'pts'}</strong><p>{r.victory?(ko?'목표 달성 · +15 XP':'Achievement · +15 XP'):(ko?'모험 완료 · +10 XP':'Completed · +10 XP')}</p><small>{new Date(r.at).toLocaleString(locale)} · {r.outcome.summary[locale]}</small>{r.transaction&&<a href={explorerTxUrl(r.transaction)} target="_blank" rel="noreferrer">{ko?'입장 결제 영수증':'Admission receipt'}<ExternalLink size={13} aria-hidden="true"/></a>}</div>{r.claimed?<span className="nft-result-claimed"><Check size={14} aria-hidden="true"/>{ko?'NFT 기록 완료':'Recorded on NFT'}</span>:<button className="arc-button arc-button-paper" disabled={nft.busy||giwa.busy||!!nft.transaction} onClick={()=>void nft.claim(r)}>{ko?'NFT에 성장 기록':'Record growth on NFT'}</button>}</article>)}</div>{detail?.nextCursor&&<button className="arc-button arc-button-paper nft-more" onClick={()=>void nft.more()}>{ko?'이전 모험 더 보기':'More adventures'}</button>}<p className="nft-small">{ko?'성장 기록에는 테스트 ETH 네트워크 수수료가 필요해요. 실패해도 같은 모험을 다시 기록하며, 입장권을 새로 사지 않아요.':'Recording growth uses test ETH for gas. Retry the same result if it fails; no new admission is purchased.'}</p></section>
        </>}
        </>}
        <OutingBoard giwa={giwa} demo={presentation} ko={ko} onOpen={()=>{}}/>
        {!member&&giwa.grants.length>0&&<section className="arc-queue-panel"><ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked}/></section>}
        {giwa.submission&&!member&&<section className="nft-panel"><p>{ko?'전송했던 외출 요청이 남아 있어요. 새 서명 없이 같은 요청을 확인하세요.':'An outing submission is pending. Recover the same request without signing again.'}</p><button className="arc-button" disabled={giwa.busy} onClick={()=>void giwa.recoverSubmission()}>{ko?'외출 요청 복구':'Recover outing submission'}</button></section>}
        <footer className="arc-footer"><p>{ko?'작은 자유, 분명한 한도.':'A little freedom. A clear limit.'}</p><span>GIWA SEPOLIA · {ko?'테스트 토큰 사용':'TEST TOKENS'}</span></footer>
        </div>
    </main>;
}
