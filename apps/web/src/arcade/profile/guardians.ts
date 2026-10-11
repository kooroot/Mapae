import {isAddress,isHash,type Address} from 'viem';
import {guardianName,guardianTokenId,guardianTraitsHash} from '@mapae/arcade/guardians';
import type {GuardianRoster,GuardianToken,Progress,VerifiedResult} from '../../../../delegated-seller/guardians/types';
export type {GuardianClaim,GuardianDetail,GuardianRoster,GuardianToken,Progress,VerifiedResult} from '../../../../delegated-seller/guardians/types';

import {isOutcome,projectActivity} from '../activity';
const UPSTREAM='https://seller.mapae.io/arcade/guardians';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uint=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v);
function progress(v:unknown):v is Progress {
    return object(v)&&uint(v.plays)&&uint(v.victories)&&v.victories<=v.plays&&uint(v.experience)&&v.experience===v.plays*10+v.victories*5&&uint(v.level)&&v.level===1+Math.floor(v.experience/100)&&
        Array.isArray(v.games)&&v.games.length===3&&v.games.every(g=>object(g)&&uint(g.plays)&&uint(g.victories)&&g.victories<=g.plays&&uint(g.bestScore)&&g.bestScore<=1_000_000_000);
}
function token(v:unknown):v is GuardianToken {
    return object(v)&&guardianTokenId(v.tokenId)&&typeof v.owner==='string'&&isAddress(v.owner)&&guardianTokenId(v.ownershipEpoch)&&BigInt(v.ownershipEpoch)<1n<<64n&&
        typeof v.seed==='string'&&isHash(v.seed)&&decimal(v.sequence)&&BigInt(v.sequence)<1n<<64n&&typeof v.revealed==='boolean'&&progress(v.progress);
}
function roster(v:unknown):v is GuardianRoster {
    return object(v)&&typeof v.enabled==='boolean'&&v.chainId===91342&&uint(v.minted)&&v.minted<=3&&
        (v.pendingTokenId===null||guardianTokenId(v.pendingTokenId))&&Array.isArray(v.guardians)&&v.guardians.length<=3&&v.guardians.every(token)&&
        (v.enabled?typeof v.collection==='string'&&isAddress(v.collection)&&typeof v.signer==='string'&&isAddress(v.signer)&&decimal(v.mintFee):
            v.collection===null&&v.signer===null&&v.mintFee===null&&v.guardians.length===0);
}
export function validGuardianSnapshot(v:unknown):boolean {
    return object(v)&&v.chainId===91342&&typeof v.collection==='string'&&isAddress(v.collection)&&guardianTokenId(v.tokenId)&&
        typeof v.owner==='string'&&isAddress(v.owner)&&guardianTokenId(v.ownershipEpoch)&&BigInt(v.ownershipEpoch)<1n<<64n&&
        typeof v.seed==='string'&&isHash(v.seed)&&v.traitsHash===guardianTraitsHash(v.seed)&&uint(v.ruleset)&&v.ruleset>=3;
}
const copyProgress=(v:Progress):Progress=>({plays:v.plays,victories:v.victories,experience:v.experience,level:v.level,games:v.games.map(g=>({plays:g.plays,victories:g.victories,bestScore:g.bestScore}))});
const copyToken=(v:GuardianToken):GuardianToken=>({tokenId:v.tokenId,owner:v.owner,ownershipEpoch:v.ownershipEpoch,revealed:v.revealed,seed:v.seed,sequence:v.sequence,progress:copyProgress(v.progress)});
function copyResult(v:unknown,tokenId:string):VerifiedResult {
    if(!object(v)||typeof v.id!=='string'||!isHash(v.id)||v.tokenId!==tokenId||!guardianTokenId(v.ownershipEpoch)||
        !(v.actor===null||typeof v.actor==='string'&&isAddress(v.actor))||!(v.transaction===null||typeof v.transaction==='string'&&isHash(v.transaction))||
        !uint(v.seed)||v.seed>0xffffffff||!uint(v.at)||v.at>8_640_000_000_000_000||!uint(v.ruleset)||v.ruleset<3||
        !uint(v.score)||v.score>1_000_000_000||typeof v.victory!=='boolean'||typeof v.claimed!=='boolean'||
        !isOutcome(v.outcome)||v.outcome.game!==v.game||v.outcome.score!==v.score||v.outcome.replay?.seed!==v.seed||
        v.outcome.replay?.version!==v.ruleset||v.outcome.achievement?.victory!==v.victory)throw Error();
    const outcome=projectActivity({id:v.id,characterId:`nft-${tokenId}`,name:guardianName(tokenId,'ko'),color:'red',game:v.outcome.game,at:v.at,reason:'',source:'practice',mode:'human',ticketId:null,model:null,giwa:null,status:'complete',outcome:v.outcome}).outcome!;
    return {id:v.id,tokenId,actor:v.actor as VerifiedResult['actor'],ownershipEpoch:v.ownershipEpoch,transaction:v.transaction as VerifiedResult['transaction'],game:v.outcome.game,seed:v.seed,at:v.at,ruleset:v.ruleset,score:v.score,victory:v.victory,claimed:v.claimed,outcome};
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export type GuardianDependencies={receiptToken?:string;fetcher?:(url:string,init?:RequestInit)=>Promise<Response>};
/** Caller is profileApi, which already authenticates SIWE, Origin, wallet and rate limits. */
export async function guardiansApi(request:Request,owner:Address,_input:unknown,deps:GuardianDependencies):Promise<Response>{
    const url=new URL(request.url),path=url.pathname, base='/api/arcade/profile/guardians', suffix=path.slice(base.length);
    const detail=/^\/([1-9][0-9]{0,77})$/.exec(suffix), claim=/^\/results\/(0x[0-9a-fA-F]{64})\/claim$/.exec(suffix);
    if(path!==base&&!detail&&!claim)return json({error:{code:'not_found'}},404);
    if((claim&&request.method!=='POST')||(!claim&&request.method!=='GET'))return json({error:{code:'method_not_allowed'}},405);
    const before=url.searchParams.get('before');
    if(url.search&&(!detail||request.method!=='GET'||url.searchParams.size!==1||before===null||!(/^[1-9][0-9]{0,15}$/).test(before)||!Number.isSafeInteger(Number(before))))return json({error:{code:'invalid_request'}},400);
    if(detail&&!guardianTokenId(detail[1]))return json({error:{code:'invalid_request'}},400);
    if(!deps.receiptToken||deps.receiptToken.length<32){
        return suffix===''?json({enabled:false,chainId:91342,collection:null,signer:null,mintFee:null,minted:0,pendingTokenId:null,guardians:[]}):json({error:{code:'disabled'}},503);
    }
    try{
        const response=await(deps.fetcher??fetch)(UPSTREAM+suffix+(before===null?'':`?before=${before}`),{method:request.method,headers:{Authorization:`Bearer ${deps.receiptToken}`,'X-Mapae-Owner':owner.toLowerCase(),Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20_000)});
        if(response.status>=300&&response.status<400)throw Error();
        const reader=response.body?.getReader();if(!reader)throw Error();
        let text='',size=0;const decoder=new TextDecoder();
        for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1_048_576){await reader.cancel();throw Error();}text+=decoder.decode(part.value,{stream:true});}
        const v:unknown=JSON.parse(text+decoder.decode());
        if(!response.ok){
            const codes:Record<string,number>={not_found:404,invalid_request:400,disabled:503,receipt_unconfirmed:409,guardian_unavailable:503};
            const code=object(v)&&object(v.error)&&typeof v.error.code==='string'?v.error.code:'';
            return Object.hasOwn(codes,code)?json({error:{code}},codes[code]):json({error:{code:'guardian_unavailable'}},503);
        }
        if(suffix===''){if(!roster(v)||v.guardians.some(g=>g.owner.toLowerCase()!==owner.toLowerCase())||new Set(v.guardians.map(g=>g.tokenId)).size!==v.guardians.length)throw Error();
            return json({enabled:v.enabled,chainId:v.chainId,collection:v.collection,signer:v.signer,mintFee:v.mintFee,minted:v.minted,pendingTokenId:v.pendingTokenId,guardians:v.guardians.map(copyToken)});}
        else if(detail){
            if(!object(v)||!token(v.guardian)||v.guardian.tokenId!==detail[1]||v.guardian.owner.toLowerCase()!==owner.toLowerCase()||!progress(v.earned)||!Array.isArray(v.results)||v.results.length>40||!(v.nextCursor===null||typeof v.nextCursor==='string'&&/^[1-9][0-9]{0,15}$/.test(v.nextCursor)&&Number.isSafeInteger(Number(v.nextCursor))))throw Error();
            const results=v.results.map(r=>copyResult(r,detail[1]!));if(new Set(results.map(r=>r.id)).size!==results.length)throw Error();
            return json({guardian:copyToken(v.guardian),earned:copyProgress(v.earned),results,nextCursor:v.nextCursor});
        }else{
            if(!object(v)||typeof v.collection!=='string'||!isAddress(v.collection)||typeof v.signer!=='string'||!isAddress(v.signer)||
                typeof v.claimed!=='boolean'||!(v.signature===null||typeof v.signature==='string'&&/^0x[0-9a-fA-F]{130}$/.test(v.signature))||
                !object(v.result)||v.result.resultId?.toString().toLowerCase()!==claim![1]!.toLowerCase()||
                !guardianTokenId(v.result.tokenId)||!guardianTokenId(v.result.ownershipEpoch)||typeof v.result.paymentTx!=='string'||!isHash(v.result.paymentTx)||
                typeof v.result.actor!=='string'||!isAddress(v.result.actor)||typeof v.result.traitsHash!=='string'||!isHash(v.result.traitsHash)||
                typeof v.result.inputsHash!=='string'||!isHash(v.result.inputsHash)||!uint(v.result.ruleset)||!uint(v.result.seed)||
                !uint(v.result.game)||v.result.game>2||!uint(v.result.score)||v.result.score>1_000_000_000||v.result.seed>0xffffffff||v.result.ruleset<3||BigInt(v.result.ownershipEpoch)>=1n<<64n||typeof v.result.victory!=='boolean'||(!v.claimed&&v.signature===null))throw Error();
            const r=v.result;return json({collection:v.collection,signer:v.signer,claimed:v.claimed,signature:v.signature,result:{resultId:r.resultId,tokenId:r.tokenId,actor:r.actor,ownershipEpoch:r.ownershipEpoch,paymentTx:r.paymentTx,traitsHash:r.traitsHash,inputsHash:r.inputsHash,ruleset:r.ruleset,seed:r.seed,game:r.game,score:r.score,victory:r.victory}});
        }
    }catch{return json({error:{code:'guardian_unavailable'}},503);}
}
