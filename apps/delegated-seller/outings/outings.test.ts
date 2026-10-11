import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient, createWalletClient, custom, http, type Address, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {toMapaeOwnerSmartAccount, prepareRootPermissionSigningRequest, assembleRootPermission} from '@mapae/delegation/signing';
import {buildErc7710PaymentRequirements, encodePaymentRequiredHeader, decodePaymentHeader, giwaSepolia, MOCK_USDC} from '@mapae/shared';
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_TICKET_AMOUNT} from '@mapae/arcade/tickets';
import {TRANSFER_EVENT_TOPIC} from '@mapae/delegation';
import {guardianName,guardianTraitsHash,type GuardianSnapshot} from '@mapae/arcade/guardians';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';
import type {OutingStart, OutingStatus} from '@mapae/arcade/outings';
import {kstDay, kstWeek, rankedSeed} from '@mapae/arcade/ranking';
import {deployment, parseStart, validatePermission} from './validation';
import {OutingStore, publicJob, type Job} from './store';
import {OutingRunner, type OutingPayment} from './runner';
import {createOutingApp} from './routes';
import {readOutingConfig, receiptTransaction, createOutingPayment} from './runtime';

const now = 2_000_000_000_000;
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const agent = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const payer = '0x1234567890123456789012345678901234567890' as Address;
const tx = `0x${'44'.repeat(32)}` as Hex;
const token = 'test-only-outing-bridge-token-123456789';
const profile = {name: '말랑', color: 'jade', temperament: 'curious', goal: 'explore'} as const;
const collection = '0x5555555555555555555555555555555555555555' as Address;
const seed = `0x${'77'.repeat(32)}` as Hex;
const guardian = (tokenId='1',holder=owner.address):GuardianSnapshot => ({chainId:91342,collection,tokenId,owner:holder,ownershipEpoch:'1',seed,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION});
const reader = {inspect: async(tokenId:string) => guardian(tokenId)};
const dirs: string[] = [], stores: OutingStore[] = [];
afterEach(() => {for (const store of stores.splice(0)) {try {store.close();} catch {}} for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true});});
function file() {const dir = mkdtempSync(join(tmpdir(), 'mapae-outings-')); dirs.push(dir); return join(dir, 'seller.sqlite');}
function store(path = file()) {const value = new OutingStore(path); stores.push(value); return value;}
function start(id = 'outing-test-0001', admissions = 2): OutingStart {return {id, tokenId: String([...id].reduce((n,c)=>n*31n+BigInt(c.charCodeAt(0)),0n)%10000n+1n), goal:'explore', locale: 'ko', choice: 'auto', admissions, permissionContext: '0xabcd'};}
function insert(db: OutingStore, id = 'outing-test-0001', admissions = 2): Job {
    return db.insert(owner.address, start(id, admissions), {payer, expiresAt: now + 7200_000, contextHash: `0x${Buffer.from(id).toString('hex').padEnd(64,'0')}`}, agent.address, now, guardian(start(id, admissions).tokenId));
}
const paid: OutingPayment = {async pay(_job, pending, persist) {if (!pending.header) persist('same-secret-header'); return tx;}};
async function signed(overrides: {admissions?: number; recipient?: Address; lifetime?: boolean; delegate?: Address; chainId?: number; duration?: number; before?: number} = {}) {
    const publicClient = createPublicClient({chain: giwaSepolia, transport: http('http://127.0.0.1:1', {retryCount:0})});
    const walletClient = createWalletClient({chain: giwaSepolia, account: owner, transport: custom({request: async () => {throw new Error('No RPC in tests');}})});
    const account = await toMapaeOwnerSmartAccount({publicClient, walletClient, environment: deployment.environment, accountOwner: owner.address});
    const request = prepareRootPermissionSigningRequest({environment: deployment.environment, accountOwnerSmartAccount: account.address,
        delegate: overrides.delegate ?? agent.address, startDate: overrides.before ?? now / 1000 - 1,
        policy: {role: 'vendor-agent', token: MOCK_USDC.address, periodAmount: BigInt(overrides.admissions ?? 2) * ARCADE_TICKET_AMOUNT,
            lifetimeTotalAmount: overrides.lifetime === false ? undefined : BigInt(overrides.admissions ?? 2) * ARCADE_TICKET_AMOUNT,
            periodDurationSeconds: 60, expiresAfterSeconds: overrides.duration ?? 7200, recipient: overrides.recipient ?? ARCADE_PAY_TO}});
    const signature = await owner.signTypedData({...request.typedData, domain: {...request.typedData.domain, chainId: overrides.chainId ?? giwaSepolia.id}});
    return {...start(), permissionContext: assembleRootPermission({role: 'vendor-agent', unsignedDelegation: request.unsignedDelegation, signature, createdAt: now}).permissionContext};
}

describe('restricted ownership and permission', () => {
    test('accepts exactly the owner-signed limited arcade root, offline', async () => {
        const request = await signed();
        const v = await validatePermission(owner.address, request, agent.address, now);
        expect(v.payer).not.toBe(owner.address); expect(v.expiresAt).toBe(now - 1000 + 7200_000);
    });
    test('refuses spoofed owner, delegate, chain, recipient, total, amount and expiry', async () => {
        const valid = await signed();
        await expect(validatePermission(stranger.address, valid, agent.address, now)).rejects.toThrow('invalid_permission');
        for (const params of [{delegate:stranger.address}, {chainId:1}, {recipient:stranger.address}, {lifetime:false}, {admissions:3}, {duration:1800}, {before:now/1000-8000}, {before:now/1000+60}]) {
            await expect(validatePermission(owner.address, await signed(params), agent.address, now)).rejects.toThrow('invalid_permission');
        }
    });
    test('actual payment provider persists its signed leaf before fixed seller dispatch', async () => {
        const request = await signed(), permission = await validatePermission(owner.address, request, agent.address, now);
        const db = store(), job = db.insert(owner.address, request, permission, agent.address, now, guardian(request.tokenId));
        expect(job.profile.name).toBe(guardianName(request.tokenId, 'ko'));
        const pending = {game: 'stamp' as const, seed: 1, header: null, transaction: null};
        const config = readOutingConfig({ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:token,ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`})!;
        let persisted: string | null = null, dispatches = 0;
        const local = (r: Request) => {
            const header = r.headers.get('Payment-Signature');
            if (!header) {
                const body = {x402Version: 2 as const, accepts: [buildErc7710PaymentRequirements({amount:'1000000', payTo:ARCADE_PAY_TO,
                    facilitatorAddresses:[ARCADE_REDEEMER], delegationManager:deployment.environment.DelegationManager})]};
                return Response.json(body, {status:402, headers:{'Payment-Required':encodePaymentRequiredHeader(body)}});
            }
            dispatches++; expect(header).toBe(persisted); expect(decodePaymentHeader(header)).toBeDefined();
            return Response.json({ticket:{shop:{slug:'mapae-arcade'},item:{key:'stamp'},code:'ticket-123',transaction:tx},
                receipt:{transaction:tx,payer:permission.payer,method:'erc7710',network:'eip155:91342',amount:'1',asset:MOCK_USDC.address,payTo:ARCADE_PAY_TO}});
        };
        const logs = [{address:MOCK_USDC.address, topics:[TRANSFER_EVENT_TOPIC,`0x${permission.payer.slice(2).toLowerCase().padStart(64,'0')}`,`0x${ARCADE_PAY_TO.slice(2).toLowerCase().padStart(64,'0')}`], data:`0x${(1000000n).toString(16).padStart(64,'0')}`}];
        const client = {getTransactionReceipt:async()=>({status:'success' as const, logs:logs as import('viem').Log[]})};
        const payment = createOutingPayment(config, local, client);
        expect(await payment.pay(job,pending,header=>{persisted=header;})).toBe(tx);
        expect(dispatches).toBe(1); expect(persisted).not.toBeNull();
        await expect(payment.pay(job,pending,()=>{throw new Error('disk failure');})).rejects.toThrow('payment_unresolved');
        expect(dispatches).toBe(1);
    });
    test('strict body rejects arbitrary profile, memory, zero/fractional cap and oversized context', () => {
        for (const v of [{...start(), owner:owner.address}, {...start(), admissions:0}, {...start(), admissions:1.2}, {...start(), admissions:37}, {...start(), profile:{...profile, goal:'steal'}},
            {...start(), shopMemory:{balance:100}}, {...start(), permissionContext:'0x1'}, {...start(), permissionContext:`0x${'f'.repeat(131074)}`}]) expect(() => parseStart(v)).toThrow('invalid_request');
        expect(parseStart(start())).toEqual(start());
    });
    test('disabled by default; never substitute a funded signer or silently enable malformed flags', () => {
        expect(readOutingConfig({})).toBeNull();
        expect(() => readOutingConfig({ARCADE_OUTINGS_ENABLED:'yes'})).toThrow();
        expect(() => readOutingConfig({ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:token})).toThrow();
        expect(() => readOutingConfig({ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:token,ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`, FACILITATOR_SIGNER_PRIVATE_KEY:`0x${'22'.repeat(32)}`})).toThrow('same account');
        expect(readOutingConfig({ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:token,ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`})?.account.address).toBe(agent.address);
    });
    test('receipt reads follow GIWA_SEPOLIA_RPC_URL like the other services', () => {
        const base = {ARCADE_OUTINGS_ENABLED:'true',ARCADE_RECEIPT_TOKEN:token,ARCADE_AGENT_PRIVATE_KEY:`0x${'22'.repeat(32)}`};
        expect(readOutingConfig(base)?.rpcUrl).toBe('https://sepolia-rpc.giwa.io/');
        expect(readOutingConfig({...base, GIWA_SEPOLIA_RPC_URL:'https://rpc.provider.example/v1/key'})?.rpcUrl).toBe('https://rpc.provider.example/v1/key');
        expect(() => readOutingConfig({...base, GIWA_SEPOLIA_RPC_URL:'http://rpc.provider.example'})).toThrow('HTTPS');
    });
});

describe('durable jobs and uncertain payment', () => {
    test('persists header before dispatch, caps admissions and finishes while browser absent', async () => {
        const db = store(); const job = insert(db, undefined, 3); let calls=0;
        const runner = new OutingRunner(db, agent.address, {async pay(j,p,persist){calls++; persist('durable-secret'); expect(db.get(j.id)?.pending?.header).toBe('durable-secret'); return `0x${calls.toString(16).padStart(64,'0')}` as Hex;}}, reader, () => now);
        for(let i=0;i<5;i++) await runner.tick();
        expect(calls).toBe(3); expect(db.get(job.id)?.status).toBe('complete'); expect(db.get(job.id)?.results.map(r=>r.game)).toEqual(['race','shop','stamp']);
        expect(db.get(job.id)?.spent).toBe(3);
        const body = JSON.stringify(publicJob(db.get(job.id)!));
        for (const secret of ['permissionContext','contextHash','durable-secret','payer','fingerprint']) expect(body).not.toContain(secret);
    });
    test('lost response survives SQLite reopen, pauses, resumes identical header once', async () => {
        const path = file(), db = store(path); const job = insert(db, undefined, 1); let payments=0;
        const first = new OutingRunner(db, agent.address, {async pay(_j,_p,persist){persist('exact-durable-header'); payments++; throw new Error('lost response after charge');}}, reader, () => now);
        await first.tick(); expect(db.get(job.id)?.status).toBe('paused'); db.close();
        const reopened = store(path);
        const resumed = new OutingRunner(reopened, agent.address, {async pay(_j,p,persist){expect(p.header).toBe('exact-durable-header'); return tx;}}, reader, () => now+1000);
        await resumed.tick(); expect(reopened.get(job.id)?.results).toHaveLength(0);
        resumed.control(owner.address, job.id, 'resume'); await resumed.tick();
        expect(reopened.get(job.id)?.status).toBe('complete'); expect(payments).toBe(1);
    });
    test('process crash after dispatch quarantines running job; expired pending can recover', async () => {
        const path=file(), db=store(path), job=insert(db,undefined,1);
        job.status='running'; job.pending={game:'stamp',seed:3,header:'already-dispatched',transaction:null}; db.save(job); db.close();
        const reopened=store(path); const runner=new OutingRunner(reopened,agent.address,paid,reader,()=>now+8000_000);
        await runner.tick(); expect(reopened.get(job.id)?.status).toBe('paused');
        runner.control(owner.address,job.id,'resume'); await runner.tick(); expect(reopened.get(job.id)?.status).toBe('complete');
    });
    test('verified payment saved before simulation crash, resume does not pay again', async () => {
        const db=store(), job=insert(db,undefined,1); let calls=0;
        const pay:OutingPayment={async pay(_j,_p,persist){calls++;persist('once');return tx;}};
        const broken=new OutingRunner(db,agent.address,pay,reader,()=>now,()=>{throw new Error('simulation crash');});
        await broken.tick(); expect(db.get(job.id)?.error).toBe('simulation_failed'); expect(db.get(job.id)?.pending?.transaction).toBe(tx);
        const recovered=new OutingRunner(db,agent.address,pay,reader,()=>now+1); recovered.control(owner.address,job.id,'resume'); await recovered.tick();
        expect(calls).toBe(1); expect(db.get(job.id)?.status).toBe('complete');
    });
    test('stop while charge in flight finishes only that paid game', async () => {
        const db=store(), job=insert(db,undefined,3); let finish!:(v:Hex)=>void, ready!:()=>void, calls=0;
        const started=new Promise<void>(r=>ready=r);
        const runner=new OutingRunner(db,agent.address,{async pay(_j,_p,persist){calls++;persist('inflight');ready();return new Promise<Hex>(r=>finish=r);}},reader,()=>now);
        const tick=runner.tick(); await started; runner.control(owner.address,job.id,'stop'); finish(tx); await tick; await runner.tick();
        expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.spent).toBe(1);expect(calls).toBe(1);
    });
    test('simultaneous ticks and second process share a single active payment lease', async () => {
        const path=file(), db=store(path); insert(db); insert(db,'outing-test-0002');
        const db2=store(path);let finish!:(v:Hex)=>void,ready!:()=>void,calls=0;const started=new Promise<void>(r=>ready=r);
        const payment:OutingPayment={async pay(_j,_p,persist){calls++;persist('inflight');ready();return new Promise<Hex>(r=>finish=r);}};
        const a=new OutingRunner(db,agent.address,payment,reader,()=>now), b=new OutingRunner(db2,agent.address,payment,reader,()=>now);
        const tick=a.tick(); await started;await Promise.all([a.tick(),b.tick()]);expect(calls).toBe(1);finish(tx);await tick;
    });
    test('expired unsigned jobs and rotated signer fail closed', async () => {
        const db=store(), job=insert(db);
        await new OutingRunner(db,stranger.address,{async pay(){throw new Error('must not pay');}},reader,()=>now).tick();
        expect(db.get(job.id)?.error).toBe('key_changed');
        expect(()=>new OutingRunner(db,stranger.address,paid,reader,()=>now).control(owner.address,job.id,'resume')).toThrow('invalid_permission');
        insert(db,'outing-test-0002'); await new OutingRunner(db,agent.address,paid,reader,()=>now+8000_000).tick();
        expect(db.get('outing-test-0002')?.error).toBe('permission_expired');
        expect(db.get('outing-test-0002')?.status).toBe('stopped'); expect(db.get('outing-test-0002')?.context).toBe('0x');
    });
    test('job IDs, unsigned grant identity and owner limits cannot be reused', () => {
        const db=store(), job=insert(db); expect(insert(db).id).toBe(job.id);
        expect(()=>db.insert(owner.address,{...start(),admissions:3},{payer,expiresAt:now+1000,contextHash:tx},agent.address,now,guardian(start().tokenId))).toThrow('conflict');
        expect(()=>db.insert(owner.address,start('duplicate-context'),{payer,expiresAt:now+1000,contextHash:job.contextHash},agent.address,now,guardian(start('duplicate-context').tokenId))).toThrow('conflict');
        for(let i=2;i<=3;i++)insert(db,`outing-limit-${String(i).padStart(4,'0')}`);
        expect(()=>insert(db,'outing-limit-0004')).toThrow('busy');
    });
});

describe('authenticated bridge',()=>{
    test('owner-scoped GET/POST, idempotent lost response, stop and closed errors',async()=>{
        const db=store(),runner=new OutingRunner(db,agent.address,paid,reader,()=>now);
        const app=createOutingApp({token,store:db,runner,now:()=>now,validate:async()=>({payer,expiresAt:now+7200_000,contextHash:tx})});
        const headers={'Authorization':`Bearer ${token}`,'X-Mapae-Owner':owner.address,'Content-Type':'application/json'};
        expect((await app.request('/')).status).toBe(401);
        expect((await app.request('/',{headers:{...headers,'Authorization':'Bearer wrong'}})).status).toBe(401);
        expect((await app.request('/',{method:'POST',headers,body:JSON.stringify(start())})).status).toBe(201);
        expect((await app.request('/',{method:'POST',headers,body:JSON.stringify(start())})).status).toBe(200);
        const foreign={...headers,'X-Mapae-Owner':stranger.address};
        expect(((await (await app.request('/',{headers:foreign})).json()) as OutingStatus).jobs).toHaveLength(0);
        expect((await app.request('/outing-test-0001/stop',{method:'POST',headers:foreign})).status).toBe(404);
        expect((await app.request('/outing-test-0001/stop',{method:'POST',headers})).status).toBe(200);
        expect(db.get('outing-test-0001')?.status).toBe('stopped');
        expect((await app.request('/',{method:'POST',headers,body:'x'.repeat(65537)})).status).toBe(413);
    });
    test('unconfigured runner honestly advertises disabled and rejects start',async()=>{
        const app=createOutingApp({token}),headers={'Authorization':`Bearer ${token}`,'X-Mapae-Owner':owner.address};
        expect(await (await app.request('/',{headers})).json()).toEqual({enabled:false,agent:null,jobs:[]});
        expect((await app.request('/',{method:'POST',headers})).status).toBe(503);
    });
    test('receipt must match exact game, payer, network, asset, amount and payee',()=>{
        const db=store(),job=insert(db),pending={game:'race' as const,seed:1,header:'header',transaction:null};
        const resource={ticket:{shop:{slug:'mapae-arcade'},item:{key:'race'},code:'ticket-123',transaction:tx},receipt:{transaction:tx,payer,method:'erc7710',network:'eip155:91342',amount:'1.00',asset:MOCK_USDC.address,payTo:ARCADE_PAY_TO}};
        expect(receiptTransaction(resource,job,pending)).toBe(tx);
        for(const change of [{payer:owner.address},{network:'eip155:1'},{amount:'2'},{asset:ARCADE_PAY_TO},{payTo:ARCADE_REDEEMER},{transaction:`0x${'55'.repeat(32)}`}])
            expect(()=>receiptTransaction({...resource,receipt:{...resource.receipt,...change}},job,pending)).toThrow();
        expect(()=>receiptTransaction(resource,job,{...pending,game:'shop'})).toThrow();
    });
});

describe('reviewed stop, progress and owner visibility',()=>{
    test('confirmed spending is visible while a paid simulation waits recovery',async()=>{
        const db=store(), job=insert(db,undefined,1);
        const runner=new OutingRunner(db,agent.address,paid,reader,()=>now,()=>{throw new Error('simulation interrupted');});
        await runner.tick(); const current=db.get(job.id)!;
        expect(current.results).toHaveLength(0);expect(current.spent).toBe(0);expect(publicJob(current).spent).toBe(1);
    });
    test('stopping an unresolved paused intent recovers same header then ends',async()=>{
        const db=store(),job=insert(db);job.status='paused';job.pending={game:'stamp',seed:123,header:'previous-intent',transaction:null};db.save(job);
        let calls=0;const runner=new OutingRunner(db,agent.address,{async pay(_j,p){calls++;expect(p.header).toBe('previous-intent');return tx;}},reader,()=>now);
        runner.control(owner.address,job.id,'stop');expect(db.get(job.id)?.status).toBe('queued');await runner.tick();await runner.tick();
        expect(calls).toBe(1);expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.results).toHaveLength(1);
    });
    test('older active jobs remain in bounded list after more than24 completed jobs',()=>{
        const db=store(),old=insert(db);old.status='paused';db.save(old);
        for(let i=0;i<30;i++) {const row=insert(db,`completed-job-${String(i).padStart(3,'0')}`);row.status='complete';row.updatedAt=now+i+1;db.save(row);}
        const listed=db.list(owner.address);expect(listed).toHaveLength(24);expect(listed[0]?.id).toBe(old.id);
    });
    test('birth traits are never accepted in a start payload',()=>{
        expect(()=>parseStart({...start(),profile})).toThrow('invalid_request');
        for(const tokenId of ['0','01','-1',(1n<<256n).toString()]) expect(()=>parseStart({...start(),tokenId})).toThrow('invalid_request');
    });
});

describe('one outing per NFT ownership epoch and expiry capacity',()=>{
    test('two devices cannot use different grants for the same token epoch',()=>{
        const path=file(),a=store(path),b=store(path),first=insert(a);
        const second={...start('second-device-job'),tokenId:first.guardian.tokenId};
        expect(()=>b.insert(owner.address,second,{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now,first.guardian)).toThrow('busy');
        new OutingRunner(a,agent.address,paid,reader,()=>now).control(owner.address,first.id,'stop');
        expect(b.insert(owner.address,second,{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now,first.guardian).status).toBe('queued');
    });
    test('new epoch can operate while old lost-response payment remains privately recoverable once',async()=>{
        const path=file(),db=store(path),prior=insert(db,undefined,3);let dispatches=0;
        await new OutingRunner(db,agent.address,{async pay(_j,_p,persist){persist('old-exact-header');dispatches++;throw Error('lost response');}},reader,()=>now).tick();
        expect(db.get(prior.id)?.status).toBe('paused');
        const nextGuardian={...prior.guardian,owner:stranger.address,ownershipEpoch:'2'};
        const request={...start('new-owner-after-loss',1),tokenId:prior.guardian.tokenId};
        const next=db.insert(stranger.address,request,{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now+1,nextGuardian);
        const second=store(path);
        expect(()=>second.insert(stranger.address,{...request,id:'second-new-owner-device'},{payer,expiresAt:now+7200_000,contextHash:`0x${'55'.repeat(32)}`},agent.address,now+2,nextGuardian)).toThrow('busy');
        expect(db.list(stranger.address).map(j=>j.id)).toEqual([next.id]);
        expect(db.get(prior.id)?.pending?.header).toBe('old-exact-header');expect(db.get(prior.id)?.stopRequested).toBe(true);
        expect(publicJob(db.get(prior.id)!).reservedAdmissions).toBe(1);expect(publicJob(next).reservedAdmissions).toBe(1);
        const nextTx=`0x${'66'.repeat(32)}` as Hex;
        const runner=new OutingRunner(db,agent.address,{async pay(j,p,persist){
            if(j.id===prior.id){expect(p.header).toBe('old-exact-header');return tx;}
            expect(j.owner).toBe(stranger.address);expect(p.header).toBeNull();persist('buyer-own-header');dispatches++;return nextTx;
        }},{inspect:async()=>nextGuardian},()=>now+3);
        expect(()=>runner.control(stranger.address,prior.id,'resume')).toThrow('not_found');
        await runner.tick();expect(db.get(next.id)?.status).toBe('complete');
        runner.control(owner.address,prior.id,'resume');await runner.tick();await runner.tick();
        expect(db.get(prior.id)?.status).toBe('stopped');expect(db.get(prior.id)?.spent).toBe(1);expect(db.get(prior.id)?.context).toBe('0x');
        expect(publicJob(db.get(prior.id)!).reservedAdmissions).toBe(0);
        expect(dispatches).toBe(2);expect(db.guardians.progress(collection,prior.guardian.tokenId).plays).toBe(2);
        expect(db.guardians.list(collection,prior.guardian.tokenId).map(r=>r.result.actor).sort()).toEqual([owner.address,stranger.address].sort());
    });
    test('new owner retires unsigned prior plans without taking their authority',()=>{
        const db=store(),prior=insert(db);prior.status='paused';db.save(prior);
        const next=db.insert(stranger.address,{...start('new-owner-plan'),tokenId:prior.guardian.tokenId},{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now,{...prior.guardian,owner:stranger.address,ownershipEpoch:'2'});
        expect(next.owner).toBe(stranger.address);expect(db.get(prior.id)?.status).toBe('stopped');expect(db.get(prior.id)?.context).toBe('0x');
    });
    test('transfer-back separates current operating capacity from retained financial recovery',()=>{
        const db=store();const old=[1,2,3].map(i=>insert(db,`returned-token-${i}`));
        for(const job of old){job.status='paused';job.pending={game:'stamp',seed:1,header:`old-header-${job.id}`,transaction:null};db.save(job);}
        const prior=old[0]!,snapshot={...prior.guardian,ownershipEpoch:'3'};
        const next=db.insert(owner.address,{...start('returned-epoch-three'),tokenId:prior.guardian.tokenId},{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now+1,snapshot);
        expect(next.guardian.ownershipEpoch).toBe('3');expect(db.get(prior.id)?.stopRequested).toBe(true);
        expect(db.list(owner.address)).toHaveLength(4);expect(db.get(prior.id)?.pending?.header).toBe(`old-header-${prior.id}`);
        expect(()=>insert(db,'fourth-current-operation')).toThrow('busy');
    });
    test('delayed pre-transfer chain read cannot retire a newer owner operation',()=>{
        const db=store(),stale=guardian('1');
        const next=db.insert(stranger.address,{...start('newer-owner-snapshot'),tokenId:'1'},{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now,{...stale,owner:stranger.address,ownershipEpoch:'2'});
        expect(()=>db.insert(owner.address,{...start('delayed-old-snapshot'),tokenId:'1'},{payer,expiresAt:now+7200_000,contextHash:`0x${'55'.repeat(32)}`},agent.address,now+1,stale)).toThrow('owner_changed');
        expect(db.get(next.id)?.stopRequested).toBe(false);expect(db.get(next.id)?.status).toBe('queued');expect(db.get('delayed-old-snapshot')).toBeNull();
    });
    test('expired unsigned jobs release capacity but signed intents remain',async()=>{
        const db=store(),paused=insert(db,'expired-paused');paused.status='paused';db.save(paused);
        const unknown=insert(db,'expired-unknown');unknown.status='paused';unknown.pending={game:'race',seed:2,header:'must-preserve',transaction:null};db.save(unknown);
        const confirmed=insert(db,'expired-receipt');confirmed.status='paused';confirmed.pending={game:'shop',seed:3,header:'must-preserve-too',transaction:tx};db.save(confirmed);
        await new OutingRunner(db,agent.address,paid,reader,()=>now+8000_000).tick();
        expect(db.get(paused.id)?.status).toBe('stopped');expect(db.get(unknown.id)?.pending?.header).toBe('must-preserve');expect(db.get(confirmed.id)?.pending?.transaction).toBe(tx);
    });
    test('expiry cleanup remains bounded and frees room before insert',()=>{
        const db=store();
        for(let i=0;i<70;i++){
            const address=`0x${(i+1).toString(16).padStart(40,'0')}` as Address, request=start(`bounded-expiry-${i}`);
            db.insert(address,request,{payer,expiresAt:now+1000,contextHash:`0x${(i+1).toString(16).padStart(64,'0')}`},agent.address,now,guardian(request.tokenId,address));
        }
        expect(db.expireUnsubmitted(now+2000)).toBe(64);expect(db.expireUnsubmitted(now+2000)).toBe(6);expect(db.expireUnsubmitted(now+2000)).toBe(0);
    });
    test('transfer and transfer-back epoch stop before any new payment',async()=>{
        for(const current of [guardian('1',stranger.address),{...guardian(),ownershipEpoch:'3'}]){
            const db=store(),j=insert(db);let calls=0;
            await new OutingRunner(db,agent.address,{async pay(){calls++;return tx;}},{inspect:async()=>({...current,tokenId:j.guardian.tokenId})},()=>now).tick();
            expect(calls).toBe(0);expect(db.get(j.id)?.error).toBe('owner_changed');expect(db.get(j.id)?.context).toBe('0x');
        }
    });
    test('RPC uncertainty pauses, paid transfer recovers once without owner reauthorization',async()=>{
        const db=store(),j=insert(db,undefined,1);let calls=0;
        const missing={inspect:async()=>{throw Error('offline');}};
        const runner=new OutingRunner(db,agent.address,{async pay(){calls++;return tx;}},missing,()=>now);
        await runner.tick();expect(calls).toBe(0);expect(db.get(j.id)?.error).toBe('guardian_unavailable');
        const pending=db.get(j.id)!;pending.pending={game:'stamp',seed:4,header:'existing-intent',transaction:null};db.save(pending);
        runner.control(owner.address,j.id,'resume');await runner.tick();expect(calls).toBe(1);expect(db.get(j.id)?.status).toBe('complete');
    });
});

test('a stop during signing prevents dispatch and leaves no recoverable false payment',async()=>{
    const db=store(),job=insert(db);let ready!:()=>void,continueSigning!:()=>void,dispatches=0;
    const started=new Promise<void>(r=>ready=r),signed=new Promise<void>(r=>continueSigning=r);
    const runner=new OutingRunner(db,agent.address,{async pay(_j,_p,persist){ready();await signed;persist('never-sent');dispatches++;return tx;}},reader,()=>now);
    const running=runner.tick();await started;runner.control(owner.address,job.id,'stop');continueSigning();await running;
    expect(dispatches).toBe(0);expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.pending).toBeNull();expect(db.get(job.id)?.context).toBe('0x');
});
test('a stop during an ownership RPC failure cannot resurrect the stopped authorization',async()=>{
    const db=store(),job=insert(db);let ready!:()=>void,reject!:(e:Error)=>void;
    const started=new Promise<void>(r=>ready=r);
    const guard={inspect:async()=>{ready();return new Promise<GuardianSnapshot>((_resolve,r)=>reject=r);}};
    let payments=0;const runner=new OutingRunner(db,agent.address,{async pay(){payments++;return tx;}},guard,()=>now);
    const pending=runner.tick();await started;runner.control(owner.address,job.id,'stop');reject(Error('rpc timeout'));await pending;
    expect(payments).toBe(0);expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.context).toBe('0x');
});

describe('ranked attempts',()=>{
    let paidCount=0;
    const counting:OutingPayment={async pay(_j,p,persist){if(!p.header)persist(`ranked-header-${++paidCount}`);return `0x${(0xa000+paidCount).toString(16).padStart(64,'0')}` as Hex;}};
    function plan(db:OutingStore,id:string,choice:OutingStart['choice'],admissions:number,tokenId='1',holder:Address=owner.address,epoch='1',at=now):Job{
        const g={...guardian(tokenId,holder),ownershipEpoch:epoch};
        return db.insert(holder,{...start(id,admissions),tokenId,choice},{payer,expiresAt:at+7200_000,contextHash:`0x${Buffer.from(id).toString('hex').padEnd(64,'0')}`},agent.address,at,g);
    }
    async function drain(db:OutingStore,clock:()=>number,ticks:number,inspect=reader){const runner=new OutingRunner(db,agent.address,counting,inspect,clock);for(let i=0;i<ticks;i++)await runner.tick();}
    const day=kstDay(now);
    test('the first three rounds of a game each KST day are ranked with fixed seeds; the fourth is random and unranked',async()=>{
        const db=store(),job=plan(db,'ranked-race-four','race',4);await drain(db,()=>now,5);
        const results=db.get(job.id)!.results;
        expect(results.map(r=>r.ranked)).toEqual([{day,attempt:1},{day,attempt:2},{day,attempt:3},undefined]);
        expect(results.slice(0,3).map(r=>r.seed)).toEqual([1,2,3].map(n=>rankedSeed('race',day,n,'1')));
        expect([1,2,3].map(n=>rankedSeed('race',day,n,'1'))).not.toContain(results[3]!.seed);
        expect(db.rankedAttemptsUsed(collection,'1',day)).toEqual({stamp:0,race:3,shop:0});
        const rows=db.db.query<{attempt:number;week:string;score:number},[]>('SELECT attempt, week, score FROM arcade_guardian_ranked ORDER BY attempt').all();
        expect(rows.map(r=>r.attempt)).toEqual([1,2,3]);expect(rows[0]!.week).toBe(kstWeek(day));
        expect(rows.map(r=>r.score)).toEqual(results.slice(0,3).map(r=>r.outcome.score));
    });
    test('each game keeps its own three attempts',async()=>{
        const db=store(),job=plan(db,'ranked-auto-three','auto',3);await drain(db,()=>now,4);
        expect(db.get(job.id)!.results.map(r=>[r.game,r.ranked?.attempt])).toEqual([['race',1],['shop',1],['stamp',1]]);
    });
    test('a round drawn before midnight keeps its day when it settles after',async()=>{
        const db=store(),before=Date.parse('2033-05-18T14:59:59.000Z');let t=before;
        const job=plan(db,'ranked-midnight-cross','race',1,'1',owner.address,'1',before);
        const runner=new OutingRunner(db,agent.address,{async pay(_j,_p,persist){persist('midnight-header');t=before+2000;return tx;}},reader,()=>t);
        await runner.tick();
        const result=db.get(job.id)!.results[0]!;expect(kstDay(result.at)).toBe('2033-05-19');
        expect(result.ranked).toEqual({day:'2033-05-18',attempt:1});expect(result.seed).toBe(rankedSeed('race','2033-05-18',1,'1'));
        expect(db.rankedAttemptsUsed(collection,'1','2033-05-18').race).toBe(1);expect(db.rankedAttemptsUsed(collection,'1','2033-05-19').race).toBe(0);
    });
    test('a previous owner\'s pending ranked admission still counts for the token',async()=>{
        const db=store(),prior=plan(db,'ranked-prior-epoch','race',2);
        prior.status='paused';prior.pending={game:'race',seed:rankedSeed('race',day,1,'1'),header:'old-header',transaction:null,ranked:{day,attempt:1}};db.save(prior);
        const next=plan(db,'ranked-next-epoch','race',1,'1',stranger.address,'2');
        expect(db.rankedAttemptsUsed(collection,'1',day,next.id).race).toBe(1);
        const runner=new OutingRunner(db,agent.address,{async pay(j,_p,persist){if(j.id===prior.id)throw Error('old payment unresolved');persist('new-owner-header');return tx;}},{inspect:async()=>({...guardian('1',stranger.address),ownershipEpoch:'2'})},()=>now);
        await runner.tick();await runner.tick();
        expect(db.get(next.id)!.results[0]!.ranked).toEqual({day,attempt:2});
    });
    test('a stopped admission that was never paid frees its attempt',async()=>{
        const db=store(),first=plan(db,'ranked-stopped-free','race',2);
        first.pending={game:'race',seed:rankedSeed('race',day,1,'1'),header:null,transaction:null,ranked:{day,attempt:1}};db.save(first);
        expect(db.rankedAttemptsUsed(collection,'1',day,'other-job').race).toBe(1);
        new OutingRunner(db,agent.address,counting,reader,()=>now).control(owner.address,first.id,'stop');
        expect(db.get(first.id)!.status).toBe('stopped');expect(db.rankedAttemptsUsed(collection,'1',day).race).toBe(0);
        const next=plan(db,'ranked-after-stop','race',1);await drain(db,()=>now,2);
        expect(db.get(next.id)!.results[0]!.ranked).toEqual({day,attempt:1});
    });
    test('a transfer does not reset the count, and the next KST day does',async()=>{
        const db=store();plan(db,'ranked-before-sale','race',3);await drain(db,()=>now,4);
        const bought={...guardian('1',stranger.address),ownershipEpoch:'2'};
        const sale=plan(db,'ranked-after-sale','race',1,'1',stranger.address,'2');await drain(db,()=>now,2,{inspect:async()=>bought});
        expect(db.get(sale.id)!.results[0]!.ranked).toBeUndefined();
        const tomorrow=now+24*3600_000,next=plan(db,'ranked-next-day','race',1,'1',stranger.address,'2',tomorrow);await drain(db,()=>tomorrow,2,{inspect:async()=>bought});
        expect(db.get(next.id)!.results[0]!.ranked).toEqual({day:kstDay(tomorrow),attempt:1});
    });
});
