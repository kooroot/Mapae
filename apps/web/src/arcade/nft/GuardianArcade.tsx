import {useRef} from 'react';
import {Check,ExternalLink,RefreshCw} from 'lucide-react';
import type {AgentGoal,GameId} from '@mapae/arcade';
import {explorerTxUrl} from '../../lib/config';
import {GiwaAllowance} from '../GiwaAllowance';
import {OutingBoard} from '../OutingBoard';
import {GAME_NAMES} from '../game-names';
import {newArcadeState} from '../state';
import type {GuardianDesk} from './useGuardianDesk';
import {dailyObjective} from './model';
import {BrandSelect} from '../../components/BrandSelect';
import {ArcadeRevocations} from '../ArcadeRevocations';
import type {ArcadeSubsection} from '../sections';
import {DeskGate,NftStatus,SectionHeading} from '../sections/SectionFrame';
import './nft.css';

/** Outings, journal and wallet while they still share one page: the daily outing, strategy, allowance, growth and the away journal. */
export function GuardianArcade({section,desk,walletWaiting}:{section:ArcadeSubsection;desk:GuardianDesk;walletWaiting:boolean}){
    const {ko,locale,session,giwa,nft,token,member,traits,activeJob,crew,now}=desk,nftIdentity=desk.identity,active=!!activeJob,op=desk.operation,updateOp=desk.setOperation;
    const allowance=useRef<HTMLElement>(null),names=GAME_NAMES[locale];
    const detail=nft.detail?.guardian.tokenId===token?.tokenId?nft.detail:null;
    const objective=dailyObjective(detail?.results??[],now);
    const games=['stamp','race','shop'] as const,refreshing=nft.loading||nft.busy;
    const presentation={...newArcadeState(),characters:crew,selectedCharacterId:member?.id??null};
    return <div className="nft-arcade">
        <SectionHeading section={section} desk={desk}/>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="session">
        <NftStatus desk={desk}/>
        {member&&traits&&token&&<><div className="nft-operations"><div className="nft-operations-main">
            <section className="nft-panel nft-daily"><div><span className="arc-overline">{objective.day} · DAILY</span><h2>{objective.completed?(ko?'오늘의 외출 완료!':'Today’s outing complete!'):(ko?`오늘은 ${names[objective.game]}에 도전해요`:`Today, try ${names[objective.game]}`)}</h2><p>{ko?'한국 시간 자정에 새 놀이가 열려요. 전령의 강점과 다른 작전도 시험해 보세요.':'A new destination each midnight in Korea. Try another strategy with your guardian.'}</p></div><button className="arc-button" disabled={!!active||giwa.busy} onClick={()=>{updateOp({game:objective.game});allowance.current?.scrollIntoView({block:'center'});}}>{ko?'오늘의 작전 준비':'Prepare today’s outing'}</button></section>
            <section className="nft-panel"><span className="arc-overline">{ko?'작전':'STRATEGY'}</span><h2>{member.name}</h2><div className="nft-controls"><label>{ko?'이번 목표':'Objective'}<BrandSelect<AgentGoal> tone="paper" label={ko?'이번 목표':'Objective'} value={op.goal} disabled={!!active||giwa.busy} onValueChange={goal=>updateOp({goal})} options={[{value:'explore',label:ko?'새 경험 쌓기':'Explore'},{value:'score',label:ko?'최고 기록 도전':'Chase a record'},{value:'save',label:ko?'차분하게 운영':'Play carefully'}]}/></label><label>{ko?'보낼 놀이':'Destination'}<BrandSelect<GameId|'auto'> tone="paper" label={ko?'보낼 놀이':'Destination'} value={op.game} disabled={!!active||giwa.busy} onValueChange={game=>updateOp({game})} options={[{value:'auto',label:ko?'전령이 선택':'Agent chooses'},...games.map(g=>({value:g,label:names[g]}))]}/></label></div></section></div>
            <GiwaAllowance ref={allowance} giwa={giwa} members={nftIdentity?[{...member,nft:nftIdentity}]:[]} onAmountChange={(_,admissions)=>updateOp({admissions})} editable={!nft.busy&&!active} authenticated={session.ready} ko={ko} choice={op.game} canLaunch={!nft.busy&&!giwa.busy&&(!!giwa.submission||giwa.available&&!active)} onLaunch={()=>void giwa.recoverSubmission()}/></div>
            <section className="nft-growth" aria-labelledby="nft-growth-title"><h2 id="nft-growth-title">{ko?'모험이 쌓이는 전령':'A guardian with a story'}</h2><div className="nft-growth-stats"><div><span>{ko?'NFT에 기록한 경험치':'Experience recorded on NFT'}</span><strong>{token.progress.experience} XP</strong><small>{ko?'레벨':'Level'} {token.progress.level} · {token.progress.victories} {ko?'승리':'victories'}</small></div><div><span>{ko?'검증된 모험 전체':'All verified adventures'}</span>{detail?<><strong>{detail.earned.experience} XP</strong><small>{ko?`${detail.earned.plays}회 모험`:`${detail.earned.plays} outings`}{detail.results.some(r=>!r.claimed)&&(ko?' · 아래에서 성장 기록':' · Record growth below')}</small></>:nft.error&&!nft.loading?<><strong className="nft-stat-missing">{ko?'불러오지 못했어요':'Unavailable'}</strong><button className="arc-text-button" disabled={refreshing} onClick={()=>void nft.refresh()}><RefreshCw size={16} aria-hidden="true"/>{ko?'다시 불러오기':'Retry'}</button></>:<strong className="nft-stat-missing" role="status">{ko?'불러오는 중…':'Loading…'}</strong>}</div></div>
            <div className="nft-results">{detail?.results.length===0&&<p>{ko?'첫 번째 외출을 보내 모험 기록을 시작해 보세요.':'Send your first outing to begin this story.'}</p>}{detail?.results.map(r=><article key={r.id} className="nft-result"><div><strong>{names[r.game]} · {r.score.toLocaleString()} {ko?'점':'pts'}</strong><p>{r.victory?(ko?'목표 달성 · +15 XP':'Achievement · +15 XP'):(ko?'모험 완료 · +10 XP':'Completed · +10 XP')}</p><small>{new Date(r.at).toLocaleString(locale)} · {r.outcome.summary[locale]}</small>{r.transaction&&<a href={explorerTxUrl(r.transaction)} target="_blank" rel="noreferrer">{ko?'입장 결제 영수증':'Admission receipt'}<ExternalLink size={13} aria-hidden="true"/></a>}</div>{r.claimed?<span className="nft-result-claimed"><Check size={14} aria-hidden="true"/>{ko?'NFT 기록 완료':'Recorded on NFT'}</span>:<button className="arc-button arc-button-paper" disabled={nft.busy||giwa.busy||!!nft.transaction} onClick={()=>void nft.claim(r)}>{ko?'NFT에 성장 기록':'Record growth on NFT'}</button>}</article>)}</div>{detail?.nextCursor&&<button className="arc-button arc-button-paper nft-more" onClick={()=>void nft.more()}>{ko?'이전 모험 더 보기':'More adventures'}</button>}<p className="nft-small">{ko?'성장 기록에는 테스트 ETH 네트워크 수수료가 필요해요. 실패해도 같은 모험을 다시 기록하며, 입장권을 새로 사지 않아요.':'Recording growth uses test ETH for gas. Retry the same result if it fails; no new admission is purchased.'}</p></section>
        </>}
        <OutingBoard giwa={giwa} demo={presentation} ko={ko} onOpen={()=>{}}/>
        {!member&&giwa.grants.length>0&&<section className="arc-queue-panel"><ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked}/></section>}
        {giwa.submission&&!member&&<section className="nft-panel"><p>{ko?'전송했던 외출 요청이 남아 있어요. 새 서명 없이 같은 요청을 확인하세요.':'An outing submission is pending. Recover the same request without signing again.'}</p><button className="arc-button" disabled={giwa.busy} onClick={()=>void giwa.recoverSubmission()}>{ko?'외출 요청 복구':'Recover outing submission'}</button></section>}
        </DeskGate>
    </div>;
}
