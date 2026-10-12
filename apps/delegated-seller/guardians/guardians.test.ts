import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverTypedDataAddress,type Address,type Hex,type Log} from 'viem';
import {emptyHonors,guardianHonorFromJson,guardianHonorsOf,guardianTraitsHash,guardianResultFromJson,guardianResultDomain,GUARDIAN_CLAIM_BATCH,GUARDIAN_HONOR_TYPES,GUARDIAN_RESULT_TYPES,type GuardianHonors,type GuardianSnapshot} from '@mapae/arcade/guardians';
import {runArcadeSimulation} from '@mapae/arcade/simulation';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';
import {kstDay,kstWeek,rankedSeed} from '@mapae/arcade/ranking';
import {MOCK_USDC} from '@mapae/shared';
import {TRANSFER_EVENT_TOPIC} from '@mapae/delegation';
import {ARCADE_PAY_TO} from '@mapae/arcade/tickets';
import {OutingStore} from '../outings/store';
import {OutingRunner} from '../outings/runner';
import {createGuardianApp} from './routes';
import {createGuardianClaims,createGuardianReader,readGuardianConfig,type GuardianClient} from './runtime';
import {emptyProgress,type GuardianReader,type GuardianToken} from './types';
import {resultView} from './ledger';

const owner=privateKeyToAccount(`0x${'11'.repeat(32)}`).address, agent=privateKeyToAccount(`0x${'22'.repeat(32)}`).address;
const receiver=privateKeyToAccount(`0x${'33'.repeat(32)}`).address, collection='0x5555555555555555555555555555555555555555' as Address;
const payer='0x1234567890123456789012345678901234567890' as Address, seed=`0x${'77'.repeat(32)}` as Hex;
const tx=`0x${'44'.repeat(32)}` as Hex, blockHash=`0x${'55'.repeat(32)}` as Hex;
const env={ARCADE_OUTINGS_ENABLED:'true',ARCADE_GUARDIAN_ADDRESS:collection,ARCADE_RESULT_PRIVATE_KEY:`0x${'88'.repeat(32)}`,ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`};
const config=readGuardianConfig(env)!, now=2_000_000_000_000;
const snapshot=(tokenId='1'):GuardianSnapshot=>({chainId:91342,collection,tokenId,owner,ownershipEpoch:'1',seed,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION});
const token=(tokenId='1'):GuardianToken=>({tokenId,owner,ownershipEpoch:'1',seed,sequence:'1',revealed:true,progress:emptyProgress(),honors:emptyHonors()});
const noHonors={honor:()=>null};
const reader:GuardianReader={collection,inspect:async id=>snapshot(id),token:async id=>token(id),claimed:async()=>false,
    roster:async()=>({enabled:true,chainId:91342,collection,signer:config.signer.address,mintFee:'1',minted:1,pendingTokenId:null,guardians:[token()]})};
const stores:OutingStore[]=[],dirs:string[]=[];
afterEach(()=>{for(const s of stores.splice(0)){try{s.close();}catch{}}for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function store(path=':memory:'){const s=new OutingStore(path);stores.push(s);return s;}
function insert(s:OutingStore,id='guardian-outing-1',tokenId='1'){
    return s.insert(owner,{id,tokenId,goal:'explore',choice:'stamp',locale:'ko',admissions:1,permissionContext:'0xabcd'},
        {payer,expiresAt:now+7200_000,contextHash:`0x${Buffer.from(id).toString('hex').padEnd(64,'0')}`},agent,now,snapshot(tokenId));
}
async function complete(s:OutingStore,id='guardian-outing-1',tokenId='1',transaction=tx){
    const j=insert(s,id,tokenId);
    await new OutingRunner(s,agent,{async pay(_j,_p,persist){persist('durable-private-header');return transaction;}},reader,()=>now).tick();
    const result=s.get(j.id)!.results[0];expect(result).toBeDefined();return s.guardians.get(result!.id)!;
}
const logs=[{address:MOCK_USDC.address,topics:[TRANSFER_EVENT_TOPIC,`0x${payer.slice(2).padStart(64,'0')}`,`0x${ARCADE_PAY_TO.slice(2).toLowerCase().padStart(64,'0')}`],data:`0x${(1000000n).toString(16).padStart(64,'0')}`}] as Log[];
function client(changes:Record<string,unknown>={}):GuardianClient{
    return {getChainId:async()=>91342,readContract:async()=>config.signer.address,
        getTransactionReceipt:async()=>({status:'success',logs,blockNumber:10n,blockHash}),
        getBlock:async()=>({number:20n,hash:blockHash}),...changes} as unknown as GuardianClient;
}

describe('permanent authoritative growth',()=>{
    test('durable history and cursor pages outlive both 24-job and 40-profile windows',async()=>{
        const s=store();
        for(let i=1;i<=45;i++) await complete(s,`history-job-${String(i).padStart(3,'0')}`,'1',`0x${i.toString(16).padStart(64,'0')}`);
        expect(s.list(owner)).toHaveLength(24);expect(s.guardians.progress(collection,'1').plays).toBe(45);
        const first=s.guardians.list(collection,'1'),second=s.guardians.list(collection,'1',s.guardians.cursor(first.at(-1)!.result.resultId));
        expect(first).toHaveLength(40);expect(second).toHaveLength(5);
        expect(new Set([...first,...second].map(r=>r.result.resultId)).size).toBe(45);
    });
    test('atomic ledger survives reopen and history truncation with exact typed inputs',async()=>{
        const dir=mkdtempSync(join(tmpdir(),'guardian-results-'));dirs.push(dir);const path=join(dir,'seller.sqlite'),s=store(path);
        const row=await complete(s),id=row.result.resultId;
        expect(row.result).toMatchObject({actor:owner,tokenId:'1',ownershipEpoch:'1',paymentTx:tx,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION,game:0});
        expect(row.inputs).toContain('"aptitudes"');expect(row.inputs).not.toContain('durable-private-header');
        expect(s.guardians.progress(collection,'1').plays).toBe(1);s.close();
        const next=store(path);expect(next.guardians.get(id)).toEqual(row);
        next.result('guardian-outing-1',row.outcome,now);
        expect(next.guardians.progress(collection,'1').plays).toBe(1);
        expect(()=>next.result('guardian-outing-1',{...row.outcome,seed:99},now)).toThrow('conflict');
        expect(next.guardians.metrics(0)).toEqual({operators:1,completedAdmissions:1,paymentTransactions:1,victories:Number(row.result.victory)});
    });
    test('same payment across jobs rolls back result and job advancement together',async()=>{
        const s=store();await complete(s);
        const j=insert(s,'guardian-outing-2','2');
        await new OutingRunner(s,agent,{async pay(_j,_p,persist){persist('second');return tx;}},reader,()=>now).tick();
        expect(s.get(j.id)?.spent).toBe(0);expect(s.get(j.id)?.error).toBe('simulation_failed');
        expect(s.guardians.progress(collection,'2').plays).toBe(0);expect(s.guardians.metrics(0).completedAdmissions).toBe(1);
    });
    test('missing typed achievement cannot award growth',async()=>{
        const s=store(),j=insert(s);
        await new OutingRunner(s,agent,{async pay(_j,_p,p){p('paid');return tx;}},reader,()=>now,input=>{
            const outcome=runArcadeSimulation(input);delete outcome.achievement;return outcome;
        }).tick();
        expect(s.get(j.id)?.status).toBe('paused');expect(s.guardians.progress(collection,'1').plays).toBe(0);
    });
    test('shop memory comes only from verified token results',async()=>{
        const s=store(),j=insert(s);expect(j.shopMemory).toBeUndefined();j.choice='shop';s.save(j);
        await new OutingRunner(s,agent,{async pay(_j,_p,p){p('shop-once');return tx;}},reader,()=>now).tick();
        const completed=s.get(j.id)!;expect(completed.status).toBe('complete');
        const memory=completed.results[0]!.outcome.shopMemory;expect(memory).toBeDefined();
        const next=insert(s,'guardian-shop-next','1');expect(next.shopMemory).toEqual(memory);

    });
});
describe('canonical safe payment before attestation',()=>{
    const sig=(claim:{result:Parameters<typeof guardianResultFromJson>[0];signature:Hex})=>recoverTypedDataAddress({domain:guardianResultDomain(collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:guardianResultFromJson(claim.result),signature:claim.signature});
    test('safe receipt persists evidence and the batch recovers the dedicated typed signer',async()=>{
        const s=store(),row=await complete(s),claim=createGuardianClaims(config,s.guardians,reader,noHonors,client());
        const first=await claim(owner,'1'),second=await claim(owner,'1');
        expect(second).toEqual(first);expect(first.claims).toHaveLength(1);expect(first.claims[0]!.result).toEqual(row.result);
        expect(await sig(first.claims[0]!)).toBe(config.signer.address);
        expect(s.guardians.get(row.result.resultId)?.evidence).toEqual({blockNumber:'10',blockHash});
        expect(s.guardians.progress(collection,'1').plays).toBe(1);
    });
    test('a batch is the oldest unclaimed results, capped at one contract batch, never another guardian',async()=>{
        const s=store();
        for(let i=0;i<34;i++)await complete(s,`guardian-outing-${i}`,'1',`0x${i.toString(16).padStart(64,'a')}` as Hex);
        await complete(s,'other-guardian-outing','2',`0x${'bb'.repeat(32)}` as Hex);
        const claimedTx=new Set<string>([`0x${(0).toString(16).padStart(64,'a')}`]);
        const batch=await createGuardianClaims(config,s.guardians,{...reader,claimed:async tx=>claimedTx.has(tx)},noHonors,client())(owner,'1');
        expect(batch.claims).toHaveLength(GUARDIAN_CLAIM_BATCH);
        expect(batch.claims.every(c=>c.result.tokenId==='1')).toBe(true);
        expect(batch.claims[0]!.result.paymentTx).toBe(`0x${(1).toString(16).padStart(64,'a')}`);
        expect(s.guardians.unclaimed(collection,'1')).toHaveLength(33);
    });
    test('a spent time budget returns the claims signed so far, never an empty batch',async()=>{
        const s=store();
        for(let i=0;i<3;i++)await complete(s,`guardian-outing-${i}`,'1',`0x${i.toString(16).padStart(64,'a')}` as Hex);
        const batch=await createGuardianClaims(config,s.guardians,reader,noHonors,client(),0)(owner,'1');
        expect(batch.claims).toHaveLength(1);expect(batch.claims[0]!.result.paymentTx).toBe(`0x${(0).toString(16).padStart(64,'a')}`);
    });
    test('wrong chain and missing safe head fail; unsafe, orphaned, reverted and wrong Transfer wait unsigned',async()=>{
        const s=store(),row=await complete(s);
        for(const c of [client({getChainId:async()=>1}),client({getBlock:async()=>{throw Error('safe not supported');}})])
            await expect(createGuardianClaims(config,s.guardians,reader,noHonors,c)(owner,'1')).rejects.toThrow();
        for(const c of [
            client({getBlock:async()=>({number:9n,hash:blockHash})}),
            client({getBlock:async()=>({number:20n,hash:tx})}),
            client({getTransactionReceipt:async()=>({status:'reverted',logs,blockNumber:10n,blockHash})}),
            client({getTransactionReceipt:async()=>({status:'success',logs:[],blockNumber:10n,blockHash})}),
        ])expect((await createGuardianClaims(config,s.guardians,reader,noHonors,c)(owner,'1')).claims).toEqual([]);
        expect(s.guardians.get(row.result.resultId)?.signature).toBeNull();
    });
    test('only the current owner batches, including results the previous owner earned',async()=>{
        const s=store(),row=await complete(s),transferred={...reader,token:async()=>({...token(),owner:receiver,ownershipEpoch:'2'})};
        const claim=createGuardianClaims(config,s.guardians,transferred,noHonors,client());
        const batch=await claim(receiver,'1');
        expect(batch.claims[0]!.result.ownershipEpoch).toBe('1');expect(batch.claims[0]!.result.actor).toBe(owner);
        for(const stranger of [owner,agent])await expect(claim(stranger,'1')).rejects.toThrow('not_found');
        expect(resultView(row,receiver,false).transaction).toBeNull();expect(resultView(row,receiver,false).actor).toBeNull();
        expect(resultView(row,owner,false).transaction).toBe(tx);
    });
    test('a confirmed claim is marked once and never signed again; signer mismatch closes',async()=>{
        const s=store(),row=await complete(s);let reads=0;
        const confirmed={...reader,claimed:async()=>{reads++;return true;}};
        expect((await createGuardianClaims(config,s.guardians,confirmed,noHonors,client())(owner,'1')).claims).toEqual([]);
        expect(s.guardians.get(row.result.resultId)?.claimed).toBe(true);expect(s.guardians.get(row.result.resultId)?.signature).toBeNull();
        await createGuardianClaims(config,s.guardians,confirmed,noHonors,client())(owner,'1');expect(reads).toBe(1);
        await expect(createGuardianClaims(config,s.guardians,reader,noHonors,client({readContract:async()=>agent}))(owner,'1')).rejects.toThrow('guardian_unavailable');
    });
    test('key rotation reissues the exact immutable payload, never another earned result',async()=>{
        const s=store();await complete(s);
        const before=(await createGuardianClaims(config,s.guardians,reader,noHonors,client())(owner,'1')).claims[0]!;
        const next=readGuardianConfig({...env,ARCADE_RESULT_PRIVATE_KEY:`0x${'99'.repeat(32)}`})!;
        const after=(await createGuardianClaims(next,s.guardians,reader,noHonors,client({readContract:async()=>next.signer.address}))(owner,'1')).claims[0]!;
        expect(after.result).toEqual(before.result);expect(after.signature).not.toBe(before.signature);
        expect(s.guardians.progress(collection,'1').plays).toBe(1);
    });
});
describe('signed honors ride the same batch',()=>{
    const sealed:GuardianHonors={week:2961,longestStreak:7,titles:[{champion:1,podium:0,top10:2},{champion:0,podium:3,top10:0},{champion:4,podium:0,top10:5}]};
    const book=(value:GuardianHonors|null=sealed)=>({honor:()=>value});
    const onChain=(honors:GuardianHonors,revealed=true)=>({...reader,token:async()=>({...token(),honors,revealed})});
    test('a newer sealed honor that raises a lane is signed by the result signer as the contract Honor',async()=>{
        const s=store(),batch=await createGuardianClaims(config,s.guardians,reader,book(),client())(owner,'1');
        expect(batch.claims).toEqual([]);
        expect(batch.honor?.honor).toEqual({tokenId:'1',week:2961,longestStreak:7,titles:String(0x500000004000000030000000200000001n)});
        expect(await recoverTypedDataAddress({domain:guardianResultDomain(collection),types:GUARDIAN_HONOR_TYPES,primaryType:'Honor',message:guardianHonorFromJson(batch.honor!.honor),signature:batch.honor!.signature}))
            .toBe(config.signer.address);
    });
    test('no honor when the NFT already holds the week, nothing would rise, nothing is sealed, or the token is unrevealed',async()=>{
        const s=store();
        for(const [r,b] of [[onChain(sealed),book()],[onChain({...sealed,week:2960}),book()],[onChain({...sealed,week:2960,longestStreak:9}),book({...sealed,longestStreak:3})],
            [reader,book(null)],[onChain(emptyHonors(),false),book()]] as const)
            expect((await createGuardianClaims(config,s.guardians,r,b,client())(owner,'1')).honor).toBeNull();
        // A newer week that raises just one lane is worth a claim; the contract keeps the other lanes' maxima.
        expect((await createGuardianClaims(config,s.guardians,onChain({...sealed,week:2960}),book({...sealed,longestStreak:8}),client())(owner,'1')).honor?.honor.week).toBe(2961);
    });
    test('the signed honor carries the lane-wise maxima, never a lane below the NFT',async()=>{
        const chain:GuardianHonors={week:2960,longestStreak:9,titles:[{champion:2,podium:0,top10:0},{champion:0,podium:0,top10:0},{champion:0,podium:0,top10:6}]};
        const signed=(await createGuardianClaims(config,store().guardians,onChain(chain),book(),client())(owner,'1')).honor!;
        expect(guardianHonorsOf(guardianHonorFromJson(signed.honor))).toEqual({week:2961,longestStreak:9,
            titles:[{champion:2,podium:0,top10:2},{champion:0,podium:3,top10:0},{champion:4,podium:0,top10:6}]});
        expect(await recoverTypedDataAddress({domain:guardianResultDomain(collection),types:GUARDIAN_HONOR_TYPES,primaryType:'Honor',message:guardianHonorFromJson(signed.honor),signature:signed.signature}))
            .toBe(config.signer.address);
    });
    test('an attached honor takes one place in the batch and survives a spent results budget',async()=>{
        const s=store();
        for(let i=0;i<34;i++)await complete(s,`guardian-outing-${i}`,'1',`0x${i.toString(16).padStart(64,'a')}` as Hex);
        const full=await createGuardianClaims(config,s.guardians,reader,book(),client())(owner,'1');
        expect(full.claims).toHaveLength(GUARDIAN_CLAIM_BATCH-1);expect(full.honor).not.toBeNull();
        const rushed=await createGuardianClaims(config,s.guardians,reader,book(),client(),0)(owner,'1');
        // With an honor in hand a spent budget stops before the first result, so the batch still returns in time.
        expect(rushed.claims).toHaveLength(0);expect(rushed.honor?.honor.week).toBe(2961);
        expect((await createGuardianClaims(config,s.guardians,reader,noHonors,client(),0)(owner,'1')).claims).toHaveLength(1);
    });
    test('the owner-only detail carries the seller sealed totals next to the NFT honors',async()=>{
        const s=store(),bridge='private-bridge-token'.repeat(3),headers={Authorization:`Bearer ${bridge}`,'X-Mapae-Owner':owner};
        const detail=async(honors?:{honor:()=>GuardianHonors|null})=>(await createGuardianApp({token:bridge,reader,ledger:s.guardians,...(honors?{honors}:{})}).request('/1',{headers})).json() as Promise<{honors:unknown;guardian:{honors:unknown}}>;
        expect(await detail(book())).toMatchObject({honors:sealed,guardian:{honors:emptyHonors()}});
        expect((await detail()).honors).toBeNull();
        expect((await createGuardianApp({token:bridge,reader,ledger:s.guardians,honors:book()}).request('/1',{headers:{...headers,'X-Mapae-Owner':receiver}})).status).toBe(404);
    });
});
describe('guardian chain runtime and routes',()=>{
    test('result key requires a separate unfunded role and collection',()=>{
        expect(readGuardianConfig({})).toBeNull();
        for(const patch of [{ARCADE_GUARDIAN_ADDRESS:''},{ARCADE_RESULT_PRIVATE_KEY:''},{ARCADE_RESULT_PRIVATE_KEY:env.ARCADE_AGENT_PRIVATE_KEY},{PRIVATE_KEY:env.ARCADE_RESULT_PRIVATE_KEY},{GUARDIAN_DEPLOYER_PRIVATE_KEY:env.ARCADE_RESULT_PRIVATE_KEY},{GUARDIAN_DEPLOYER_ADDRESS:config.signer.address},{BOOTSTRAP_ADDRESS:config.signer.address}])
            expect(()=>readGuardianConfig({...env,...patch})).toThrow();
        expect(readGuardianConfig(env)?.signer.address).not.toBe(agent);
    });
    test('reader binds all token reads to a single block and rejects pending reveal',async()=>{
        let revealed=true;const calls:unknown[]=[];
        const c=client({readContract:async(v:{functionName:string;blockNumber:bigint})=>{
            calls.push(v);switch(v.functionName){
                case'ownerOf':return owner;case'ownershipEpoch':return 1n;case'birth':return[seed,1n,revealed];
                case'progress':return{plays:0n,victories:0n,experience:0n,gamePlays:[0n,0n,0n],gameVictories:[0n,0n,0n],bestScores:[0,0,0],
                    honorWeek:2961,longestStreak:7,champion:[1,0,4],podium:[0,3,0],top10:[2,0,5]};
                case'balanceOf':case'mintedBy':case'mintFee':return 1n;case'pendingMint':return 0n;case'resultSigner':return config.signer.address;case'tokensOfOwner':return[1n];case'claimedPayments':return false;
            }throw Error('unexpected getter');}});
        const chain=createGuardianReader(config,c);expect(await chain.inspect('1')).toEqual(snapshot());
        expect((await chain.token('1')).honors).toEqual({week:2961,longestStreak:7,titles:[{champion:1,podium:0,top10:2},{champion:0,podium:3,top10:0},{champion:4,podium:0,top10:5}]});
        expect(calls.every(v=>(v as {blockNumber:bigint}).blockNumber===20n)).toBe(true);
        expect((await chain.roster(owner)).guardians).toHaveLength(1);
        revealed=false;await expect(chain.inspect('1')).rejects.toThrow('guardian_unavailable');
    });
    test('private roster/details/claims expose neither bearer nor permission context',async()=>{
        const s=store(),row=await complete(s),bridge='private-bridge-token'.repeat(3);
        const app=createGuardianApp({token:bridge,reader,ledger:s.guardians,claim:createGuardianClaims(config,s.guardians,reader,noHonors,client())});
        const headers={Authorization:`Bearer ${bridge}`,'X-Mapae-Owner':owner};
        expect((await app.request('/')).status).toBe(401);
        expect((await app.request('/',{headers:{...headers,Authorization:'Bearer bad'}})).status).toBe(401);
        const detail=await app.request('/1',{headers});expect(detail.status).toBe(200);expect(await detail.text()).not.toContain('durable-private-header');
        expect((await app.request('/1',{headers:{...headers,'X-Mapae-Owner':receiver}})).status).toBe(404);
        const claims=await app.request('/1/claims',{method:'POST',headers});expect(claims.status).toBe(200);
        expect((await claims.json<{claims:{result:{resultId:string}}[]}>()).claims[0]!.result.resultId).toBe(row.result.resultId);
        expect((await app.request('/01/claims',{method:'POST',headers})).status).toBe(400);
        expect((await app.request('/1/claims',{method:'POST',headers:{...headers,'X-Mapae-Owner':receiver}})).status).toBe(404);
        expect((await app.request('/1?before=-1',{headers})).status).toBe(400);
    });
});
describe('ranked rows ride the settled-result transaction',()=>{
    const day=kstDay(now);
    test('a ranked result writes its board row and the detail view carries the attempt',async()=>{
        const s=store(),row=await complete(s);
        expect(row.outcome.ranked).toEqual({day,attempt:1});expect(row.outcome.seed).toBe(rankedSeed('stamp',day,1,'1'));
        const ranked=s.db.query<Record<string,unknown>,[]>('SELECT * FROM arcade_guardian_ranked').all();
        expect(ranked).toEqual([{result_id:row.result.resultId.toLowerCase(),collection:collection.toLowerCase(),token_id:'1',guardian_seed:seed,ruleset:ARCADE_RULESET_VERSION,
            game:'stamp',day,week:kstWeek(day),attempt:1,score:row.result.score,victory:Number(row.result.victory),created_at:now}]);
        const bridge='private-bridge-token'.repeat(3),app=createGuardianApp({token:bridge,reader,ledger:s.guardians});
        const detail=await (await app.request('/1',{headers:{Authorization:`Bearer ${bridge}`,'X-Mapae-Owner':owner}})).json() as {results:{ranked?:unknown}[]};
        expect(detail.results[0]!.ranked).toEqual({day,attempt:1});
    });
    test('a result whose attempt or seed disagrees with the pending admission is refused with nothing written',async()=>{
        for(const change of [{ranked:{day,attempt:2}},{ranked:undefined},{seed:rankedSeed('stamp',day,2,'1')}]){
            const s=store(),j=insert(s);
            const runner=new OutingRunner(s,agent,{async pay(_j,_p,persist){persist('mismatch');return tx;}},reader,()=>now);
            const original=s.result.bind(s);
            s.result=(id,result,at)=>original(id,{...result,...change},at);
            await runner.tick();
            expect(s.get(j.id)?.error).toBe('simulation_failed');expect(s.guardians.progress(collection,'1').plays).toBe(0);
            expect(s.db.query('SELECT 1 FROM arcade_guardian_ranked').all()).toHaveLength(0);
        }
    });
    test('a pending admission settled without ranking (an older deploy, or a fourth round) lists without a board row',async()=>{
        const s=store(),j=insert(s);j.pending={game:'stamp',seed:5,header:'legacy-pending',transaction:tx};s.save(j);
        await new OutingRunner(s,agent,{async pay(){throw Error('must not pay again');}},reader,()=>now).tick();
        const listed=s.guardians.list(collection,'1');expect(listed).toHaveLength(1);expect(listed[0]!.outcome.ranked).toBeUndefined();
        expect(resultView(listed[0]!,owner,false)).not.toHaveProperty('ranked');
        expect(s.db.query('SELECT 1 FROM arcade_guardian_ranked').all()).toHaveLength(0);
    });
});
