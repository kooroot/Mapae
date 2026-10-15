import {describe,expect,test} from 'bun:test';
import {pad,toHex,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {guardianZodiac,type GuardianZodiac} from '../packages/arcade/src/guardians';
import {raffleDraw,type BlockReader,type SealedHall} from '../packages/arcade/src/hall';
import type {TeamRow} from '../packages/arcade/src/team';
import {checkRaffle,fetchHall,parseRaffleOptions,prizeMessage,verifyPrizeClaim} from './season-raffle';

const seedFor=(zodiac:GuardianZodiac)=>{for(let i=0;;i++){const seed=pad(toHex(i),{size:32});if(guardianZodiac(seed)===zodiac)return seed;}};
const hashOf=(n:bigint)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const CLOSE=Date.parse('2026-11-01T15:00:00Z');// the season ends 2026-11-01, so it closes at 11-02 00:00 KST
/** A chain of 2-second blocks whose block `first` is the first one at or after the close instant. */
function chain(latest:bigint,first:bigint,exact=true):{getBlock:BlockReader;reads:number[]}{
    const reads:number[]=[],closeSecond=Math.ceil(CLOSE/1000);
    const stamp=(n:bigint)=>BigInt(closeSecond)+(n-first)*2n-(exact?0n:1n);
    return {reads,getBlock:async query=>{const n='blockTag' in query?latest:query.blockNumber;reads.push(Number(n));if(n>latest)throw new Error('missing');return {number:n,hash:hashOf(n),timestamp:stamp(n)};}};
}
/** A sealed hall whose every entrant is a tiger with one full run, so the raffle pool is the whole season. */
function hall(closeBlock:{number:string;hash:Hex},pool:string[]=['5','12','88','7','3']):SealedHall{
    const seed=seedFor('tiger'),participants=[...pool].sort((a,b)=>Number(a)-Number(b));
    const team:TeamRow={rank:1,zodiac:'tiger',points:307,members:pool.length,top:{tokenId:participants[0]!,seed,points:187}};
    return {season:1,sealed:true,sealedAt:Date.parse('2026-11-02T15:00:00Z'),start:'2026-10-05',end:'2026-11-01',entrants:pool.length,
        podium:participants.slice(0,3).map((tokenId,i)=>({rank:i+1,tokenId,seed,points:187-10*i,days:9})),teams:[team],champions:[],
        streakPool:participants.map(tokenId=>({tokenId,seed,runs:1})),closeBlock,raffle:raffleDraw(closeBlock.hash,pool),participants};
}

describe('checkRaffle',()=>{
    test('finds the first block at or after the close by binary search and redraws the same winners',async()=>{
        const {getBlock,reads}=chain(31_700_900n,31_700_000n),sealed={number:'31700000',hash:hashOf(31_700_000n)};
        const check=await checkRaffle(hall(sealed),getBlock);
        expect(check.block).toEqual(sealed);expect(check.match).toBe(true);expect(check.pool).toEqual(['3','5','7','12','88']);
        expect(check.winners).toEqual(raffleDraw(sealed.hash,['3','5','7','12','88']));expect(check.winners).toEqual(check.sealedWinners);
        expect(reads.length).toBeLessThan(40);
    });
    test('a block one second short of the close is not the close block; the next one is',async()=>{
        const {getBlock}=chain(31_700_900n,31_700_000n,false);
        expect((await checkRaffle(hall({number:'31700000',hash:hashOf(31_700_000n)}),getBlock)).match).toBe(false);
        expect((await checkRaffle(hall({number:'31700001',hash:hashOf(31_700_001n)}),getBlock)).match).toBe(true);
    });
    test('the latest block can be the close block, and a chain before the close cannot be checked yet',async()=>{
        const {getBlock}=chain(31_700_000n,31_700_000n);
        expect((await checkRaffle(hall({number:'31700000',hash:hashOf(31_700_000n)}),getBlock)).match).toBe(true);
        const early=chain(31_699_999n,31_700_000n).getBlock;
        await expect(checkRaffle(hall({number:'31700000',hash:hashOf(31_700_000n)}),early)).rejects.toThrow('Chain has not reached the season close');
    });
    test('a sealed hall with another hash or another winner list does not match',async()=>{
        const {getBlock}=chain(31_700_900n,31_700_000n),sealed={number:'31700000',hash:hashOf(31_700_000n)};
        expect((await checkRaffle(hall({number:'31700000',hash:hashOf(31_700_777n)}),getBlock)).match).toBe(false);
        const tampered={...hall(sealed),raffle:['3','5','7','12','88'].slice(0,5)};
        const check=await checkRaffle(tampered,getBlock);
        expect(check.match).toBe(check.winners.join()===tampered.raffle.join());
        expect(check.winners.length).toBe(5);expect(new Set(check.winners).size).toBe(5);
    });
});
describe('fetchHall',()=>{
    const sealed=hall({number:'31700000',hash:hashOf(31_700_000n)},['5','12']);
    const serve=(body:unknown,status=200)=>(async()=>Response.json(body,{status})) as unknown as typeof fetch;
    test('a sealed hall passes through the strict parser; unsealed, invalid or failed answers throw',async()=>{
        expect(await fetchHall('https://mapae.io/api/arcade/ranking/hall/s1',1,serve(sealed))).toEqual(sealed);
        await expect(fetchHall('https://x/',1,serve({season:1,sealed:false,sealsAt:Date.parse('2026-11-02T15:00:00Z')}))).rejects.toThrow('hall_not_sealed');
        await expect(fetchHall('https://x/',2,serve(sealed))).rejects.toThrow('invalid_hall');
        await expect(fetchHall('https://x/',1,serve({...sealed,raffle:['12','5','5','5','5']}))).rejects.toThrow('invalid_hall');
        await expect(fetchHall('https://x/',1,serve({error:'not found'},404))).rejects.toThrow('hall_http_404');
    });
});
describe('verifyPrizeClaim',()=>{
    const owner=privateKeyToAccount(`0x${'11'.repeat(32)}`),other=privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const ownerOf=async(tokenId:bigint):Promise<Address>=>{if(tokenId!==407n)throw new Error('ERC721NonexistentToken');return owner.address;};
    test('the owner signing the exact sentence passes; another wallet, another handle or another guardian fails',async()=>{
        const message=prizeMessage(1,'407','mapae_fan');
        expect(message).toBe('Mapae Arcade Season 1 prize\nGuardian #407\nX: @mapae_fan');
        const signature=await owner.signMessage({message});
        const ok=await verifyPrizeClaim({season:1,tokenId:'407',handle:'mapae_fan',signature},ownerOf);
        expect(ok).toEqual({owner:owner.address,message,valid:true});
        expect((await verifyPrizeClaim({season:1,tokenId:'407',handle:'someone_else',signature},ownerOf)).valid).toBe(false);
        expect((await verifyPrizeClaim({season:1,tokenId:'407',handle:'mapae_fan',signature:await other.signMessage({message})},ownerOf)).valid).toBe(false);
        expect((await verifyPrizeClaim({season:2,tokenId:'407',handle:'mapae_fan',signature},ownerOf)).valid).toBe(false);
        await expect(verifyPrizeClaim({season:1,tokenId:'408',handle:'mapae_fan',signature},ownerOf)).rejects.toThrow('ERC721NonexistentToken');
    });
});
describe('parseRaffleOptions',()=>{
    const collection='0x5555555555555555555555555555555555555555' as Address,signature=`0x${'ab'.repeat(65)}` as Hex;
    test('check defaults to the live hall and public RPC; verify needs every claim field; junk is refused',()=>{
        expect(parseRaffleOptions(['--season','1'])).toEqual({command:'check',season:1,hallUrl:'https://mapae.io/api/arcade/ranking/hall/s1',rpc:expect.stringMatching(/^https:\/\//)});
        expect(parseRaffleOptions(['--season','2','--hall-url','https://staging.example/hall/s2','--rpc','https://rpc.example'])).toEqual({command:'check',season:2,hallUrl:'https://staging.example/hall/s2',rpc:'https://rpc.example'});
        expect(parseRaffleOptions(['verify','--collection',collection,'--token','407','--handle','mapae_fan','--signature',signature]))
            .toEqual({command:'verify',claim:{season:1,tokenId:'407',handle:'mapae_fan',signature},collection,rpc:expect.stringMatching(/^https:\/\//)});
        for(const argv of [['--season','0'],['--season','x'],['--hall-url','http://mapae.io/hall/s1'],['--rpc','http://rpc'],['--token','407'],['draw'],['verify'],
            ['verify','--collection','0x12','--token','407','--handle','a','--signature',signature],['verify','--collection',collection,'--token','0','--handle','a','--signature',signature],
            ['verify','--collection',collection,'--token','407','--handle','@mapae_fan','--signature',signature],['verify','--collection',collection,'--token','407','--handle','a','--signature','0xab'],
            ['verify','--collection',collection,'--token','407','--handle','a','--signature',signature,'--hall-url','https://x/']])expect(()=>parseRaffleOptions(argv)).toThrow();
    });
});
