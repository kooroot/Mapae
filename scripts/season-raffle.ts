/**
 * Re-checks a sealed season's raffle on the public RPC and confirms a prize claim's ownership. Read-only: nothing is signed,
 * broadcast or written. The hall comes from the ranking proxy, the close block from an independent binary search, and the
 * draw from the same keccak256 formula the seller used.
 *
 *   bun --no-env-file scripts/season-raffle.ts --season 1 [--hall-url URL] [--rpc URL]
 *   bun --no-env-file scripts/season-raffle.ts verify --collection 0x… --token 407 --handle name --signature 0x… [--season 1] [--rpc URL]
 */
import {parseArgs} from 'node:util';
import {createPublicClient,isAddress,verifyMessage,type Address,type Hex} from 'viem';
import {giwaSepolia,redactForLog} from '../packages/shared/src/index';
import {throttledHttp} from '../packages/delegation/src/index';
import {byTokenId,findCloseBlock,raffleDraw,type BlockReader,type SealedHall} from '../packages/arcade/src/hall';
import {SEASON,seasonEndsAt} from '../packages/arcade/src/season';
import {guardianAbi} from '../packages/arcade/src/guardian-abi';
import {parseSeasonHall} from '../apps/web/src/arcade/ranking/api';

const failure=(code:string)=>new Error(code);
export const hallUrl=(season:number)=>`https://mapae.io/api/arcade/ranking/hall/s${season}`;
/** The one sentence a winner signs: the season, the guardian, and the X account the prize goes to. */
export const prizeMessage=(season:number,tokenId:string,handle:string)=>`Mapae Arcade Season ${season} prize\nGuardian #${tokenId}\nX: @${handle}`;

export type RaffleCheck={season:number;block:{number:string;hash:Hex};sealed:{number:string;hash:Hex};pool:string[];winners:string[];sealedWinners:string[];match:boolean};
/** The seller's sealed draw against our own: the close block found again from the chain, the pool sorted, the winners redrawn. */
export async function checkRaffle(hall:SealedHall,getBlock:BlockReader):Promise<RaffleCheck>{
    const block=await findCloseBlock(getBlock,seasonEndsAt({id:hall.season,start:hall.start,end:hall.end})!);
    const pool=hall.streakPool.map(entrant=>entrant.tokenId).sort(byTokenId),winners=raffleDraw(block.hash,pool);
    const match=block.number===hall.closeBlock.number&&block.hash===hall.closeBlock.hash&&winners.join(',')===hall.raffle.join(',');
    return {season:hall.season,block,sealed:hall.closeBlock,pool,winners,sealedWinners:hall.raffle,match};
}
/** The hall as the proxy serves it, through the same strict parser the web uses; only a sealed hall can be checked. */
export async function fetchHall(url:string,season:number,fetchFn:typeof fetch=fetch):Promise<SealedHall>{
    const response=await fetchFn(url);
    if(!response.ok)throw failure(`hall_http_${response.status}`);
    const hall=parseSeasonHall(await response.json(),season);
    if(!hall)throw failure('invalid_hall');
    if(!hall.sealed)throw failure('hall_not_sealed');
    return hall;
}
export type OwnerReader=(tokenId:bigint)=>Promise<Address>;
export type PrizeClaim={season:number;tokenId:string;handle:string;signature:Hex};
/** Whether the claim's signature recovers to the guardian's owner right now. */
export async function verifyPrizeClaim(claim:PrizeClaim,ownerOf:OwnerReader):Promise<{owner:Address;message:string;valid:boolean}>{
    const message=prizeMessage(claim.season,claim.tokenId,claim.handle),owner=await ownerOf(BigInt(claim.tokenId));
    return {owner,message,valid:await verifyMessage({address:owner,message,signature:claim.signature})};
}

export type RaffleOptions={command:'check';season:number;hallUrl:string;rpc:string}|{command:'verify';claim:PrizeClaim;collection:Address;rpc:string};
export function parseRaffleOptions(argv:string[]):RaffleOptions{
    const {values,positionals}=parseArgs({args:argv,strict:true,allowPositionals:true,options:{
        season:{type:'string'},'hall-url':{type:'string'},rpc:{type:'string'},collection:{type:'string'},token:{type:'string'},handle:{type:'string'},signature:{type:'string'},
    }});
    const season=values.season===undefined?SEASON.id:/^[1-9]\d{0,3}$/.test(values.season)?Number(values.season):NaN;
    if(!Number.isInteger(season))throw failure('invalid_season');
    const rpc=values.rpc??giwaSepolia.rpcUrls.default.http[0]!;
    if(!/^https:\/\//.test(rpc))throw failure('invalid_rpc');
    if(positionals.length===0){
        if(values.collection||values.token||values.handle||values.signature)throw failure('verify_command_required');
        const url=values['hall-url']??hallUrl(season);
        if(!/^https:\/\//.test(url))throw failure('invalid_hall_url');
        return {command:'check',season,hallUrl:url,rpc};
    }
    if(positionals.length!==1||positionals[0]!=='verify'||values['hall-url'])throw failure('unknown_command');
    const {collection,token,handle,signature}=values;
    if(!collection||!isAddress(collection))throw failure('invalid_collection');
    if(!token||!/^[1-9]\d{0,9}$/.test(token))throw failure('invalid_token');
    if(!handle||!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw failure('invalid_handle');
    if(!signature||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw failure('invalid_signature');
    return {command:'verify',claim:{season,tokenId:token,handle,signature:signature as Hex},collection,rpc};
}
export async function run(options:RaffleOptions):Promise<{output:unknown;ok:boolean}>{
    const client=createPublicClient({chain:giwaSepolia,transport:throttledHttp(options.rpc,{},{timeout:15_000,retryCount:0})});
    if(options.command==='check'){
        const check=await checkRaffle(await fetchHall(options.hallUrl,options.season),query=>client.getBlock(query));
        return {output:check,ok:check.match};
    }
    const result=await verifyPrizeClaim(options.claim,tokenId=>client.readContract({address:options.collection,abi:guardianAbi,functionName:'ownerOf',args:[tokenId]}));
    return {output:{tokenId:options.claim.tokenId,handle:options.claim.handle,...result},ok:result.valid};
}
if(import.meta.main){
    try{const {output,ok}=await run(parseRaffleOptions(process.argv.slice(2)));console.log(JSON.stringify(output,null,2));process.exitCode=ok?0:1;}
    catch(error){console.error('Raffle check failed:',redactForLog(error),'Usage: --season N [--hall-url URL] [--rpc URL], or verify --collection ADDRESS --token ID --handle NAME --signature 0x… [--season N]. Nothing was written.');process.exitCode=1;}
}
