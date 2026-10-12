import {afterEach,expect,test} from 'bun:test';
import {privateKeyToAccount} from 'viem/accounts';
import {encodePacked,keccak256,toHex,type Address,type Hex} from 'viem';
import {emptyHonors,guardianHonorFromJson,guardianHonorJson,guardianName,guardianResultDomain,GUARDIAN_HONOR_TYPES,GUARDIAN_RESULT_TYPES,guardianResultFromJson,guardianTraitsHash,type GuardianHonors} from '@mapae/arcade/guardians';
import type {GuardianClaimBatch,GuardianToken,VerifiedResult} from '../profile/guardians';
import {nftCompanion,verifiedClaims,pendingGrowth,pendingHonors,guardianPortrait,refreshedDetail,verifyReplacement} from './model';
import {assertNftTransactionStorage,saveNftTransaction,readNftTransaction,clearNftTransaction} from './transaction-store';
import {verifyRevelation} from './recovery';
import {activeGuardianOuting} from './outing-model';
import type {OutingView} from '@mapae/arcade/outings';

const owner:Address='0x1111111111111111111111111111111111111111',collection:Address='0x2222222222222222222222222222222222222222';
const account=privateKeyToAccount(toHex(123456n,{size:32}));
const word=(n:number)=>toHex(n,{size:32});
const token:GuardianToken={tokenId:'7',owner,ownershipEpoch:'3',revealed:true,seed:word(42),sequence:'12',progress:{plays:2,victories:1,experience:25,level:1,games:[{plays:1,victories:1,bestScore:200},{plays:1,victories:0,bestScore:50},{plays:0,victories:0,bestScore:0}]},honors:emptyHonors()};
const result:VerifiedResult={id:word(1),tokenId:'7',actor:owner,ownershipEpoch:'1',transaction:word(2),game:'race',seed:123,ruleset:3,score:42,victory:true,claimed:false,at:Date.parse('2026-10-10T03:00:00Z'),outcome:{game:'race',score:42,summary:{ko:'우승',en:'Victory'},metrics:[],transcript:[],ranking:[],achievement:{victory:true},replay:{seed:123,version:3}}};
const claimJson=(patch:Record<string,unknown>={})=>({resultId:result.id as Hex,tokenId:'7',actor:owner,ownershipEpoch:'1',paymentTx:word(2),traitsHash:guardianTraitsHash(token.seed),inputsHash:word(3),ruleset:3,seed:123,game:1,score:42,victory:true,...patch});
const sign=(r:ReturnType<typeof claimJson>)=>account.signTypedData({domain:guardianResultDomain(collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:guardianResultFromJson(r)});
async function signed(...patches:Record<string,unknown>[]):Promise<GuardianClaimBatch>{
    const claims=await Promise.all((patches.length?patches:[{}]).map(async p=>{const r=claimJson(p);return {result:r,signature:await sign(r)};}));
    return {collection,signer:account.address,claims,honor:null};
}
const expected={collection,signer:account.address,token,known:[result]};
test('NFT render traits only follow chain birth; objectives and allowances never reroll them',()=>{
    const a=nftCompanion(token,'ko','explore',1),b=nftCompanion(token,'en','score',8);
    expect(a.id).toBe('nft-7');expect(a.name).toBe(guardianName(7,'ko'));expect(b.name).toBe(guardianName(7,'en'));expect(a.name).not.toContain('#');expect(a.appearance).toEqual(b.appearance);expect(a.color).toBe(b.color);expect(a.temperament).toBe(b.temperament);
    expect(a.appearance?.zodiac).toBe('horse');expect(a.appearance?.wardrobe).toEqual({hat:'gat',outfit:'performer',shoes:'taesahye'});
    expect(b.agent).toEqual({mode:'rules',goal:'score',rounds:8});
    expect(()=>nftCompanion({...token,revealed:false},'ko')).toThrow('pending_reveal');
});
test('a signed batch, including results earned before a transfer, becomes contract arguments; live signer and token are checked',async()=>{
    // The second result is past the loaded page: only its token binding and signature can be checked.
    const batch=await signed({},{resultId:word(5),paymentTx:word(6),ownershipEpoch:'3',game:0,score:7,victory:false});
    const verified=await verifiedClaims(batch,expected);
    expect(verified.results.map(r=>r.ownershipEpoch)).toEqual([1n,3n]);expect(verified.results[0]!.tokenId).toBe(7n);expect(verified.signatures).toEqual(batch.claims.map(c=>c.signature));
    expect(await verifiedClaims({...batch,claims:[]},expected)).toEqual({results:[],signatures:[],honors:[],honorSignatures:[]});
    await expect(verifiedClaims(batch,{...expected,signer:owner})).rejects.toThrow();
    await expect(verifiedClaims(batch,{...expected,collection:owner})).rejects.toThrow();
    await expect(verifiedClaims(batch,{...expected,token:{...token,seed:word(43)}})).rejects.toThrow();
    await expect(verifiedClaims({...batch,claims:[batch.claims[0]!,batch.claims[0]!]},expected)).rejects.toThrow();
    await expect(verifiedClaims({...batch,claims:Array.from({length:33},()=>batch.claims[0]!)},expected)).rejects.toThrow();
});
test('tampered signed claim fields and wrong displayed results never reach transaction construction',async()=>{
    const [claim]=(await signed()).claims;
    for(const patch of [{tokenId:'8'},{resultId:word(4)},{paymentTx:word(4)},{actor:collection},{ownershipEpoch:'4'},{ownershipEpoch:'0'},
        {traitsHash:word(9)},{inputsHash:word(9)},{inputsHash:word(0)},{seed:124},{ruleset:4},{game:0},{score:43},{victory:false}]){
        await expect(verifiedClaims({collection,signer:account.address,claims:[{...claim!,result:{...claim!.result,...patch}}],honor:null},expected)).rejects.toThrow();
    }
    const batch=await signed();
    await expect(verifiedClaims({...batch,claims:[{...claim!,signature:word(1)}]},expected)).rejects.toThrow();
    for(const patch of [{score:99},{ownershipEpoch:'2'},{tokenId:'8'},{claimed:true}])await expect(verifiedClaims(batch,{...expected,known:[{...result,...patch}]})).rejects.toThrow();
});
const sealed:GuardianHonors={week:2961,longestStreak:7,titles:[{champion:1,podium:0,top10:2},{champion:0,podium:3,top10:0},{champion:4,podium:0,top10:5}]};
const signHonor=async(tokenId:string,honors:GuardianHonors,key=account)=>{const honor=guardianHonorJson(tokenId,honors);
    return {honor,signature:await key.signTypedData({domain:guardianResultDomain(collection),types:GUARDIAN_HONOR_TYPES,primaryType:'Honor',message:guardianHonorFromJson(honor)})};};
test('a signed honor joins the same claim; it must be this token, newer, higher and never lower a lane',async()=>{
    const batch={...(await signed()),honor:await signHonor('7',sealed)};
    const verified=await verifiedClaims(batch,expected);
    expect(verified.results).toHaveLength(1);expect(verified.honors).toEqual([guardianHonorFromJson(batch.honor.honor)]);expect(verified.honorSignatures).toEqual([batch.honor.signature]);
    expect((await verifiedClaims({...batch,claims:[]},expected)).honors).toHaveLength(1);
    const onChain=(honors:GuardianHonors)=>({...expected,token:{...token,honors}});
    for(const [b,e] of [
        [{...batch,honor:await signHonor('8',sealed)},expected],
        [batch,onChain(sealed)],
        [batch,onChain({...sealed,week:2960,longestStreak:8})],
        // Raises the streak but would lower a title lane: the signer's totals disagree with the NFT.
        [batch,onChain({...sealed,week:2960,longestStreak:3,titles:[sealed.titles[0]!,sealed.titles[1]!,{...sealed.titles[2]!,top10:6}]})],
        [{...batch,honor:{...batch.honor,honor:{...batch.honor.honor,longestStreak:8}}},expected],
        [{...batch,honor:await signHonor('7',sealed,privateKeyToAccount(toHex(654321n,{size:32})))},expected],
        [{...batch,claims:Array.from({length:32},()=>batch.claims[0]!)},expected],
    ] as const)await expect(verifiedClaims(b,e)).rejects.toThrow();
});
test('pending honors are the new titles and a longer streak, only for a newer week that raises the NFT',()=>{
    expect(pendingHonors(emptyHonors(),sealed)).toEqual({titles:15,longestStreak:7,any:true});
    expect(pendingHonors(emptyHonors(),null)).toEqual({titles:0,longestStreak:null,any:false});
    expect(pendingHonors({...sealed,week:2960,longestStreak:9,titles:[{champion:1,podium:0,top10:1},sealed.titles[1]!,sealed.titles[2]!]},sealed)).toEqual({titles:1,longestStreak:null,any:true});
    expect(pendingHonors({...sealed,week:2960},sealed)).toEqual({titles:0,longestStreak:null,any:false});
    expect(pendingHonors(sealed,{...sealed,longestStreak:9})).toEqual({titles:0,longestStreak:null,any:false});
});
test('pending growth counts the whole verified history against the NFT, never below zero',()=>{
    expect(pendingGrowth(token.progress,{...token.progress,plays:28,experience:405})).toEqual({plays:26,experience:380});
    expect(pendingGrowth({...token.progress,plays:30,experience:500},token.progress)).toEqual({plays:0,experience:0});
});
test('manual recovery verifies original Pyth request commitment without new entropy',()=>{
    const user=word(11),reveal=word(99);let committed=reveal;
    for(let i=0;i<3;i++)committed=keccak256(committed);
    const commitment=keccak256(encodePacked(['bytes32','bytes32'],[keccak256(user),committed]));
    expect(verifyRevelation(user,reveal,3,commitment)).toBe(reveal);
    for(const [u,r,n,c] of [[word(12),reveal,3,commitment],[user,word(98),3,commitment],[user,reveal,2,commitment],[user,reveal,0,commitment],[user,reveal,1001,commitment],[user,'bad',3,commitment],[user,reveal,3,word(9)]] as const)expect(()=>verifyRevelation(u,r,n,c)).toThrow('recovery_proof');
});
test('a board row draws the same portrait from the public seed as the owner sees',()=>{
    const seed=`0x${'ab'.repeat(32)}` as Hex,portrait=guardianPortrait(seed);
    const owned=nftCompanion({...token,seed,revealed:true},'ko');
    expect(portrait.appearance).toEqual(owned.appearance!);expect(portrait.color).toBe(owned.color);
    expect(guardianPortrait(`0x${'cd'.repeat(32)}`).appearance).not.toEqual(portrait.appearance);
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
    const first={guardian:token,earned:token.progress,honors:null,results:[result],nextCursor:'latest'},old={...result,id:word(4)};
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
