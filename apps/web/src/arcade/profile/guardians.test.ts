import {afterEach,describe,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {emptyHonors,guardianTraitsHash} from '@mapae/arcade/guardians';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';
import {kstDay} from '@mapae/arcade/ranking';
import type {Address} from 'viem';
import {emptyProgress,type GuardianRoster} from '../../../../delegated-seller/guardians/types';
import {profileRepository} from './repository';
import {profileApi} from './api';
import {tokenHash} from '../../lib/siwe-session';
import {d1} from './test-db';
import {guardiansApi,validGuardianSnapshot} from './guardians';

const owner='0x1111111111111111111111111111111111111111' as Address,other='0x2222222222222222222222222222222222222222' as Address;
const session='a'.repeat(64),receiptToken='receipt-token'.repeat(4),now=2_000_000_000_000;
const seed=`0x${'77'.repeat(32)}` as const,id=`0x${'44'.repeat(32)}` as const;
const base='https://mapae.io/api/arcade/profile/guardians',dbs:Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
async function repository(){
    const db=new Database(':memory:');dbs.push(db);db.exec(readFileSync(new URL('../../../schema/arcade.sql',import.meta.url),'utf8'));
    const repo=profileRepository(d1(db));await repo.session(await tokenHash(session),{owner,origin:'https://mapae.io',expires_at:now+10000});return repo;
}
const request=(suffix='',method='GET',body?:unknown,headers:Record<string,string>={})=>new Request(base+suffix,{method,headers:{Origin:'https://mapae.io','Content-Type':'application/json',Cookie:`__Host-mapae-arcade-session=${session}`,'X-Mapae-Wallet':owner,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const token={tokenId:'1',owner,ownershipEpoch:'1',revealed:true,seed,sequence:'1',progress:emptyProgress(),honors:emptyHonors()};
const roster:GuardianRoster={enabled:true,chainId:91342,collection:other,signer:other,mintFee:'12',minted:1,pendingTokenId:null,guardians:[token]};
const response=(value:unknown)=>async()=>Response.json(value);
const result={resultId:id,tokenId:'1',actor:owner,ownershipEpoch:'1',paymentTx:id,traitsHash:guardianTraitsHash(seed),inputsHash:seed,ruleset:ARCADE_RULESET_VERSION,seed:1,game:0,score:10,victory:false};
const claim={collection:other,signer:other,claims:[{result,signature:`0x${'11'.repeat(65)}`}],honor:null};
const honors={week:2961,longestStreak:7,titles:[{champion:1,podium:0,top10:2},{champion:0,podium:3,top10:0},{champion:4,podium:0,top10:5}]};
const honor={honor:{tokenId:'1',week:2961,longestStreak:7,titles:String(0x500000004000000030000000200000001n)},signature:`0x${'22'.repeat(65)}`};
describe('authenticated guardian bridge',()=>{
    test('auth, CSRF, methods and rate limits precede any trusted seller call',async()=>{
        const repo=await repository();let calls=0;
        const options={now,guardians:(r:Request,a:Address,v:unknown)=>guardiansApi(r,a,v,{receiptToken,fetcher:async()=>{calls++;return Response.json(roster);}})};
        expect((await profileApi(request(),repo,options)).status).toBe(200);
        for(const headers of [{Cookie:''},{'X-Mapae-Wallet':other}] as Record<string,string>[])expect((await profileApi(request('','GET',undefined,headers),repo,options)).status).toBe(401);
        expect((await profileApi(request('/1/claims','POST',{}, {Origin:'https://evil.test'}),repo,options)).status).toBe(403);
        expect((await profileApi(request('','POST',{}),repo,options)).status).toBe(405);
        expect((await profileApi(request('?owner='+other),repo,options)).status).toBe(403);
        expect(calls).toBe(1);
        for(let i=1;i<30;i++)await profileApi(request(),repo,options);
        expect((await profileApi(request(),repo,options)).status).toBe(429);
    });
    test('exact token cursor path passes and generic queries/targets fail closed',async()=>{
        const repo=await repository();let target='',headers:HeadersInit|undefined;
        const options={now,guardians:(r:Request,a:Address,v:unknown)=>guardiansApi(r,a,v,{receiptToken,fetcher:async(url,init)=>{target=url;headers=init?.headers;return Response.json({guardian:token,earned:emptyProgress(),honors:null,results:[],nextCursor:null});}})};
        expect((await profileApi(request('/1?before=10'),repo,options)).status).toBe(200);
        expect(target).toBe('https://seller.mapae.io/arcade/guardians/1?before=10');
        expect(new Headers(headers).get('X-Mapae-Owner')).toBe(owner);expect(new Headers(headers).get('Authorization')).toBe('Bearer '+receiptToken);
        for(const suffix of ['/1?before=-1','/1?before=1&before=2','/1?before=9007199254740992','/1?url=https://evil.test','?before=1'])
            expect((await profileApi(request(suffix),repo,options)).status).toBe(403);
    });
    test('a batch claim names one guardian; client input is never forwarded and the seller target is exact',async()=>{
        let sent:RequestInit|undefined,target='';
        const r=await guardiansApi(request('/1/claims','POST',{score:999999}),owner,null,{receiptToken,fetcher:async(url,init)=>{target=url;sent=init;return Response.json({...claim,privateKey:'secret',claims:[{...claim.claims[0],extra:'secret',result:{...result,permission:'secret'}}]});}});
        expect(r.status).toBe(200);expect(sent?.body).toBeUndefined();expect(sent?.method).toBe('POST');expect(target).toBe('https://seller.mapae.io/arcade/guardians/1/claims');
        expect(await r.json<unknown>()).toEqual(claim);
        const repo=await repository();let calls=0;
        const options={now,guardians:(q:Request,a:Address,v:unknown)=>{calls++;expect(v).toBeNull();return guardiansApi(q,a,v,{receiptToken,fetcher:response(claim)});}};
        // A bodiless POST is the browser's natural request; it must reach the seller.
        expect((await profileApi(new Request(base+'/1/claims',{method:'POST',headers:{Origin:'https://mapae.io','Content-Type':'application/json',Cookie:`__Host-mapae-arcade-session=${session}`,'X-Mapae-Wallet':owner}}),repo,options)).status).toBe(200);
        expect((await profileApi(request('/1/claims'),repo,options)).status).toBe(405);
        for(const path of ['/01/claims','/1/claim',`/results/${id}/claim`])expect((await profileApi(request(path,'POST',{}),repo,options)).status).toBe(404);
        for(let i=1;i<6;i++)await profileApi(request('/1/claims','POST',{}),repo,options);
        expect((await profileApi(request('/1/claims','POST',{}),repo,options)).status).toBe(429);expect(calls).toBe(6);
    });
    test('real seller completion produces a validated permanent detail through the bridge',async()=>{
        const {OutingStore}=await import('../../../../delegated-seller/outings/store');
        const {OutingRunner}=await import('../../../../delegated-seller/outings/runner');
        const {createGuardianApp}=await import('../../../../delegated-seller/guardians/routes');
        const s=new OutingStore(':memory:');
        const snapshot={chainId:91342 as const,collection:other,tokenId:'1',owner,ownershipEpoch:'1',seed,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION};
        const reader={collection:other,inspect:async()=>snapshot,token:async()=>token,claimed:async()=>false,roster:async()=>roster};
        try{
            s.insert(owner,{id:'verified-bridge-job',tokenId:'1',goal:'explore',locale:'ko',choice:'stamp',admissions:1,permissionContext:'0xabcd'},{payer:owner,expiresAt:now+7200_000,contextHash:id},other,now,snapshot);
            await new OutingRunner(s,other,{async pay(_j,_p,persist){persist('must-never-reach-browser');return id;}},reader,()=>now).tick();
            const app=createGuardianApp({token:receiptToken,reader,ledger:s.guardians});
            const r=await guardiansApi(request('/1'),owner,null,{receiptToken,fetcher:async(url,init)=>app.request(new Request(url.replace('https://seller.mapae.io/arcade/guardians','https://seller.mapae.io'),init))});
            expect(r.status).toBe(200);
            const body=await r.json<{earned:{plays:number};results:{ranked?:unknown;outcome:{achievement:{victory:boolean}}}[]}>();
            expect(body.earned.plays).toBe(1);expect(body.results).toHaveLength(1);expect(typeof body.results[0]!.outcome.achievement.victory).toBe('boolean');
            expect(JSON.stringify(body)).not.toContain('must-never-reach-browser');
            // The seller marks the first stamp round today as ranked attempt 1; the bridge checks it against the fixed seed.
            const raw=await (await app.request('/1',{headers:{Authorization:`Bearer ${receiptToken}`,'X-Mapae-Owner':owner}})).json<{results:Record<string,unknown>[]}>();
            expect(raw.results[0]!.ranked).toEqual({day:kstDay(now),attempt:1});
            expect(body.results[0]!.ranked).toEqual({day:kstDay(now),attempt:1});
            const tampered=(ranked:unknown)=>guardiansApi(request('/1'),owner,null,{receiptToken,fetcher:response({...raw,results:[{...raw.results[0],ranked}]})});
            for(const ranked of [{day:kstDay(now),attempt:2},{day:kstDay(now),attempt:4},{day:'2026-01-01',attempt:1},{day:kstDay(now),attempt:1,bonus:true}])expect((await tampered(ranked)).status).toBe(503);
            const unranked=await tampered(undefined);expect(unranked.status).toBe(200);
            expect((await unranked.json<{results:object[]}>()).results[0]).not.toHaveProperty('ranked');
        }finally{s.close();}
    });
    test('response projections strip extra fields and reject wrong owner or identity',async()=>{
        const r=await guardiansApi(request(),owner,null,{receiptToken,fetcher:response({...roster,secret:'hidden',guardians:[{...token,secret:'hidden',progress:{...emptyProgress(),secret:'hidden'}}]})});
        expect(await r.json<unknown>()).toEqual(roster);
        for(const value of [{...roster,guardians:[{...token,owner:other}]},{...roster,guardians:[token,token]},{...roster,mintFee:'NaN'}])
            expect((await guardiansApi(request(),owner,null,{receiptToken,fetcher:response(value)})).status).toBe(503);
        const batch=(value:unknown)=>guardiansApi(request('/1/claims','POST'),owner,null,{receiptToken,fetcher:response(value)});
        for(const patch of [{tokenId:'2'},{tokenId:'01'},{ownershipEpoch:'0'},{game:3},{score:1e10},{seed:2**32},{ruleset:1}])
            expect((await batch({...claim,claims:[{...claim.claims[0],result:{...result,...patch}}]})).status).toBe(503);
        for(const value of [{...claim,claims:[{...claim.claims[0],signature:'0x11'}]},{...claim,claims:[claim.claims[0],claim.claims[0]]},{...claim,claims:Array.from({length:33},(_,i)=>({...claim.claims[0],result:{...result,resultId:`0x${i.toString(16).padStart(64,'0')}`,paymentTx:`0x${i.toString(16).padStart(64,'1')}`}}))},{...claim,signer:'nope'}])
            expect((await batch(value)).status).toBe(503);
    });
    test('honors: token, detail and signed honor shapes are exact uint16 lanes of the requested guardian',async()=>{
        const detail={guardian:{...token,honors},earned:emptyProgress(),honors:{...honors,week:2962},results:[],nextCursor:null};
        const get=(value:unknown)=>guardiansApi(request('/1'),owner,null,{receiptToken,fetcher:response(value)});
        const ok=await get({...detail,honors:{...detail.honors,secret:'hidden',titles:detail.honors.titles.map(t=>({...t,secret:'hidden'}))}});
        expect(ok.status).toBe(200);expect(await ok.json<unknown>()).toEqual(detail);
        expect((await get({...detail,honors:null})).status).toBe(200);
        for(const bad of [{week:0},{week:65536},{longestStreak:-1},{longestStreak:1.5},{titles:honors.titles.slice(1)},{titles:[{champion:65536,podium:0,top10:0},...honors.titles.slice(1)]},{titles:[{champion:1},...honors.titles.slice(1)]}]){
            expect((await get({...detail,honors:{...honors,...bad}})).status).toBe(503);
            if(!('week' in bad&&bad.week===0))expect((await get({...detail,guardian:{...token,honors:{...honors,...bad}}})).status).toBe(503);
        }
        expect((await get({...detail,honors:undefined})).status).toBe(503);
        expect((await guardiansApi(request(),owner,null,{receiptToken,fetcher:response({...roster,guardians:[{...token,honors:undefined}]})})).status).toBe(503);
        const batch=(value:unknown)=>guardiansApi(request('/1/claims','POST'),owner,null,{receiptToken,fetcher:response(value)});
        const signed=await batch({...claim,honor:{...honor,extra:'secret',honor:{...honor.honor,owner:'secret'}}});
        expect(signed.status).toBe(200);expect(await signed.json<unknown>()).toEqual({...claim,honor});
        for(const patch of [{tokenId:'2'},{week:0},{week:65536},{longestStreak:65536},{titles:(1n<<144n).toString()},{titles:'0x10'},{titles:'01'},{titles:1}])
            expect((await batch({...claim,honor:{...honor,honor:{...honor.honor,...patch}}})).status).toBe(503);
        for(const value of [{...claim,honor:{...honor,signature:'0x22'}},{...claim,honor:undefined},
            {...claim,honor,claims:Array.from({length:32},(_,i)=>({...claim.claims[0],result:{...result,resultId:`0x${i.toString(16).padStart(64,'0')}`,paymentTx:`0x${i.toString(16).padStart(64,'1')}`}}))}])
            expect((await batch(value)).status).toBe(503);
        expect((await batch({...claim,claims:[],honor})).status).toBe(200);
    });
    test('disabled, redirect, oversized, non-JSON and private upstream errors never leak',async()=>{
        expect(await (await guardiansApi(request(),owner,null,{})).json()).toMatchObject({enabled:false,collection:null});
        for(const r of [new Response(null,{status:302,headers:{Location:'https://evil.test'}}),new Response('x'.repeat(1_048_577)),new Response('bad'),Response.json({error:{code:'secret-url-key'}},{status:500})]){
            const response=await guardiansApi(request(),owner,null,{receiptToken,fetcher:async()=>r});
            expect(response.status).toBe(503);expect(await response.json<unknown>()).toEqual({error:{code:'guardian_unavailable'}});
        }
    });
    test('snapshot binds a valid seed hash and bounded onchain epoch',()=>{
        const v={chainId:91342,collection:other,tokenId:'1',owner,ownershipEpoch:'1',seed,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION};
        expect(validGuardianSnapshot(v)).toBe(true);
        for(const patch of [{traitsHash:seed},{chainId:1},{ownershipEpoch:(1n<<64n).toString()},{tokenId:'0'}])expect(validGuardianSnapshot({...v,...patch})).toBe(false);
    });
});
