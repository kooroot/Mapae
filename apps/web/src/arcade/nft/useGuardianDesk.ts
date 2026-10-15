import {useEffect,useState} from 'react';
import type {Address} from 'viem';
import type {AgentGoal,GameId} from '@mapae/arcade';
import {guardianTraits} from '@mapae/arcade/guardians';
import {useLocale} from '../../lib/locale';
import {logoutProfile} from '../profile/client';
import {useArcadeSession} from '../useArcadeSession';
import {useGiwaTickets} from '../useGiwaTickets';
import {trackEngagement} from '../engagement/client';
import {useGuardians} from './useGuardians';
import {nftCompanion} from './model';
import {activeGuardianOuting} from './outing-model';
import {seasonMarks} from '@mapae/arcade/hall';
import {useRankingStandings,useSeasonHall,useSeasonStatus} from '../ranking/client';

export type Operation={goal:AgentGoal;game:GameId|'auto';admissions:number};
/** Where a visitor stands, from no wallet to a revealed guardian ready to play. */
export type DeskStage='guest'|'pending'|'signin'|'unavailable'|'closed'|'empty'|'waiting'|'ready';
export type GuardianDesk=ReturnType<typeof useGuardianDesk>;

/**
 * The signed-in desk: session, guardians and outings for the gated owner. Call it once per page; the lobby and the guardians tab
 * read the same instance, so polling runs once and the transaction locks stay single.
 */
export function useGuardianDesk(owner:Address|undefined,walletWaiting:boolean,defaultGame:GameId|'auto'){
    const {locale}=useLocale(),ko=locale==='ko';
    const session=useArcadeSession(owner),giwa=useGiwaTickets(locale,owner,session.ready),nft=useGuardians(owner,session.ready,ko);
    const [operations,setOperations]=useState<Record<string,Operation>>({}),[now,setNow]=useState(Date.now),[disconnecting,setDisconnecting]=useState(false);
    const [shown,setShown]=useState(owner);
    if(shown!==owner){setShown(owner);setOperations({});}
    useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(t);},[]);
    const roster=nft.roster;
    const token=roster?.guardians.find(t=>t.tokenId===nft.selected),key=token?`${roster?.collection}:${token.tokenId}:${token.ownershipEpoch}`:'';
    const identity=token&&roster?.collection?{tokenId:token.tokenId,ownershipEpoch:token.ownershipEpoch,collection:roster.collection}:null;
    const activeJob=identity?giwa.jobs.find(j=>activeGuardianOuting(j,identity)):undefined;
    const operation:Operation=activeJob?{goal:activeJob.profile.goal,game:activeJob.choice,admissions:activeJob.admissions}:operations[key]??{goal:'explore',game:defaultGame,admissions:1};
    function setOperation(patch:Partial<Operation>){trackEngagement({event:'operator_action',locale});setOperations(v=>({...v,[key]:{...operation,...patch}}));}
    const member=token?.revealed?nftCompanion(token,locale,operation.goal,operation.admissions):null,traits=token?.revealed?guardianTraits(token.seed):null;
    const revealed=roster?.guardians.filter(t=>t.revealed)??[];
    const crew=revealed.map(t=>nftCompanion(t,locale));
    // Public standings for the revealed crew; a landed round (the crew's result count) refreshes them.
    const ranking=useRankingStandings(revealed.map(t=>t.tokenId),giwa.jobs.reduce((n,j)=>n+j.results.length,0));
    // The season's phase, read once for every section, and its hall of fame once it has closed: the marks a guardian wears come from there.
    const season=useSeasonStatus(),hall=useSeasonHall(season.value);
    const marksOf=(tokenId:string)=>{const t=revealed.find(g=>g.tokenId===tokenId);return t?seasonMarks(hall.value,tokenId,t.seed):[];};
    // Nothing is claimed before it is known: a reconnecting wallet, an unchecked session and an unread roster all read as pending.
    const stage:DeskStage=!owner?walletWaiting?'pending':'guest'
        :session.status==='loading'?'pending'
        :!session.ready?'signin'
        :!roster?nft.error?'unavailable':'pending'
        :!roster.enabled?'closed'
        :!roster.guardians.length?'empty'
        :member?'ready':'waiting';
    async function disconnect(){if(!owner)return;setDisconnecting(true);try{await logoutProfile(owner);}finally{giwa.disconnect();setDisconnecting(false);}}
    return {owner,ko,locale,session,giwa,nft,stage,token,member,traits,identity,activeJob,revealed,crew,operation,setOperation,now,
        ranking:{standings:ranking.value,loading:ranking.loading,error:ranking.error},season,hall,marksOf,
        busy:giwa.busy||nft.busy,disconnecting,disconnect};
}
