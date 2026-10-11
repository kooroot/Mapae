import {guardianName, guardianTraits, guardianTraitsHash, guardianResultDomain, GUARDIAN_RESULT_TYPES, guardianResultFromJson} from '@mapae/arcade/guardians';
import type {AgentGoal} from '@mapae/arcade';
import {isAddress,isHash,recoverTypedDataAddress,type Address,type Hex} from 'viem';
import type {GuardianClaim,GuardianToken,VerifiedResult} from '../profile/guardians';
import type {Color,Companion} from '../state';
import type {Guardian} from '../guardian';

/** In-memory companion for display and play; the name follows the UI locale. Stored and server-validated names use guardianName(tokenId,'ko'). */
export function nftCompanion(token:GuardianToken,locale:'ko'|'en',goal:AgentGoal='explore',rounds=1):Companion {
    if(!token.revealed)throw Error('pending_reveal');
    const t=guardianTraits(token.seed),{appearance}=guardianPortrait(token.seed);
    return {id:`nft-${token.tokenId}`,name:guardianName(token.tokenId,locale),configured:true,color:t.color,temperament:t.temperament,
        appearance,
        agent:{mode:'rules',goal,rounds},best:Math.max(...token.progress.games.map(g=>g.bestScore)),
        bests:{stamp:token.progress.games[0]!.bestScore,race:token.progress.games[1]!.bestScore,shop:token.progress.games[2]!.bestScore}};
}
/** A revealed guardian's portrait from its public birth seed alone: what a leaderboard row can draw for anyone's guardian. */
export function guardianPortrait(seed:Hex):{appearance:Guardian;color:Color} {
    const t=guardianTraits(seed);
    return {color:t.color,appearance:{version:1,seed:seed.slice(2,18),zodiac:t.zodiac,backdrop:t.backdrop,charm:t.charm,wardrobe:{hat:t.hat,outfit:t.outfit,shoes:t.shoes}}};
}
/** Guardian temperament as players read it on the talents card and allowance row. */
export const TEMPERAMENT_NAMES={ko:{curious:'호기심 많은 탐험가',bold:'대담한 도전자',calm:'차분한 전략가'},en:{curious:'Curious explorer',bold:'Bold adventurer',calm:'Calm strategist'}} as const;
export const sameAddress=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function verifyReplacement(owner:Address,nonce:number,replacement:{from:Address;nonce:number}){
    if(!Number.isSafeInteger(nonce)||nonce<0||!sameAddress(owner,replacement.from)||nonce!==replacement.nonce)throw Error('replacement_mismatch');
}
/** Preserve explicitly loaded history while refreshing the newest page and ownership snapshot. */
export function refreshedDetail(previous:import('../profile/guardians').GuardianDetail|null,incoming:import('../profile/guardians').GuardianDetail){
    if(!previous||previous.guardian.tokenId!==incoming.guardian.tokenId||previous.guardian.ownershipEpoch!==incoming.guardian.ownershipEpoch)return incoming;
    const incomingIds=new Set(incoming.results.map(r=>r.id));
    const older=previous.results.filter(r=>!incomingIds.has(r.id));
    return {...incoming,results:[...incoming.results,...older],nextCursor:older.length?previous.nextCursor:incoming.nextCursor};
}
export async function verifiedClaim(claim:GuardianClaim,expected:{collection:Address;signer:Address;token:GuardianToken;result:VerifiedResult}) {
    const r=claim.result,e=expected.result;
    if(!sameAddress(claim.collection,expected.collection)||!sameAddress(claim.signer,expected.signer)||
        r.tokenId!==expected.token.tokenId||e.tokenId!==expected.token.tokenId||r.ownershipEpoch!==e.ownershipEpoch||r.resultId.toLowerCase()!==e.id.toLowerCase()||r.traitsHash!==guardianTraitsHash(expected.token.seed)||
        r.paymentTx===`0x${'0'.repeat(64)}`||r.inputsHash===`0x${'0'.repeat(64)}`||!isHash(r.paymentTx)||!isHash(r.inputsHash)||
        !isAddress(r.actor)||r.actor===`0x${'0'.repeat(40)}`||BigInt(r.ownershipEpoch)<1n||BigInt(r.ownershipEpoch)>BigInt(expected.token.ownershipEpoch)||
        r.seed!==e.seed||r.ruleset!==e.ruleset||r.score!==e.score||r.victory!==e.victory||['stamp','race','shop'][r.game]!==e.game||
        (e.transaction!==null&&r.paymentTx.toLowerCase()!==e.transaction.toLowerCase())||
        (e.actor!==null&&!sameAddress(r.actor,e.actor)))throw Error('claim_mismatch');
    const result=guardianResultFromJson(r);
    if(claim.claimed)return null;
    if(!claim.signature||!sameAddress(await recoverTypedDataAddress({domain:guardianResultDomain(expected.collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:result,signature:claim.signature}),expected.signer))throw Error('claim_signature');
    return {result,signature:claim.signature};
}
