import {useEffect,useRef,useState} from 'react';
import type {ActivityOutcome} from '@mapae/arcade';
import type {useGiwaTickets} from '../useGiwaTickets';
import type {useArcadeState} from '../useArcadeState';
import {admitActivity,completeActivity,type Activity} from '../activity';
import {gameSeed,withReplay} from '../replay';
import {StampAgent} from '../StampAgent';
import {RaceGame} from '../race/RaceGame';
import {ShopGame} from '../shop/ShopGame';
import {ArcadeSound} from '../sound';
import {modelDecision} from '../agents';

/** Finishes the already-authorized standalone checkout; it cannot create a new admission or NFT growth. */
export function LegacyTicketRecovery({giwa,store,ko}:{giwa:ReturnType<typeof useGiwaTickets>;store:ReturnType<typeof useArcadeState>;ko:boolean}){
    const [activity,setActivity]=useState<Activity|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sound]=useState(()=>new ArcadeSound());
    const lock=useRef(false);useEffect(()=>()=>sound.dispose(),[sound]);
    const pending=giwa.pending;
    const member=store.demo.characters.find(c=>c.id===(activity?.characterId??pending?.characterId));
    async function recover(){if(!pending||!member||lock.current)return;lock.current=true;setBusy(true);setError('');try{
        let record=store.demo.activities.find(a=>a.id===pending.requestId);
        if(!record){const receipt=await giwa.buy(pending.game,pending.requestId,pending.characterId);store.update(v=>{const a=admitActivity(v,{id:pending.requestId,characterId:pending.characterId,game:pending.game,mode:'rules',source:'mapae-giwa',ticketId:receipt.transaction,model:null,reason:ko?'기존 입장권 복구':'Recovered existing admission',giwa:{balanceAfter:receipt.balanceAfter,allowanceAfter:receipt.allowanceAfter}},Date.now());if(!a.ok)throw Error('admission');record=a.activity;return a.demo;});}
        await store.flush();const admitted=await giwa.acknowledge();
        if(record){
            // An admission acknowledged elsewhere must not start a second local game.
            if(!admitted&&record.status==='active'){const next=store.update(v=>completeActivity(v,record!.id,null));record=next.activities.find(a=>a.id===record!.id);await store.flush();}
            if(record)setActivity(record);
        }
    }catch{setError(ko?'같은 입장권 복구를 다시 시도해 주세요.':'Retry recovery of this same admission.');}finally{lock.current=false;setBusy(false);}}
    function complete(outcome:ActivityOutcome){if(!activity)return;const next=store.update(v=>completeActivity(v,activity.id,withReplay(outcome,gameSeed(activity))));setActivity(next.activities.find(a=>a.id===activity.id)??activity);void store.flush().catch(()=>setError(ko?'결과를 저장하지 못했어요. 다시 동기화해 주세요.':'Could not save this result. Retry profile sync.'));}
    if(!pending&&!activity)return null;
    const props=member&&activity?{appearance:member.appearance,profile:{name:member.name,color:member.color,temperament:member.temperament,goal:member.agent.goal},locale:ko?'ko' as const:'en' as const,mode:'rules' as const,seed:gameSeed(activity),budget:{balance:0,allowance:0},decide:modelDecision,reducedMotion:store.demo.reducedMotion,autoAdvance:true,onComplete:complete,onExit:()=>{store.update(v=>completeActivity(v,activity!.id,null));setActivity(null);}}:null;
    return <section className="nft-panel" id="legacy-ticket-recovery"><h2>{ko?'기존 입장권 이어서 확인하기':'Recover an earlier admission'}</h2><p>{ko?'이미 승인했던 입장권만 복구해요. 이 기록은 NFT 성장에 포함되지 않아요.':'Recovers only the earlier authorized admission. It does not award NFT growth.'}</p>{error&&<p role="alert">{error}</p>}{!member?<p role="alert">{ko?'입장권의 이전 캐릭터 기록을 동기화한 뒤 다시 시도해 주세요.':'Sync the original character record before retrying.'}</p>:activity&&activity.status!=='active'?<p role="status">{ko?'입장권 기록을 복구했어요':'Admission record recovered'}{activity.outcome&&` · ${activity.outcome.score}`}</p>:props&&activity?<>{activity.game==='stamp'?<StampAgent {...props} sound={sound}/>:activity.game==='race'?<RaceGame {...props}/>:<ShopGame {...props}/>}</>:<button className="arc-button" disabled={busy||giwa.busy||!store.saved} onClick={()=>void recover()}>{busy?(ko?'확인 중…':'Checking…'):(ko?'기존 입장권 복구':'Recover existing ticket')}</button>}</section>;
}
