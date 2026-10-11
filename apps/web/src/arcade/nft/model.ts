import {guardianName, guardianTraits, guardianTraitsHash, guardianResultDomain, GUARDIAN_CLAIM_BATCH, GUARDIAN_RESULT_TYPES, guardianResultFromJson, type GuardianResult} from '@mapae/arcade/guardians';
import type {AgentGoal} from '@mapae/arcade';
import {isAddress,isHash,recoverTypedDataAddress,type Address,type Hex} from 'viem';
import type {GuardianClaimBatch,GuardianToken,Progress,VerifiedResult} from '../profile/guardians';
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
/**
 * Verifies a signed batch before any wallet request: every entry is this token's, signed by the live result signer, and agrees
 * with the journal row whenever that row is loaded. The contract re-checks all of it; this only refuses to ask for a doomed signature.
 */
export async function verifiedClaims(batch:GuardianClaimBatch,expected:{collection:Address;signer:Address;token:GuardianToken;known:readonly VerifiedResult[]}) {
    if(!sameAddress(batch.collection,expected.collection)||!sameAddress(batch.signer,expected.signer)||batch.claims.length>GUARDIAN_CLAIM_BATCH)throw Error('claim_mismatch');
    const results:GuardianResult[]=[],signatures:Hex[]=[],seen=new Set<string>();
    for(const {result:r,signature} of batch.claims){
        const e=expected.known.find(k=>k.id.toLowerCase()===r.resultId.toLowerCase());
        if(seen.has(r.resultId.toLowerCase())||r.tokenId!==expected.token.tokenId||r.traitsHash!==guardianTraitsHash(expected.token.seed)||
            r.paymentTx===`0x${'0'.repeat(64)}`||r.inputsHash===`0x${'0'.repeat(64)}`||!isHash(r.paymentTx)||!isHash(r.inputsHash)||
            !isAddress(r.actor)||r.actor===`0x${'0'.repeat(40)}`||BigInt(r.ownershipEpoch)<1n||BigInt(r.ownershipEpoch)>BigInt(expected.token.ownershipEpoch)||
            (e&&(e.claimed||e.tokenId!==expected.token.tokenId||r.ownershipEpoch!==e.ownershipEpoch||r.seed!==e.seed||r.ruleset!==e.ruleset||r.score!==e.score||r.victory!==e.victory||['stamp','race','shop'][r.game]!==e.game||
                (e.transaction!==null&&r.paymentTx.toLowerCase()!==e.transaction.toLowerCase())||(e.actor!==null&&!sameAddress(r.actor,e.actor)))))throw Error('claim_mismatch');
        seen.add(r.resultId.toLowerCase());
        const result=guardianResultFromJson(r);
        if(!sameAddress(await recoverTypedDataAddress({domain:guardianResultDomain(expected.collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:result,signature}),expected.signer))throw Error('claim_signature');
        results.push(result);signatures.push(signature);
    }
    return {results,signatures};
}
/** Growth the seller verified but the NFT does not carry yet: the whole history, not just the loaded page. */
export function pendingGrowth(onChain:Progress,earned:Progress){
    return {plays:Math.max(0,earned.plays-onChain.plays),experience:Math.max(0,earned.experience-onChain.experience)};
}
