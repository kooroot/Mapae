import {useEffect,useRef,useState} from 'react';
import type {ActivityOutcome,GameId} from '@mapae/arcade';
import {guardianTraits} from '@mapae/arcade/guardians';
import {stampOutcome} from '@mapae/arcade/simulation';
import type {GuardianToken} from '../profile/guardians';
import {nftCompanion} from './model';
import {Arena} from '../Arena';
import {RaceGame} from '../race/RaceGame';
import {ShopGame} from '../shop/ShopGame';
import {ArcadeSound} from '../sound';
import {trackEngagement} from '../engagement/client';
import {useResultRitual} from '../result-ritual';
import {swapScreen} from '../motion';
export function NftPractice({token,game,seed,ko,reducedMotion,onClose}:{token:GuardianToken;game:GameId;seed:number;ko:boolean;reducedMotion:boolean;onClose:()=>void}){
    const [result,setResult]=useState<ActivityOutcome|null>(null),[sound]=useState(()=>new ArcadeSound()),[runId]=useState(()=>crypto.randomUUID());
    const locale=ko?'ko' as const:'en' as const,member=nftCompanion(token,locale),ritual=useRef<HTMLElement>(null);
    useResultRitual(ritual,result?runId:null,{tier:reducedMotion?'still':'full',sound});
    useEffect(()=>{trackEngagement({event:'practice_opened',game,runId,locale});return()=>sound.dispose();},[]);
    function complete(outcome:ActivityOutcome){swapScreen(reducedMotion,()=>setResult(outcome));trackEngagement({event:'practice_finished',game,runId,locale,result:'completed'});}
    function close(){if(!result)trackEngagement({event:'practice_finished',game,runId,locale,result:'abandoned'});onClose();}
    const props={appearance:member.appearance,profile:{name:member.name,color:member.color,temperament:member.temperament,goal:member.agent.goal,aptitudes:guardianTraits(token.seed).aptitudes},locale,mode:'human' as const,seed,reducedMotion,sound,onComplete:complete,onExit:close};
    return <main className="arcade nft-practice"><div className="arc-main"><button className="arc-text-button" onClick={close}>← {ko?'전령단으로 돌아가기':'Back to guardians'}</button><p className="arc-overline">{ko?'무료 연습 · NFT 경험치는 지급되지 않아요':'FREE PRACTICE · NO NFT EXPERIENCE'}</p>{result?<section ref={ritual} className="nft-panel nft-practice-result" data-ritual="paper"><div><h1 data-ritual="focus" tabIndex={-1}><span data-ritual="count" data-count={result.score} aria-hidden="true">{result.score.toLocaleString()}</span><span className="sr-only">{result.score.toLocaleString()}</span> {ko?'점':'points'}</h1><span className="arc-result-seal" data-ritual="seal" aria-hidden="true">{ko?'완주':'GG!'}</span></div><p>{ko?'오늘의 작전을 연습했어요. 용돈을 정하고 전령을 보내 검증된 성장 기록을 쌓아보세요.':'Strategy practiced. Send your guardian on a budgeted outing to earn verified growth.'}</p><button className="arc-button" onClick={onClose}>{ko?'전령 운영하기':'Operate guardian'}</button></section>:game==='stamp'?<Arena character={member} locale={locale} sound={sound} reducedMotion={reducedMotion} seed={seed} aptitudes={props.profile.aptitudes} onFinish={g=>complete(stampOutcome(g,member.name,''))}/>:game==='race'?<RaceGame {...props}/>:<ShopGame {...props}/>}</div></main>;
}
