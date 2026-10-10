import {afterEach,expect,test} from 'bun:test';
import {privateKeyToAccount} from 'viem/accounts';
import {encodePacked,keccak256,toHex,type Address,type Hex} from 'viem';
import {guardianResultDomain,GUARDIAN_RESULT_TYPES,guardianResultFromJson,guardianTraitsHash} from '@mapae/arcade/guardians';
import type {GuardianClaim,GuardianToken,VerifiedResult} from '../profile/guardians';
import {nftCompanion,verifiedClaim,dailyObjective,refreshedDetail,verifyReplacement} from './model';
import {assertNftTransactionStorage,saveNftTransaction,readNftTransaction,clearNftTransaction} from './transaction-store';
import {verifyRevelation} from './recovery';
import {activeGuardianOuting} from './outing-model';
import type {OutingView} from '@mapae/arcade/outings';

const owner:Address='0x1111111111111111111111111111111111111111',collection:Address='0x2222222222222222222222222222222222222222';
const account=privateKeyToAccount(toHex(123456n,{size:32}));
const word=(n:number)=>toHex(n,{size:32});
const token:GuardianToken={tokenId:'7',owner,ownershipEpoch:'3',revealed:true,seed:word(42),sequence:'12',progress:{plays:2,victories:1,experience:25,level:1,games:[{plays:1,victories:1,bestScore:200},{plays:1,victories:0,bestScore:50},{plays:0,victories:0,bestScore:0}]}};
const result:VerifiedResult={id:word(1),tokenId:'7',actor:owner,ownershipEpoch:'1',transaction:word(2),game:'race',seed:123,ruleset:3,score:42,victory:true,claimed:false,at:Date.parse('2026-10-10T03:00:00Z'),outcome:{game:'race',score:42,summary:{ko:'우승',en:'Victory'},metrics:[],transcript:[],ranking:[],achievement:{victory:true},replay:{seed:123,version:3}}};
async function signed():Promise<GuardianClaim>{
    const r={resultId:result.id as Hex,tokenId:'7',actor:owner,ownershipEpoch:'1',paymentTx:word(2),traitsHash:guardianTraitsHash(token.seed),inputsHash:word(3),ruleset:3,seed:123,game:1,score:42,victory:true};
    const signature=await account.signTypedData({domain:guardianResultDomain(collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:guardianResultFromJson(r)});
    return {collection,signer:account.address,result:r,signature,claimed:false};
}
const expected={collection,signer:account.address,token,result};

test('NFT render traits only follow chain birth; objectives and allowances never reroll them',()=>{
    const a=nftCompanion(token,'explore',1),b=nftCompanion(token,'score',8);
    expect(a.id).toBe('nft-7');expect(a.appearance).toEqual(b.appearance);expect(a.color).toBe(b.color);expect(a.temperament).toBe(b.temperament);
    expect(a.appearance?.zodiac).toBe('horse');expect(a.appearance?.wardrobe).toEqual({hat:'gat',outfit:'performer',shoes:'taesahye'});
    expect(b.agent).toEqual({mode:'rules',goal:'score',rounds:8});
    expect(()=>nftCompanion({...token,revealed:false})).toThrow('pending_reveal');
});
test('signed historical result remains claimable after transfer; display and live signer are checked',async()=>{
    const claim=await signed();const verified=await verifiedClaim(claim,expected);
    expect(verified?.result.ownershipEpoch).toBe(1n);expect(verified?.result.tokenId).toBe(7n);
    expect(await verifiedClaim({...claim,claimed:true,signature:null},expected)).toBeNull();
    await expect(verifiedClaim(claim,{...expected,signer:owner})).rejects.toThrow();
    await expect(verifiedClaim(claim,{...expected,collection:owner})).rejects.toThrow();
    await expect(verifiedClaim(claim,{...expected,token:{...token,seed:word(43)}})).rejects.toThrow();
});
test('tampered signed claim fields and wrong displayed results never reach transaction construction',async()=>{
    const claim=await signed();
    for(const patch of [{tokenId:'8'},{resultId:word(4)},{paymentTx:word(4)},{actor:collection},{ownershipEpoch:'4'},{ownershipEpoch:'0'},
        {traitsHash:word(9)},{inputsHash:word(9)},{inputsHash:word(0)},{seed:124},{ruleset:4},{game:0},{score:43},{victory:false}]){
        await expect(verifiedClaim({...claim,result:{...claim.result,...patch}},expected)).rejects.toThrow();
    }
    await expect(verifiedClaim({...claim,signature:word(1)},expected)).rejects.toThrow();
    await expect(verifiedClaim(claim,{...expected,result:{...result,score:99}})).rejects.toThrow();
    await expect(verifiedClaim(claim,{...expected,result:{...result,ownershipEpoch:'2'}})).rejects.toThrow();
    await expect(verifiedClaim(claim,{...expected,result:{...result,tokenId:'8'}})).rejects.toThrow();
});
test('manual recovery verifies original Pyth request commitment without new entropy',()=>{
    const user=word(11),reveal=word(99);let committed=reveal;
    for(let i=0;i<3;i++)committed=keccak256(committed);
    const commitment=keccak256(encodePacked(['bytes32','bytes32'],[keccak256(user),committed]));
    expect(verifyRevelation(user,reveal,3,commitment)).toBe(reveal);
    for(const [u,r,n,c] of [[word(12),reveal,3,commitment],[user,word(98),3,commitment],[user,reveal,2,commitment],[user,reveal,0,commitment],[user,reveal,1001,commitment],[user,'bad',3,commitment],[user,reveal,3,word(9)]] as const)expect(()=>verifyRevelation(u,r,n,c)).toThrow('recovery_proof');
});
test('daily objective uses Korea midnight and actual matching verified results',()=>{
    const before=Date.parse('2026-10-09T14:59:59Z'),after=before+1000;
    expect(dailyObjective([],before).day).toBe('2026-10-09');expect(dailyObjective([],after).day).toBe('2026-10-10');
    const current=dailyObjective([],after);expect(current.completed).toBe(false);
    expect(dailyObjective([{...result,game:current.game,at:after}],after).completed).toBe(true);
    expect(dailyObjective([{...result,game:current.game,at:before}],after).completed).toBe(false);
});
const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
afterEach(()=>{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');});
test('transaction recovery is scoped by owner and keeps same collection/hash across reload',()=>{
    const map=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)}});
    const tx={owner,collection,kind:'mint' as const,hash:word(21)};saveNftTransaction({...tx,privateKey:'secret',signature:'do-not-store'} as typeof tx);expect([...map.values()][0]).not.toMatch(/secret|privateKey|signature/);
    expect(readNftTransaction(owner)).toEqual(tx);expect(readNftTransaction(collection)).toBeNull();
    clearNftTransaction(collection);expect(readNftTransaction(owner)).toEqual(tx);
    clearNftTransaction(owner);expect(readNftTransaction(owner)).toBeNull();
    map.set(`mapae.guardian-transaction.${owner}`,JSON.stringify({...tx,owner:collection}));expect(()=>readNftTransaction(owner)).toThrow();
});
test('unwritable, occupied or malformed transaction storage blocks a fresh wallet request',()=>{
    const map=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)}});
    expect(()=>assertNftTransactionStorage(owner)).not.toThrow();expect(map.size).toBe(0);
    saveNftTransaction({owner,collection,hash:word(21),kind:'mint',nonce:5});expect(()=>assertNftTransactionStorage(owner)).toThrow('transaction_pending');
    map.set(`mapae.guardian-transaction.${owner}`,'invalid');expect(()=>assertNftTransactionStorage(owner)).toThrow();
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{throw Error('blocked');}}});expect(()=>assertNftTransactionStorage(owner)).toThrow('blocked');
});
test('replacement requires original sender and nonce; loaded history survives polling without carrying across ownership epoch',()=>{
    expect(()=>verifyReplacement(owner,3,{from:owner,nonce:3})).not.toThrow();
    expect(()=>verifyReplacement(owner,3,{from:collection,nonce:3})).toThrow();expect(()=>verifyReplacement(owner,3,{from:owner,nonce:4})).toThrow();
    const first={guardian:token,earned:token.progress,results:[result],nextCursor:'latest'},old={...result,id:word(4)};
    const previous={...first,results:[result,old],nextCursor:null};
    expect(refreshedDetail(previous,{...first,results:[{...result,claimed:true}]})).toEqual({...previous,results:[{...result,claimed:true},old]});
    expect(refreshedDetail(previous,{...first,guardian:{...token,ownershipEpoch:'4'}}).results).toEqual([result]);
});
test('only this token, collection and ownership epoch can block a new outing',()=>{
    const identity={collection,tokenId:'7',ownershipEpoch:'3'};
    const job={status:'running',guardian:{...identity,ownershipEpoch:'1'}} as OutingView;
    expect(activeGuardianOuting(job,identity)).toBe(false);
    expect(activeGuardianOuting({...job,guardian:{...job.guardian,ownershipEpoch:'3'}},identity)).toBe(true);
    expect(activeGuardianOuting({...job,guardian:{...job.guardian,ownershipEpoch:'3',collection:owner}},identity)).toBe(false);
    expect(activeGuardianOuting({...job,status:'complete'},identity)).toBe(false);
});
