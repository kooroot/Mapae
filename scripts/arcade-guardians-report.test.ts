import {afterEach,describe,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {encodeAbiParameters,encodeEventTopics,type Address,type Hex,type Log} from 'viem';
import {guardianAbi} from '../packages/arcade/src/guardian-abi';
import {MOCK_USDC} from '../packages/shared/src/index';
import {ARCADE_PAY_TO} from '../packages/arcade/src/tickets';
import {TRANSFER_EVENT_TOPIC} from '../packages/delegation/src/index';
import {guardiansReport,importEngagementSql,parseReportOptions,type ChainClient} from './arcade-guardians-report';

const now=Date.parse('2026-10-20T12:00:00+09:00'),owner='0x1111111111111111111111111111111111111111' as Address,bot='0x2222222222222222222222222222222222222222' as Address;
const payer='0x3333333333333333333333333333333333333333' as Address,collection='0x5555555555555555555555555555555555555555' as Address;
const hash=`0x${'aa'.repeat(32)}` as Hex,second=`0x${'bb'.repeat(32)}` as Hex,blockHash=`0x${'cc'.repeat(32)}` as Hex;
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function dir(){const p=mkdtempSync(join(tmpdir(),'guardian-report-'));dirs.push(p);return p;}
const at=(day:string)=>Date.parse(day+'T12:00:00+09:00');
function fixtures(empty=false){
    const path=dir(),engagementDb=join(path,'engagement.sqlite'),sellerDb=join(path,'seller.sqlite'),e=new Database(engagementDb),s=new Database(sellerDb);
    e.exec(readFileSync(new URL('../apps/web/src/arcade/engagement/schema.sql',import.meta.url),'utf8'));
    s.exec('CREATE TABLE arcade_guardian_results(actor TEXT,created_at INTEGER,payment_tx TEXT); CREATE TABLE orders(seller_slug TEXT,status TEXT,tx_hash TEXT,payer TEXT,amount_base TEXT,created_at INTEGER)');
    if(!empty){
        for(const [visitor,day] of [['private-browser-a','2026-10-10'],['private-browser-b','2026-10-19'],['private-browser-c','2026-10-10']]){
            e.query('INSERT INTO arcade_engagement_visitors VALUES(?,?,?,?,?,?)').run(visitor!,at(day!),now+10000000,now,'private-session-'+visitor,at(day!));
        }
        let id=0;
        const event=(visitor:string,day:string,event:string,identity:string|null=null,trust='client_reported',result:string|null=null,run:string|null=null)=>
            e.query('INSERT INTO arcade_engagement_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('event-'+(++id),visitor,'private-session-'+visitor,identity,event,event.startsWith('practice')?'stamp':null,run,result,'ko',at(day),day,trust);
        event('private-browser-a','2026-10-10','practice_opened',null,'client_reported',null,'practice-run-1');
        event('private-browser-a','2026-10-10','practice_finished',null,'client_reported','completed','practice-run-1');
        event('private-browser-a','2026-10-10','profile_authenticated',owner,'server_authenticated');
        event('private-browser-a','2026-10-10','operator_action',owner);
        event('private-browser-a','2026-10-11','operator_action',owner);
        event('private-browser-a','2026-10-17','operator_action',owner);
        event('private-browser-a','2026-10-18','operator_action',owner);
        event('private-browser-b','2026-10-19','arcade_entered');
        event('private-browser-c','2026-10-10','arcade_entered');
        for(const [actor,tx] of [[owner,hash],[bot,second]]){
            s.query('INSERT INTO arcade_guardian_results VALUES(?,?,?)').run(actor!,at('2026-10-18'),tx!);
            s.query('INSERT INTO orders VALUES(?,?,?,?,?,?)').run('mapae-arcade','paid',tx!,payer,'1000000',at('2026-10-18'));
        }
        // Deliberately duplicated journal link tests transaction/volume deduplication.
        s.query('INSERT INTO orders VALUES(?,?,?,?,?,?)').run('mapae-arcade','paid',hash.toUpperCase().replace('0X','0x'),payer,'1000000',at('2026-10-18'));
    }
    e.close();s.close();return {engagementDb,sellerDb,asOf:now};
}
function collectionLog(eventName:'MintRequested'|'BirthRerequested'|'ResultClaimed'|'BirthRevealed',tx=hash):Log {
    const args=eventName==='MintRequested'||eventName==='BirthRerequested'?{owner,tokenId:1n,sequence:1n}:eventName==='ResultClaimed'?{resultId:hash,tokenId:1n,paymentTx:hash}:{tokenId:1n,sequence:1n};
    const data=eventName==='ResultClaimed'?encodeAbiParameters([{type:'address'}],[owner]):encodeAbiParameters([{type:'bytes32'}],[hash]);
    return {address:collection,topics:encodeEventTopics({abi:guardianAbi,eventName,args} as Parameters<typeof encodeEventTopics>[0]),data,
        blockNumber:10n,blockHash,transactionHash:tx,transactionIndex:0,logIndex:0,removed:false} as Log;
}
const transfer:Log[]=[{address:MOCK_USDC.address,topics:[TRANSFER_EVENT_TOPIC,`0x${payer.slice(2).padStart(64,'0')}`,`0x${ARCADE_PAY_TO.slice(2).toLowerCase().padStart(64,'0')}`],data:`0x${(1_000_000n).toString(16).padStart(64,'0')}`,
    blockNumber:10n,blockHash,transactionHash:hash,transactionIndex:0,logIndex:0,removed:false}];
function chain(overrides:Partial<ChainClient>={}):ChainClient{
    return {getChainId:async()=>91342,getBlock:async()=>({number:20n,hash:blockHash,timestamp:BigInt(at('2026-10-18')/1000)}),
        getLogs:async()=>[collectionLog('MintRequested'),collectionLog('MintRequested'),collectionLog('ResultClaimed'),collectionLog('BirthRevealed',second)],
        getTransactionReceipt:async()=>({status:'success',blockNumber:10n,blockHash,logs:transfer}),...overrides};
}
const scan={chain:true,collection,fromBlock:1n,toBlock:20n};

describe('truthful aggregate adoption report',()=>{
    test('browser, foreground owner and autonomous owner metrics stay separate; mature denominator is exact',async()=>{
        const f=fixtures(),beforeE=readFileSync(f.engagementDb),beforeS=readFileSync(f.sellerDb);
        const report=await guardiansReport(f);
        expect(report.engagement?.daily.find(d=>d.day==='2026-10-10')).toMatchObject({browser_dau:2,owner_dau:1,practice_completed:1});
        expect(report.autonomous).toMatchObject({completedAdmissions:2,autonomousOwnerWallets:2,sellerReportedPaidOrders:3,sellerReportedPaidTransactions:2,testTokenPaidVolumeBaseUnits:'2000000',isRevenue:false});
        expect(report.engagement?.matureRetention.d1).toMatchObject({eligible:2,returned:1,rate:0.5,immatureVisitors:1});
        expect(report.engagement?.matureRetention.d7).toMatchObject({eligible:2,returned:1,rate:0.5,immatureVisitors:1});
        expect(report.repeatOperatorsLast7Days).toBe(1);expect(report.complete).toBe(false);
        const output=JSON.stringify(report);for(const secret of [owner,bot,payer,hash,'private-browser-a','private-session','practice-run-1',f.engagementDb])expect(output).not.toContain(secret);
        expect(readFileSync(f.engagementDb)).toEqual(beforeE);expect(readFileSync(f.sellerDb)).toEqual(beforeS);
    });
    test('provided empty sources yield known zeros but no eligible retention rate',async()=>{
        const report=await guardiansReport(fixtures(true));
        expect(report.sources.engagement.status).toBe('available');expect(report.autonomous?.completedAdmissions).toBe(0);
        expect(report.engagement?.matureRetention.d1).toEqual({returned:null,eligible:0,rate:null,immatureVisitors:0});
        expect(report.engagement?.matureRetention.d7.rate).toBeNull();
    });
    test('missing or invalid sources are unknown and never fabricate a zero cohort',async()=>{
        const missing=await guardiansReport({asOf:now});
        expect(missing.engagement).toBeNull();expect(missing.autonomous).toBeNull();expect(missing.repeatOperatorsLast7Days).toBeNull();
        expect(missing.complete).toBe(false);
        const invalid=await guardiansReport({asOf:now,engagementDb:join(dir(),'does-not-exist.sqlite'),sellerDb:join(dir(),'absent.sqlite')});
        expect(invalid.sources.engagement.status).toBe('invalid');expect(invalid.sources.seller.status).toBe('invalid');
        expect(invalid.autonomous).toBeNull();
    });
    test('as-of earlier than captured raw data fails explicitly rather than including future events',async()=>{
        const f=fixtures(),report=await guardiansReport({...f,asOf:at('2026-10-11')});
        expect(report.sources.engagement.status).toBe('invalid');expect(report.engagement).toBeNull();
    });
    test('executable CLI writes aggregate JSON and exits 2 for intentionally missing chain coverage',()=>{
        const f=fixtures(),script=new URL('./arcade-guardians-report.ts',import.meta.url).pathname;
        const process=Bun.spawnSync([Bun.which('bun')!,'--no-env-file',script,'--engagement-db',f.engagementDb,'--seller-db',f.sellerDb,'--as-of',new Date(now).toISOString()]);
        expect(process.exitCode).toBe(2);expect(process.stderr.toString()).toBe('');
        const report=JSON.parse(process.stdout.toString());expect(report.autonomous.completedAdmissions).toBe(2);
        expect(report.sources.chain.status).toBe('missing');expect(process.stdout.toString()).not.toContain(owner);
    });
});
describe('safe data-only D1 export import',()=>{
    const quote=(v:unknown)=>v===null?'NULL':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
    function exportSql(path:string){
        const db=new Database(path,{readonly:true});
        try{return 'PRAGMA defer_foreign_keys=TRUE;\n'+['arcade_engagement_visitors','arcade_engagement_events','arcade_engagement_daily'].flatMap(table=>
            db.query(`SELECT * FROM ${table}`).all().map(row=>`INSERT INTO "${table}" VALUES(${Object.values(row as object).map(quote).join(',')});`)).join('\n');}
        finally{db.close();}
    }
    test('actual SQLite export data reproduces the report without replaying SQL code or counter triggers',async()=>{
        const f=fixtures(),sql=exportSql(f.engagementDb),file=join(dir(),'engagement.sql');writeFileSync(file,sql);
        const dbReport=await guardiansReport(f),sqlReport=await guardiansReport({engagementSql:file,sellerDb:f.sellerDb,asOf:now});
        expect(sqlReport.engagement).toEqual(dbReport.engagement);expect(sqlReport.repeatOperatorsLast7Days).toBe(1);
        expect(readFileSync(file,'utf8')).toBe(sql);
    });
    test('rejects executable SQL, unexpected tables, expressions, missing columns and oversized integers',()=>{
        for(const sql of [
            "ATTACH DATABASE '/tmp/forbidden.sqlite' AS x;",
            "PRAGMA writable_schema=ON;","SELECT load_extension('bad');",
            'INSERT INTO arcade_profiles VALUES(1);',
            "INSERT INTO arcade_engagement_daily VALUES('2026-10-10','event','client_reported',abs(-1));",
            "INSERT INTO arcade_engagement_daily VALUES('2026-10-10','event','client_reported',9007199254740992);",
            "INSERT INTO arcade_engagement_daily VALUES('2026-10-10','event','client_reported',1),;",
            "INSERT INTO arcade_engagement_daily(day,event) VALUES('x','y');",
            "INSERT INTO arcade_engagement_daily VALUES('x','y','client_reported',1)"
        ])expect(()=>importEngagementSql(sql)).toThrow();
        const db=importEngagementSql("INSERT INTO arcade_engagement_daily VALUES('2026-10-10','test;quoted''event','client_reported',1);");
        expect(db.query('SELECT count FROM arcade_engagement_daily').get()).toEqual({count:1});
        expect(()=>db.exec('DELETE FROM arcade_engagement_daily')).toThrow();db.close();
    });
});
describe('bounded canonical chain evidence',()=>{
    test('mint/payment/claim overlap deduplicates by chain and transaction hash',async()=>{
        const report=await guardiansReport({...fixtures(),...scan},chain());
        expect(report.chain?.coverage.status).toBe('complete');expect(report.complete).toBe(true);
        expect(report.chain?.completeCounts).toEqual({mintTransactions:1,mintedTokens:1,revealTransactions:1,claimTransactions:1,claimActorWallets:1,paymentTransactions:2,distinctTransactions:2});
        expect(JSON.stringify(report)).not.toContain(owner);expect(JSON.stringify(report)).not.toContain(hash);
    });
    test('a birth re-request is not counted as a mint',async()=>{
        const report=await guardiansReport({...fixtures(),...scan},chain({getLogs:async()=>[collectionLog('MintRequested'),collectionLog('BirthRerequested',second)]}));
        expect(report.chain?.completeCounts).toMatchObject({mintTransactions:1,mintedTokens:1});
    });
    test('range failures, unsafe head and orphaned payments retain explicit incomplete coverage',async()=>{
        for(const c of [
            chain({getLogs:async()=>{throw Error('provider api key must never print');}}),
            chain({getBlock:async input=>({number:'blockTag'in input?9n:10n,hash:blockHash,timestamp:BigInt(at('2026-10-18')/1000)})}),
            chain({getTransactionReceipt:async()=>({status:'success',blockNumber:10n,blockHash:second,logs:transfer})}),
            chain({getChainId:async()=>1}),
        ]){
            const report=await guardiansReport({...fixtures(),...scan},c);
            expect(report.complete).toBe(false);expect(report.chain?.completeCounts).toBeNull();
            expect(JSON.stringify(report)).not.toContain('provider api key');
        }
    });
    test('chain results without a seller source never mean zero payments',async()=>{
        const report=await guardiansReport({...scan,asOf:now},chain());
        expect(report.chain?.observedConfirmed.mintTransactions).toBe(1);
        expect(report.chain?.observedConfirmed.paymentTransactions).toBeNull();expect(report.chain?.observedConfirmed.distinctTransactions).toBeNull();
        expect(report.chain?.completeCounts).toBeNull();
    });
    test('range over bound never calls RPC; command rejects accidental unbounded scans',async()=>{
        let calls=0;const c=chain({getChainId:async()=>{calls++;return 91342;}});
        const r=await guardiansReport({...scan,asOf:now,toBlock:1_000_001n},c);expect(r.chain?.completeCounts).toBeNull();expect(calls).toBe(0);
        for(const argv of [['--chain'],['--chain','--collection',collection,'--from-block','0'],['--from-block','1'],['--engagement-db','x','--engagement-sql','y'],['--as-of','2026-10-10']])
            expect(()=>parseReportOptions(argv)).toThrow();
        expect(parseReportOptions(['--as-of','2026-10-20T03:00:00Z',...['--chain','--collection',collection,'--from-block','1','--to-block','20']]).fromBlock).toBe(1n);
    });
});
