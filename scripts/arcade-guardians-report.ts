import {Database} from 'bun:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {createPublicClient,decodeEventLog,isAddress,isHash,type Address,type Hex,type Log} from 'viem';
import {giwaSepolia,MOCK_USDC} from '../packages/shared/src/index';
import {reconcileSettlementReceipt,throttledHttp} from '../packages/delegation/src/index';
import {ARCADE_PAY_TO,ARCADE_TICKET_AMOUNT} from '../packages/arcade/src/tickets';
import {guardianAbi} from '../packages/arcade/src/guardian-abi';
import {engagementRepository,type EngagementDatabase} from '../apps/web/src/arcade/engagement/repository';
import {engagementReport} from '../apps/web/src/arcade/engagement/report';
import {DAY_MS,seoulDay} from '../apps/web/src/arcade/engagement/model';

const MAX_SQL_BYTES=64*1_048_576,MAX_IMPORT_ROWS=500_000,MAX_PAYMENT_RECEIPTS=2_000;
const TABLES:Record<string,readonly string[]>={
    arcade_engagement_visitors:['hash','first_at','expires_at','last_at','session','session_at'],
    arcade_engagement_events:['id','visitor','session','owner','event','game','run_id','result','locale','at','day','trust'],
    arcade_engagement_daily:['day','event','trust','count'],
    arcade_engagement_sources:['visitor','source'],
};
const failure=(code:string)=>new Error(code);
type Coverage={status:'available'|'missing'|'invalid';reason:string|null};
type Payment={hash:Hex;payer:Address;amount:string};
type OwnerDay={owner:string;day:string};
export type ReportOptions={engagementDb?:string;engagementSql?:string;sellerDb?:string;asOf?:number;chain?:boolean;collection?:Address;fromBlock?:bigint;toBlock?:bigint};
export type ChainClient={
    getChainId():Promise<number>;
    getBlock(input:{blockTag:'safe'}|{blockNumber:bigint}):Promise<{number:bigint|null;hash:Hex|null;timestamp:bigint}>;
    getLogs(input:{address:Address;fromBlock:bigint;toBlock:bigint}):Promise<Log[]>;
    getTransactionReceipt(input:{hash:Hex}):Promise<{status:'success'|'reverted';blockNumber:bigint;blockHash:Hex;logs:Log[]}>;
};

/** Strict data-only SQL reader. Dump text is NEVER passed to Database.exec. */
function statements(sql:string):string[]{
    const rows:string[]=[];let value='',quoted=false;
    for(let i=0;i<sql.length;i++){
        const c=sql[i]!;
        if(c==="'"){
            value+=c;
            if(quoted&&sql[i+1]==="'"){value+="'";i++;}else quoted=!quoted;
        }else if(!quoted&&c==='-'&&sql[i+1]==='-'){
            while(i<sql.length&&sql[i]!=='\n')i++;value+=' ';
        }else if(!quoted&&c==='/'&&sql[i+1]==='*'){
            const end=sql.indexOf('*/',i+2);if(end<0)throw failure('invalid_sql_export');i=end+1;value+=' ';
        }else if(!quoted&&c===';'){if(value.trim())rows.push(value.trim());value='';}
        else value+=c;
    }
    if(quoted||value.trim())throw failure('invalid_sql_export');
    return rows;
}
function literals(text:string,limit:number):(string|number|null)[][]{
    let i=0;const rows:(string|number|null)[][]=[];
    const space=()=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;};
    while(i<text.length){
        space();if(text[i++]!=='(')throw failure('invalid_sql_export');const row:(string|number|null)[]=[];
        for(;;){
            space();let value:string|number|null;
            if(text[i]==="'"){
                i++;let str='',closed=false;
                while(i<text.length){const c=text[i++]!;if(c==="'"){if(text[i]==="'"){str+="'";i++;}else{closed=true;break;}}else str+=c;}
                if(!closed)throw failure('invalid_sql_export');value=str;
            }else{
                const match=/^(NULL|-?(?:0|[1-9][0-9]*))(?=\s*[,\)])/i.exec(text.slice(i));
                if(!match)throw failure('invalid_sql_export');i+=match[0].length;value=match[1]!.toUpperCase()==='NULL'?null:Number(match[1]);
                if(value!==null&&!Number.isSafeInteger(value))throw failure('invalid_sql_export');
            }
            row.push(value);space();const c=text[i++];if(c===')')break;if(c!==',')throw failure('invalid_sql_export');
        }
        if(rows.length>=limit)throw failure('invalid_export_size');
        rows.push(row);space();if(i===text.length)break;if(text[i++]!==',')throw failure('invalid_sql_export');
        space();if(i===text.length)throw failure('invalid_sql_export');
    }
    return rows;
}
export function importEngagementSql(sql:string):Database{
    if(Buffer.byteLength(sql,'utf8')>MAX_SQL_BYTES)throw failure('export_too_large');
    const db=new Database(':memory:');
    try{
        db.exec(readFileSync(new URL('../apps/web/src/arcade/engagement/schema.sql',import.meta.url),'utf8'));
        db.exec('DROP TRIGGER arcade_engagement_count');
        let count=0;
        db.transaction(()=>{
            for(const statement of statements(sql)){
                if(/^(?:BEGIN TRANSACTION|COMMIT|PRAGMA (?:defer_foreign_keys|foreign_keys)\s*=\s*(?:ON|OFF|TRUE|FALSE|0|1))$/i.test(statement))continue;
                const m=/^INSERT INTO\s+(?:"([a-z_]+)"|`([a-z_]+)`|([a-z_]+))\s*(?:\(([^)]+)\))?\s+VALUES\s*([\s\S]+)$/i.exec(statement);
                if(!m)throw failure('data_only_export_required');
                const table=m[1]??m[2]??m[3]!,expected=TABLES[table];if(!expected)throw failure('unexpected_export_table');
                const columns=m[4]?m[4].split(',').map(c=>c.trim().replace(/^["`]|["`]$/g,'')):[...expected];
                if(columns.length!==expected.length||new Set(columns).size!==expected.length||columns.some(c=>!expected.includes(c)))throw failure('invalid_export_columns');
                const insert=db.query(`INSERT INTO "${table}" (${columns.map(c=>'"'+c+'"').join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
                for(const row of literals(m[5]!,MAX_IMPORT_ROWS-count)){
                    if(++count>MAX_IMPORT_ROWS||row.length!==columns.length)throw failure('invalid_export_size');
                    insert.run(...row);
                }
            }
        })();
        db.exec('PRAGMA query_only=ON');return db;
    }catch(e){db.close();throw e;}
}
function readDb(path:string):Database{const db=new Database(path,{readonly:true,strict:true});db.exec('BEGIN');return db;}
function adapter(db:Database):EngagementDatabase{
    const prepare=(sql:string,args:unknown[]=[]):unknown=>({
        bind:(...values:unknown[])=>prepare(sql,values),
        first:async()=>db.query(sql).get(...args as (string|number|null)[]),
        all:async()=>({results:db.query(sql).all(...args as (string|number|null)[])}),
        run:async()=>{throw failure('report_write_refused');},
    });
    return {prepare,batch:async()=>{throw failure('report_write_refused');}} as unknown as EngagementDatabase;
}
function inWindow<T extends {day:string}>(rows:T[],since:string,today:string){return rows.filter(r=>r.day>=since&&r.day<=today);}
function rate(returned:number,eligible:number){return {returned:eligible?returned:null,eligible,rate:eligible?returned/eligible:null};}

async function engagement(options:ReportOptions,now:number,since:string,today:string){
    const missing={coverage:{status:'missing',reason:'engagement_source_not_supplied'} as Coverage,report:null,operators:[] as OwnerDay[]};
    if(!options.engagementDb&&!options.engagementSql)return missing;
    let db:Database|undefined;
    try{
        if(options.engagementDb&&options.engagementSql)throw failure('ambiguous_engagement_source');
        if(options.engagementSql){
            if(statSync(options.engagementSql).size>MAX_SQL_BYTES)throw failure('export_too_large');
            db=importEngagementSql(readFileSync(options.engagementSql,'utf8'));
        }else db=readDb(options.engagementDb!);
        const max=db.query<{at:number|null},[]>('SELECT MAX(at) AS at FROM arcade_engagement_events').get()!.at;
        if(max!==null&&max>now)throw failure('snapshot_after_cutoff');
        const report=await engagementReport(engagementRepository(adapter(db)),now);
        const rows=inWindow(report.cohorts,since,today),daily=inWindow(report.daily,since,today);
        const retention=(name:'d1'|'d7')=>{
            const mature=rows.filter(r=>r[name].mature);
            return {...rate(mature.reduce((n,r)=>n+(r[name].returned??0),0),mature.reduce((n,r)=>n+r.visitors,0)),immatureVisitors:rows.filter(r=>!r[name].mature).reduce((n,r)=>n+r.visitors,0)};
        };
        const operators=db.query<OwnerDay,[string,string]>(`SELECT DISTINCT lower(owner) AS owner,day FROM arcade_engagement_events
            WHERE owner IS NOT NULL AND event IN ('operator_action','mint_started','outing_started') AND trust='client_reported' AND day>=? AND day<=?`).all(seoulDay(now-6*DAY_MS),today);
        return {coverage:{status:'available',reason:null} as Coverage,report:{...report,daily,cohorts:rows,matureRetention:{d1:retention('d1'),d7:retention('d7')},
            sourceCoverage:{rawRetentionDays:35,completeLookbackDays:28,snapshotCutoff:new Date(now).toISOString(),latestObservedEventAt:max===null?null:new Date(max).toISOString(),cutoffDeclaredByOperator:true},
            caveats:['Browser IDs and wallets do not identify unique people.','A supplied snapshot must cover the declared cutoff; inactivity alone cannot prove collection uptime.']},operators};
    }catch{return {coverage:{status:'invalid',reason:'engagement_source_invalid_or_outside_cutoff'} as Coverage,report:null,operators:[] as OwnerDay[]};}
    finally{db?.close();}
}
function seller(path:string|undefined,start:number,now:number){
    const missing={coverage:{status:'missing',reason:'seller_source_not_supplied'} as Coverage,report:null,payments:[] as Payment[],owners:[] as OwnerDay[]};
    if(!path)return missing;
    let db:Database|undefined;
    try{
        db=readDb(path);
        const sizes=db.query<{results:number;orders:number},[number,number,number,number]>("SELECT (SELECT COUNT(*) FROM arcade_guardian_results WHERE created_at>=? AND created_at<=?) AS results,(SELECT COUNT(*) FROM orders WHERE seller_slug='mapae-arcade' AND created_at>=? AND created_at<=?) AS orders").get(start,now,start,now)!;
        if(sizes.results>MAX_IMPORT_ROWS||sizes.orders>MAX_IMPORT_ROWS)throw failure('report_row_limit');
        const completed=db.query<{owner:string;day:string;payment:string},[number,number]>(`SELECT actor AS owner,
            date(created_at/1000,'unixepoch','+9 hours') AS day,payment_tx AS payment FROM arcade_guardian_results WHERE created_at>=? AND created_at<=?`).all(start,now);
        const orders=db.query<{hash:string;payer:string;amount:string},[number,number]>(`SELECT tx_hash AS hash,payer,amount_base AS amount FROM orders
            WHERE seller_slug='mapae-arcade' AND status='paid' AND created_at>=? AND created_at<=?`).all(start,now);
        const payments=new Map<string,Payment>();
        for(const o of orders){
            if(!isHash(o.hash)||!isAddress(o.payer)||o.amount!==ARCADE_TICKET_AMOUNT.toString())throw failure('invalid_seller_payment');
            const hash=o.hash.toLowerCase() as Hex,previous=payments.get(hash);
            if(previous&&previous.payer.toLowerCase()!==o.payer.toLowerCase())throw failure('conflicting_seller_payment');
            payments.set(hash,{hash,payer:o.payer,amount:o.amount});
        }
        for(const r of completed)if(!isAddress(r.owner)||!isHash(r.payment))throw failure('invalid_seller_result');
        const completedPayments=new Set(completed.map(r=>r.payment.toLowerCase()));
        const days=new Map<string,{day:string;autonomousOwnerWallets:number;completedAdmissions:number}>();
        for(const day of new Set(completed.map(r=>r.day))){
            const rows=completed.filter(r=>r.day===day);days.set(day,{day,autonomousOwnerWallets:new Set(rows.map(r=>r.owner.toLowerCase())).size,completedAdmissions:rows.length});
        }
        return {coverage:{status:'available',reason:null} as Coverage,report:{
            completedAdmissions:completed.length,autonomousOwnerWallets:new Set(completed.map(r=>r.owner.toLowerCase())).size,
            completedAdmissionPaymentTransactions:new Set(completed.map(r=>r.payment.toLowerCase())).size,
            sellerReportedPaidOrders:orders.length,sellerReportedPaidTransactions:payments.size,
            paidTransactionsWithoutCompletedResult:[...payments.keys()].filter(h=>!completedPayments.has(h)).length,
            testTokenPaidVolumeBaseUnits:(BigInt(payments.size)*ARCADE_TICKET_AMOUNT).toString(),testTokenSymbol:'mUSDC',isRevenue:false,
            daily:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)),
            caveats:['Owner activity here is autonomous execution, not human DAU.','Seller paid receipts are ledger evidence; optional chain verification separately proves safe canonical transactions.'],
        },payments:[...payments.values()],owners:completed.map(r=>({owner:r.owner.toLowerCase(),day:r.day}))};
    }catch{return {coverage:{status:'invalid',reason:'seller_schema_or_records_unavailable'} as Coverage,report:null,payments:[] as Payment[],owners:[] as OwnerDay[]};}
    finally{db?.close();}
}

export async function chainActivity(options:ReportOptions,payments:Payment[],paymentSourceAvailable:boolean,start:number,now:number,client:ChainClient){
    const minted=new Set<string>(),revealed=new Set<string>(),claims=new Set<string>(),paid=new Set<string>(),all=new Set<string>(),tokens=new Set<string>(),actors=new Set<string>();
    let safeHead:bigint|null=null,scannedThrough:bigint|null=null,rangeComplete=false,paymentComplete=paymentSourceAvailable;
    const reasons:string[]=[];
    const count=()=>({mintTransactions:minted.size,mintedTokens:tokens.size,revealTransactions:revealed.size,claimTransactions:claims.size,claimActorWallets:actors.size,paymentTransactions:paymentSourceAvailable?paid.size:null,distinctTransactions:paymentSourceAvailable?all.size:null});
    try{
        if(!options.collection||!isAddress(options.collection)||options.fromBlock===undefined||options.toBlock===undefined||
            options.fromBlock<0n||options.toBlock<options.fromBlock||options.toBlock-options.fromBlock>=1_000_000n)throw failure('invalid_bounded_chain_range');
        if(await client.getChainId()!==91342)throw failure('wrong_chain');
        const safe=await client.getBlock({blockTag:'safe'});if(safe.number===null)throw failure('safe_head_unavailable');safeHead=safe.number;
        const end=options.toBlock<safeHead?options.toBlock:safeHead;
        if(options.toBlock>safeHead)reasons.push('requested_range_extends_past_safe_head');
        const blocks=new Map<bigint,{number:bigint|null;hash:Hex|null;timestamp:bigint}>();
        const block=async(number:bigint)=>{let b=blocks.get(number);if(!b){b=await client.getBlock({blockNumber:number});blocks.set(number,b);}return b;};
        for(let from=options.fromBlock;from<=end;from+=2000n){
            const to=from+1999n<end?from+1999n:end;
            const logs=await client.getLogs({address:options.collection,fromBlock:from,toBlock:to});
            if(logs.length>20_000)throw failure('chain_log_limit');
            for(const log of logs){
                if(log.removed||log.blockNumber===null||log.blockHash===null||log.transactionHash===null||log.address.toLowerCase()!==options.collection.toLowerCase())throw failure('invalid_chain_log');
                const b=await block(log.blockNumber);
                if(log.blockNumber<from||log.blockNumber>to||b.hash?.toLowerCase()!==log.blockHash.toLowerCase())throw failure('noncanonical_chain_log');
                const at=Number(b.timestamp)*1000;if(at<start||at>now)continue;
                let decoded:ReturnType<typeof decodeEventLog>;
                try{decoded=decodeEventLog({abi:guardianAbi,data:log.data,topics:log.topics});}catch{throw failure('undecodable_collection_log');}
                const hash=`91342:${log.transactionHash.toLowerCase()}`,args=decoded.args as Record<string,unknown>;
                if(decoded.eventName==='MintRequested'){minted.add(hash);tokens.add(String(args.tokenId));all.add(hash);}
                else if(decoded.eventName==='BirthRerequested')all.add(hash); // a re-request after an oracle change is not a mint
                else if(decoded.eventName==='BirthRevealed'){revealed.add(hash);all.add(hash);}
                else if(decoded.eventName==='ResultClaimed'){claims.add(hash);actors.add(String(args.actor).toLowerCase());all.add(hash);}
            }
            scannedThrough=to;
        }
        rangeComplete=scannedThrough===options.toBlock;
        if(!paymentSourceAvailable)reasons.push('payment_source_missing');
        if(payments.length>MAX_PAYMENT_RECEIPTS){paymentComplete=false;reasons.push('payment_receipt_limit');}
        else for(const p of payments){
            try{
                const r=await client.getTransactionReceipt({hash:p.hash});
                if(r.status!=='success'||r.blockNumber>safeHead||reconcileSettlementReceipt({logs:r.logs,asset:MOCK_USDC.address,payer:p.payer,payTo:ARCADE_PAY_TO,amount:BigInt(p.amount)}).length)throw failure('unconfirmed_payment');
                const b=await block(r.blockNumber);if(b.hash?.toLowerCase()!==r.blockHash.toLowerCase())throw failure('orphan_payment');
                const at=Number(b.timestamp)*1000;if(at<start||at>now)continue;
                const hash=`91342:${p.hash.toLowerCase()}`;paid.add(hash);all.add(hash);
            }catch{paymentComplete=false;reasons.push('payment_unconfirmed');}
        }
    }catch{reasons.push('chain_scan_unavailable_or_invalid');}
    const complete=rangeComplete&&paymentComplete;
    return {coverage:{status:complete?'complete':'incomplete',chainId:91342,safeHead:safeHead?.toString()??null,
        requestedFrom:options.fromBlock?.toString()??null,requestedTo:options.toBlock?.toString()??null,scannedThrough:scannedThrough?.toString()??null,
        rangeComplete,paymentComplete,reasons:[...new Set(reasons)],rangeDeclaredByOperator:true},
        observedConfirmed:count(),completeCounts:complete?count():null,
        caveats:['Only the explicitly requested collection block range and supplied seller payment journal are observed.','Confirmations use canonical blocks at or below GIWA safe head; synthetic fixtures are not adoption.','Union deduplicates (chainId, transaction hash); category counts may overlap. Entropy reveal transactions are identified separately.']};
}

export async function guardiansReport(options:ReportOptions,client?:ChainClient){
    const now=options.asOf??Date.now();if(!Number.isSafeInteger(now)||now<0)throw failure('invalid_cutoff');
    const today=seoulDay(now),since=seoulDay(now-28*DAY_MS),start=Date.parse(since+'T00:00:00+09:00');
    const human=await engagement(options,now,since,today),agent=seller(options.sellerDb,start,now);
    const repeats=human.coverage.status==='available'&&agent.coverage.status==='available'?(()=>{
        const active=new Map<string,Set<string>>(),paid=new Set(agent.owners.filter(r=>r.day>=seoulDay(now-6*DAY_MS)).map(r=>r.owner));
        for(const r of human.operators){const days=active.get(r.owner)??new Set<string>();days.add(r.day);active.set(r.owner,days);}
        return [...active].filter(([owner,days])=>days.size>=2&&paid.has(owner)).length;
    })():null;
    const chain=options.chain?await chainActivity(options,agent.payments,agent.coverage.status==='available',start,now,
        client??createPublicClient({chain:giwaSepolia,transport:throttledHttp(giwaSepolia.rpcUrls.default.http[0],{}, {timeout:15_000,retryCount:0})})):null;
    return {generatedAt:new Date(now).toISOString(),timezone:'Asia/Seoul',window:{since,through:today,todayPartial:true},
        complete:human.coverage.status==='available'&&agent.coverage.status==='available'&&chain?.coverage.status==='complete',
        sources:{engagement:human.coverage,seller:agent.coverage,chain:chain?{status:chain.coverage.status}:{status:'missing',reason:'chain_verification_not_requested'}},
        engagement:human.report,autonomous:agent.report,repeatOperatorsLast7Days:repeats,
        repeatOperatorDefinition:'Authenticated foreground operator_action on at least two Seoul calendar days in the last seven, plus a completed verified paid admission in that interval.',
        chain,limitations:['Missing or incomplete sources are unknown, never zero.','No wallet, visitor, session, token or transaction identifiers are printed.','Collection block range coverage is operator-declared; this report cannot prove acquisition causality, unique people, anti-Sybil quality, or revenue.','Staff and operational canaries are included if present in supplied sources. Validate the real pilot cohort separately before claiming adoption.']};
}
export function parseReportOptions(argv:string[]):ReportOptions{
    const {values}=parseArgs({args:argv,strict:true,allowPositionals:false,options:{
        'engagement-db':{type:'string'},'engagement-sql':{type:'string'},'seller-db':{type:'string'},'as-of':{type:'string'},
        chain:{type:'boolean'},collection:{type:'string'},'from-block':{type:'string'},'to-block':{type:'string'},
    }});
    if(values['engagement-db']&&values['engagement-sql'])throw failure('ambiguous_engagement_source');
    if(values['as-of']&&!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(values['as-of']))throw failure('invalid_cutoff');
    const asOf=values['as-of']?Date.parse(values['as-of']):Date.now();if(!Number.isFinite(asOf))throw failure('invalid_cutoff');
    if(values.chain&&(!values.collection||!isAddress(values.collection)||!/^(0|[1-9][0-9]{0,19})$/.test(values['from-block']??'')||!/^(0|[1-9][0-9]{0,19})$/.test(values['to-block']??'')))throw failure('explicit_chain_range_required');
    if(!values.chain&&(values.collection||values['from-block']||values['to-block']))throw failure('chain_flag_required');
    return {engagementDb:values['engagement-db'],engagementSql:values['engagement-sql'],sellerDb:values['seller-db'],asOf,chain:values.chain,
        collection:values.collection as Address|undefined,fromBlock:values['from-block']?BigInt(values['from-block']):undefined,toBlock:values['to-block']?BigInt(values['to-block']):undefined};
}
if(import.meta.main){
    try{const report=await guardiansReport(parseReportOptions(process.argv.slice(2)));console.log(JSON.stringify(report,null,2));process.exitCode=report.complete?0:2;}
    catch{console.error('Report unavailable. Use read-only --engagement-db OR data-only --engagement-sql, --seller-db, --as-of ISO; optional --chain --collection ADDRESS --from-block N --to-block N. No source was modified.');process.exitCode=1;}
}
