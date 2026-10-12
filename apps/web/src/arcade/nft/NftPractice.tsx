import {useEffect,useRef,useState} from 'react';
import type {ActivityOutcome,GameId} from '@mapae/arcade';
import {guardianTraits} from '@mapae/arcade/guardians';
import {stampOutcome} from '@mapae/arcade/simulation';
import type {GuardianToken} from '../profile/guardians';
import {nftCompanion} from './model';
import {Arena, RaceGame, ShopGame, GameViewport} from '../PracticeGames';
import {ArcadeSound} from '../sound';
import {trackEngagement} from '../engagement/client';
import {useResultRitual} from '../result-ritual';
import {swapScreen} from '../motion';
import {ArrowLeft} from 'lucide-react';
import {localizePath} from '../../lib/i18n';
import {ArcadeBrand} from '../ArcadeBrand';
export function NftPractice({token,game,seed,ko,reducedMotion,returnLabel,onClose}:{token:GuardianToken;game:GameId;seed:number;ko:boolean;reducedMotion:boolean;returnLabel:string;onClose:()=>void}){
    const [result,setResult]=useState<ActivityOutcome|null>(null),[sound]=useState(()=>new ArcadeSound()),[runId]=useState(()=>crypto.randomUUID());
    const locale=ko?'ko' as const:'en' as const,member=nftCompanion(token,locale),ritual=useRef<HTMLElement>(null);
    useResultRitual(ritual,result?runId:null,{tier:reducedMotion?'still':'full',sound});
    useEffect(()=>{trackEngagement({event:'practice_opened',game,runId,locale});return()=>sound.dispose();},[]);
    function complete(outcome:ActivityOutcome){swapScreen(reducedMotion,()=>setResult(outcome));trackEngagement({event:'practice_finished',game,runId,locale,result:'completed'});}
    function close(){if(!result)trackEngagement({event:'practice_finished',game,runId,locale,result:'abandoned'});onClose();}
    const props={appearance:member.appearance,profile:{name:member.name,color:member.color,temperament:member.temperament,goal:member.agent.goal,aptitudes:guardianTraits(token.seed).aptitudes},locale,mode:'human' as const,seed,reducedMotion,sound,onComplete:complete,onExit:close};
    return <main className="arcade nft-practice"><header className="arc-header"><button className="arc-back" onClick={close} aria-label={returnLabel} title={returnLabel}><ArrowLeft size={18} aria-hidden="true"/></button><a className="arc-wordmark" href={localizePath('/',locale)} aria-label={ko?'Mapae 홈':'Mapae home'}><ArcadeBrand/></a></header><div className="arc-main"><p className="arc-overline">{ko?'무료 연습 · NFT 경험치는 지급되지 않아요':'FREE PRACTICE · NO NFT EXPERIENCE'}</p>{result?<section ref={ritual} className="nft-panel nft-practice-result" data-ritual="paper"><div><h1 data-ritual="focus" tabIndex={-1}><span data-ritual="count" data-count={result.score} aria-hidden="true">{result.score.toLocaleString()}</span><span className="sr-only">{result.score.toLocaleString()}</span> {ko?'점':'points'}</h1><span className="arc-result-seal" data-ritual="seal" aria-hidden="true">{ko?'완주':'GG!'}</span></div><p>{ko?'오늘의 작전을 연습했어요. 용돈을 정하고 전령을 보내 검증된 성장 기록을 쌓아보세요.':'Strategy practiced. Send your guardian on a budgeted outing to earn verified growth.'}</p><button className="arc-button" onClick={onClose}>{returnLabel}</button></section>:<GameViewport locale={locale}>{game==='stamp'?<Arena character={member} locale={locale} sound={sound} reducedMotion={reducedMotion} seed={seed} aptitudes={props.profile.aptitudes} onFinish={g=>complete(stampOutcome(g,member.name,''))}/>:game==='race'?<RaceGame {...props}/>:<ShopGame {...props}/>}</GameViewport>}</div></main>;
}
