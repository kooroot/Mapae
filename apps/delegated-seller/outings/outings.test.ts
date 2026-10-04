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
import type {OutingStart, OutingStatus} from '@mapae/arcade/outings';
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
const dirs: string[] = [], stores: OutingStore[] = [];
afterEach(() => {for (const store of stores.splice(0)) {try {store.close();} catch {}} for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true});});
function file() {const dir = mkdtempSync(join(tmpdir(), 'mapae-outings-')); dirs.push(dir); return join(dir, 'seller.sqlite');}
function store(path = file()) {const value = new OutingStore(path); stores.push(value); return value;}
function start(id = 'outing-test-0001', admissions = 2): OutingStart {return {id, characterId: id.replaceAll('_','-'), profile, locale: 'ko', choice: 'auto', admissions, permissionContext: '0xabcd'};}
function insert(db: OutingStore, id = 'outing-test-0001', admissions = 2): Job {
    return db.insert(owner.address, start(id, admissions), {payer, expiresAt: now + 7200_000, contextHash: `0x${Buffer.from(id).toString('hex').padEnd(64,'0')}`}, agent.address, now);
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
        const db = store(), job = db.insert(owner.address, request, permission, agent.address, now);
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
});

describe('durable jobs and uncertain payment', () => {
    test('persists header before dispatch, caps admissions and finishes while browser absent', async () => {
        const db = store(); const job = insert(db, undefined, 3); let calls=0;
        const runner = new OutingRunner(db, agent.address, {async pay(j,p,persist){calls++; persist('durable-secret'); expect(db.get(j.id)?.pending?.header).toBe('durable-secret'); return tx;}}, () => now);
        for(let i=0;i<5;i++) await runner.tick();
        expect(calls).toBe(3); expect(db.get(job.id)?.status).toBe('complete'); expect(db.get(job.id)?.results.map(r=>r.game)).toEqual(['race','shop','stamp']);
        expect(db.get(job.id)?.spent).toBe(3);
        const body = JSON.stringify(publicJob(db.get(job.id)!));
        for (const secret of ['permissionContext','contextHash','durable-secret','payer','fingerprint']) expect(body).not.toContain(secret);
    });
    test('lost response survives SQLite reopen, pauses, resumes identical header once', async () => {
        const path = file(), db = store(path); const job = insert(db, undefined, 1); let payments=0;
        const first = new OutingRunner(db, agent.address, {async pay(_j,_p,persist){persist('exact-durable-header'); payments++; throw new Error('lost response after charge');}}, () => now);
        await first.tick(); expect(db.get(job.id)?.status).toBe('paused'); db.close();
        const reopened = store(path);
        const resumed = new OutingRunner(reopened, agent.address, {async pay(_j,p,persist){expect(p.header).toBe('exact-durable-header'); return tx;}}, () => now+1000);
        await resumed.tick(); expect(reopened.get(job.id)?.results).toHaveLength(0);
        resumed.control(owner.address, job.id, 'resume'); await resumed.tick();
        expect(reopened.get(job.id)?.status).toBe('complete'); expect(payments).toBe(1);
    });
    test('process crash after dispatch quarantines running job; expired pending can recover', async () => {
        const path=file(), db=store(path), job=insert(db,undefined,1);
        job.status='running'; job.pending={game:'stamp',seed:3,header:'already-dispatched',transaction:null}; db.save(job); db.close();
        const reopened=store(path); const runner=new OutingRunner(reopened,agent.address,paid,()=>now+8000_000);
        await runner.tick(); expect(reopened.get(job.id)?.status).toBe('paused');
        runner.control(owner.address,job.id,'resume'); await runner.tick(); expect(reopened.get(job.id)?.status).toBe('complete');
    });
    test('verified payment saved before simulation crash, resume does not pay again', async () => {
        const db=store(), job=insert(db,undefined,1); let calls=0;
        const pay:OutingPayment={async pay(_j,_p,persist){calls++;persist('once');return tx;}};
        const broken=new OutingRunner(db,agent.address,pay,()=>now,()=>{throw new Error('simulation crash');});
        await broken.tick(); expect(db.get(job.id)?.error).toBe('simulation_failed'); expect(db.get(job.id)?.pending?.transaction).toBe(tx);
        const recovered=new OutingRunner(db,agent.address,pay,()=>now+1); recovered.control(owner.address,job.id,'resume'); await recovered.tick();
        expect(calls).toBe(1); expect(db.get(job.id)?.status).toBe('complete');
    });
    test('stop while charge in flight finishes only that paid game', async () => {
        const db=store(), job=insert(db,undefined,3); let finish!:(v:Hex)=>void, ready!:()=>void, calls=0;
        const started=new Promise<void>(r=>ready=r);
        const runner=new OutingRunner(db,agent.address,{async pay(_j,_p,persist){calls++;persist('inflight');ready();return new Promise<Hex>(r=>finish=r);}},()=>now);
        const tick=runner.tick(); await started; runner.control(owner.address,job.id,'stop'); finish(tx); await tick; await runner.tick();
        expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.spent).toBe(1);expect(calls).toBe(1);
    });
    test('simultaneous ticks and second process share a single active payment lease', async () => {
        const path=file(), db=store(path); insert(db); insert(db,'outing-test-0002');
        const db2=store(path);let finish!:(v:Hex)=>void,ready!:()=>void,calls=0;const started=new Promise<void>(r=>ready=r);
        const payment:OutingPayment={async pay(_j,_p,persist){calls++;persist('inflight');ready();return new Promise<Hex>(r=>finish=r);}};
        const a=new OutingRunner(db,agent.address,payment,()=>now), b=new OutingRunner(db2,agent.address,payment,()=>now);
        const tick=a.tick(); await started;await Promise.all([a.tick(),b.tick()]);expect(calls).toBe(1);finish(tx);await tick;
    });
    test('expired unsigned jobs and rotated signer fail closed', async () => {
        const db=store(), job=insert(db);
        await new OutingRunner(db,stranger.address,{async pay(){throw new Error('must not pay');}},()=>now).tick();
        expect(db.get(job.id)?.error).toBe('key_changed');
        expect(()=>new OutingRunner(db,stranger.address,paid,()=>now).control(owner.address,job.id,'resume')).toThrow('invalid_permission');
        insert(db,'outing-test-0002'); await new OutingRunner(db,agent.address,paid,()=>now+8000_000).tick();
        expect(db.get('outing-test-0002')?.error).toBe('permission_expired');
        expect(db.get('outing-test-0002')?.status).toBe('stopped'); expect(db.get('outing-test-0002')?.context).toBe('0x');
    });
    test('job IDs, unsigned grant identity and owner limits cannot be reused', () => {
        const db=store(), job=insert(db); expect(insert(db).id).toBe(job.id);
        expect(()=>db.insert(owner.address,{...start(),admissions:3},{payer,expiresAt:now+1000,contextHash:tx},agent.address,now)).toThrow('conflict');
        expect(()=>db.insert(owner.address,start('duplicate-context'),{payer,expiresAt:now+1000,contextHash:job.contextHash},agent.address,now)).toThrow('conflict');
        for(let i=2;i<=12;i++)insert(db,`outing-limit-${String(i).padStart(4,'0')}`);
        expect(()=>insert(db,'outing-limit-0013')).toThrow('busy');
    });
});

describe('authenticated bridge',()=>{
    test('owner-scoped GET/POST, idempotent lost response, stop and closed errors',async()=>{
        const db=store(),runner=new OutingRunner(db,agent.address,paid,()=>now);
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
        const runner=new OutingRunner(db,agent.address,paid,()=>now,()=>{throw new Error('simulation interrupted');});
        await runner.tick(); const current=db.get(job.id)!;
        expect(current.results).toHaveLength(0);expect(current.spent).toBe(0);expect(publicJob(current).spent).toBe(1);
    });
    test('stopping an unresolved paused intent recovers same header then ends',async()=>{
        const db=store(),job=insert(db);job.status='paused';job.pending={game:'stamp',seed:123,header:'previous-intent',transaction:null};db.save(job);
        let calls=0;const runner=new OutingRunner(db,agent.address,{async pay(_j,p){calls++;expect(p.header).toBe('previous-intent');return tx;}},()=>now);
        runner.control(owner.address,job.id,'stop');expect(db.get(job.id)?.status).toBe('queued');await runner.tick();await runner.tick();
        expect(calls).toBe(1);expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.results).toHaveLength(1);
    });
    test('older active jobs remain in bounded list after more than24 completed jobs',()=>{
        const db=store(),old=insert(db);old.status='paused';db.save(old);
        for(let i=0;i<30;i++) {const row=insert(db,`completed-job-${String(i).padStart(3,'0')}`);row.status='complete';row.updatedAt=now+i+1;db.save(row);}
        const listed=db.list(owner.address);expect(listed).toHaveLength(24);expect(listed[0]?.id).toBe(old.id);
    });
    test('name length counts visible Unicode characters consistently',()=>{
        expect(parseStart({...start(),profile:{...profile,name:'🐎'.repeat(12)}}).profile.name).toBe('🐎'.repeat(12));
        expect(()=>parseStart({...start(),profile:{...profile,name:'🐎'.repeat(13)}})).toThrow('invalid_request');
    });
});

describe('one outing per character and expiry capacity',()=>{
    test('two devices cannot start distinct grants for the same active character',()=>{
        const path=file(), a=store(path), b=store(path), first=insert(a);
        const second={...start('second-device-job'),characterId:first.characterId};
        expect(()=>b.insert(owner.address,second,{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now)).toThrow('busy');
        const different={...second,characterId:'another-character'};
        expect(b.insert(owner.address,different,{payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now).characterId).toBe('another-character');
        new OutingRunner(a,agent.address,paid,()=>now).control(owner.address,first.id,'stop');
        expect(b.insert(owner.address,{...start('third-device-job'),characterId:first.characterId},
            {payer,expiresAt:now+7200_000,contextHash:`0x${'66'.repeat(32)}`},agent.address,now).status).toBe('queued');
    });
    test('expired unsigned paused/queued jobs release capacity but unresolved financial intents remain',async()=>{
        const db=store();
        const paused=insert(db,'expired-paused-01');paused.status='paused';paused.pending={game:'stamp',seed:1,header:null,transaction:null};db.save(paused);
        const queued=insert(db,'expired-queued-01');
        const unknown=insert(db,'expired-pending-01');unknown.status='paused';unknown.pending={game:'race',seed:2,header:'must-preserve',transaction:null};db.save(unknown);
        const confirmed=insert(db,'expired-receipt-01');confirmed.status='paused';confirmed.pending={game:'shop',seed:3,header:'must-preserve-too',transaction:tx};db.save(confirmed);
        const runner=new OutingRunner(db,agent.address,{async pay(){throw new Error('must not pay');}},()=>now+8000_000);
        await runner.tick();
        for(const id of [paused.id,queued.id]) {expect(db.get(id)?.status).toBe('stopped');expect(db.get(id)?.error).toBe('permission_expired');expect(db.get(id)?.context).toBe('0x');expect(db.get(id)?.pending).toBeNull();}
        expect(db.get(unknown.id)?.status).toBe('paused');expect(db.get(unknown.id)?.pending?.header).toBe('must-preserve');
        expect(db.get(confirmed.id)?.status).toBe('paused');expect(db.get(confirmed.id)?.pending?.transaction).toBe(tx);
        expect(db.insert(owner.address,{...start('replacement-character'),characterId:paused.characterId},
            {payer,expiresAt:now+16000_000,contextHash:`0x${'77'.repeat(32)}`},agent.address,now+8000_000).status).toBe('queued');
    });
    test('expiry cleanup is bounded and reclaims old capacity before an insert',()=>{
        const db=store();
        for(let i=0;i<70;i++){
            const address=`0x${(i+1).toString(16).padStart(40,'0')}` as Address;
            db.insert(address,start(`bounded-expiry-${i}`),{payer,expiresAt:now+1000,contextHash:`0x${(i+1).toString(16).padStart(64,'0')}`},agent.address,now);
        }
        expect(db.expireUnsubmitted(now+2000)).toBe(64);expect(db.expireUnsubmitted(now+2000)).toBe(6);expect(db.expireUnsubmitted(now+2000)).toBe(0);
        const first=insert(db,'insert-cleanup-old');first.status='paused';first.expiresAt=now+1;db.save(first);
        const replacement=db.insert(owner.address,{...start('insert-cleanup-new'),characterId:first.characterId},
            {payer,expiresAt:now+7200_000,contextHash:tx},agent.address,now+2);
        expect(replacement.status).toBe('queued');expect(db.get(first.id)?.status).toBe('stopped');
    });
    test('expired interrupted sender without a signed header is retired, while signed one is quarantined',async()=>{
        const db=store(), unsigned=insert(db,'interrupted-unsigned');unsigned.status='running';db.save(unsigned);
        const signed=insert(db,'interrupted-signed');signed.status='running';signed.pending={game:'stamp',seed:8,header:'uncertain',transaction:null};db.save(signed);
        const runner=new OutingRunner(db,agent.address,paid,()=>now+8000_000);
        await runner.tick();await runner.tick();
        expect(db.get(unsigned.id)?.status).toBe('stopped');expect(db.get(unsigned.id)?.context).toBe('0x');
        expect(db.get(signed.id)?.status).toBe('paused');expect(db.get(signed.id)?.pending?.header).toBe('uncertain');
    });
});

test('a stop during signing prevents dispatch and leaves no recoverable false payment',async()=>{
    const db=store(),job=insert(db);let ready!:()=>void,continueSigning!:()=>void,dispatches=0;
    const started=new Promise<void>(r=>ready=r),signed=new Promise<void>(r=>continueSigning=r);
    const runner=new OutingRunner(db,agent.address,{async pay(_j,_p,persist){ready();await signed;persist('never-sent');dispatches++;return tx;}},()=>now);
    const running=runner.tick();await started;runner.control(owner.address,job.id,'stop');continueSigning();await running;
    expect(dispatches).toBe(0);expect(db.get(job.id)?.status).toBe('stopped');expect(db.get(job.id)?.pending).toBeNull();expect(db.get(job.id)?.context).toBe('0x');
});
