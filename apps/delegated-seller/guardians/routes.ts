import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {getAddress, isAddress, isHash, type Address, type Hex} from 'viem';
import {OutingError, validTokenId} from '../outings/validation';
import {resultView, type GuardianLedger} from './ledger';
import type {GuardianClaim, GuardianDetail, GuardianReader, GuardianRoster} from './types';

export function createGuardianApp(options: {
    token?: string; reader?: GuardianReader; ledger?: GuardianLedger;
    claim?: (owner:Address,id:Hex)=>Promise<GuardianClaim>;
}) {
    const app = new Hono<{Variables:{owner:Address}}>(), digest = (v:string)=>createHash('sha256').update(v).digest();
    app.use('*', async(c,next)=>{
        c.header('Cache-Control','private, no-store'); c.header('X-Content-Type-Options','nosniff');
        if (!options.token || !timingSafeEqual(digest(c.req.header('Authorization')??''),digest(`Bearer ${options.token}`))) return c.json({error:{code:'unauthorized'}},401);
        const owner=c.req.header('X-Mapae-Owner'); if(!owner || !isAddress(owner)) return c.json({error:{code:'unauthorized'}},401);
        c.set('owner',getAddress(owner)); await next();
    });
    app.get('/',async c=>{
        if (!options.reader) return c.json({enabled:false,chainId:91342,collection:null,signer:null,mintFee:null,minted:0,pendingTokenId:null,guardians:[]} satisfies GuardianRoster);
        return c.json(await options.reader.roster(c.get('owner')));
    });
    app.get('/:tokenId',async c=>{
        if(!options.reader || !options.ledger) throw new OutingError('disabled');
        const id=c.req.param('tokenId'); if(!validTokenId(id)) throw new OutingError('invalid_request');
        const owner=c.get('owner'), token=await options.reader.token(id);
        if(token.owner.toLowerCase()!==owner.toLowerCase()) throw new OutingError('not_found');
        const cursor=c.req.query('before');
        if (cursor !== undefined && !/^[1-9][0-9]{0,15}$/.test(cursor)) throw new OutingError('invalid_request');
        const rows=options.ledger.list(options.reader.collection,id,cursor);
        const results=await Promise.all(rows.map(async r=>resultView(r,owner,await options.reader!.claimed(r.result.resultId))));
        return c.json({guardian:token,earned:options.ledger.progress(options.reader.collection,id),results,
            nextCursor:rows.length===40?options.ledger.cursor(rows.at(-1)!.result.resultId):null} satisfies GuardianDetail);
    });
    app.post('/results/:id/claim',async c=>{
        if(!options.claim) throw new OutingError('disabled');
        const id=c.req.param('id'); if(!isHash(id)) throw new OutingError('invalid_request');
        // The request selects exactly one existing result; it cannot submit gameplay.
        if (Number(c.req.header('Content-Length')??0)>1024) throw new OutingError('invalid_request');
        return c.json(await options.claim(c.get('owner'),id));
    });
    app.onError(error=>{
        const code=error instanceof OutingError?error.code:'guardian_unavailable';
        const status=code==='not_found'?404:code==='unauthorized'?401:code==='invalid_request'?400:code==='receipt_unconfirmed'?409:503;
        return Response.json({error:{code}},{status,headers:{'Cache-Control':'private, no-store'}});
    });
    return app;
}
