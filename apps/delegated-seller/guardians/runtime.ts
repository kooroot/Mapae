import {createPublicClient, getAddress, isAddress, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {throttledHttp, reconcileSettlementReceipt} from '@mapae/delegation';
import {giwaSepolia, parseNodeRpcUrl, MOCK_USDC} from '@mapae/shared';
import {ARCADE_RULESET_VERSION} from '@mapae/arcade';
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_TICKET_AMOUNT} from '@mapae/arcade/tickets';
import {guardianAbi} from '@mapae/arcade/guardian-abi';
import {findCloseBlock} from '@mapae/arcade/hall';
import {
    guardianHonorFromJson, guardianHonorJson, guardianTraitsHash, guardianResultDomain, guardianResultFromJson, honorAdvances, GUARDIAN_CLAIM_BATCH, GUARDIAN_HONOR_TYPES, GUARDIAN_RESULT_TYPES,
} from '@mapae/arcade/guardians';
import {OutingError, validTokenId} from '../outings/validation';
import {type GuardianReader, type GuardianToken, type GuardianRoster, type GuardianSnapshot, type GuardianClaimBatch, type Progress, type ReceiptEvidence} from './types';
import type {GuardianLedger, StoredResult} from './ledger';
import type {CloseBlock} from '../ranking/board';
import type {GuardianHonorBook} from '../ranking/honors';

export function readGuardianConfig(env: Record<string,string | undefined> = process.env) {
    if (env.ARCADE_OUTINGS_ENABLED !== 'true') return null;
    const address = env.ARCADE_GUARDIAN_ADDRESS?.trim(), key = env.ARCADE_RESULT_PRIVATE_KEY?.trim();
    if (!address || !isAddress(address) || /^0x0{40}$/i.test(address)) throw new Error('ARCADE_GUARDIAN_ADDRESS required');
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ARCADE_RESULT_PRIVATE_KEY required');
    let signer: ReturnType<typeof privateKeyToAccount>;
    try {signer = privateKeyToAccount(key as Hex);} catch {throw new Error('ARCADE_RESULT_PRIVATE_KEY invalid');}
    for (const name of ['ARCADE_AGENT_PRIVATE_KEY','PRIVATE_KEY','DEPLOYER_PRIVATE_KEY','GUARDIAN_DEPLOYER_PRIVATE_KEY','FRAMEWORK_ADMIN_PRIVATE_KEY','GUARDIAN_ADMIN_PRIVATE_KEY','FACILITATOR_SIGNER_PRIVATE_KEY','BOOTSTRAP_PRIVATE_KEY','REVOCATION_RELAYER_PRIVATE_KEY','REVOCATION_SPONSOR_PRIVATE_KEY']) {
        const value = env[name]?.trim(); if (!value) continue;
        let other: Address; try {other = privateKeyToAccount(value as Hex).address;} catch {throw new Error(`${name} invalid`);}
        if (other === signer.address) throw new Error('Result signer must be a separate unfunded role');
    }
    for (const name of ['DEPLOYER_ADDRESS','GUARDIAN_DEPLOYER_ADDRESS','FRAMEWORK_ADMIN_ADDRESS','GUARDIAN_ADMIN_ADDRESS','FACILITATOR_SIGNER_ADDRESS','BOOTSTRAP_ADDRESS','REVOCATION_RELAYER_ADDRESS','REVOCATION_SPONSOR_ADDRESS']) {
        const value = env[name]?.trim(); if (value && (!isAddress(value) || getAddress(value) === signer.address)) throw new Error('Result signer role conflict');
    }
    if (signer.address === ARCADE_PAY_TO || signer.address === ARCADE_REDEEMER) throw new Error('Result signer role conflict');
    return {collection: getAddress(address), signer, rpcUrl: parseNodeRpcUrl(env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0])};
}
type Config = NonNullable<ReturnType<typeof readGuardianConfig>>;
export type GuardianClient = Pick<PublicClient, 'readContract' | 'getBlock' | 'getTransactionReceipt' | 'getChainId'>;
/** The season's close block for the hall of fame: a binary search over the chain on the guardian RPC, about 25 block reads once per season. */
export function createCloseBlockReader(config: Config, client: Pick<GuardianClient, 'getBlock'> = createPublicClient({chain: giwaSepolia, transport: throttledHttp(config.rpcUrl, {}, {timeout: 15_000, retryCount: 1})})): CloseBlock {
    return at => findCloseBlock(query => client.getBlock(query), at);
}
/** How far behind the wall clock honors are sealed: well past any lag between the chain head and this process. */
export const HONOR_CLOCK_MARGIN_MS = 10 * 60_000;
export function createGuardianReader(config: Config, client: GuardianClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(config.rpcUrl, {}, {timeout: 15_000, retryCount: 1})})): GuardianReader {
    const read = (functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) => client.readContract({
        address: config.collection, abi: guardianAbi, functionName, args, ...(blockNumber === undefined ? {} : {blockNumber}),
    } as Parameters<GuardianClient['readContract']>[0]) as Promise<unknown>;
    async function block() {
        if (await client.getChainId() !== 91342) throw new OutingError('guardian_unavailable');
        const b = await client.getBlock({blockTag: 'latest'}); if (b.number === null) throw new OutingError('guardian_unavailable'); return b.number;
    }
    async function token(tokenId: string, at?: bigint): Promise<GuardianToken> {
        if (!validTokenId(tokenId)) throw new OutingError('invalid_request');
        const n = at ?? await block(), id = BigInt(tokenId);
        const [owner, epoch, birth, progress] = await Promise.all([
            read('ownerOf',[id],n), read('ownershipEpoch',[id],n), read('birth',[id],n), read('progress',[id],n),
        ]);
        const [seed, sequence, revealed] = birth as readonly [Hex,bigint,boolean];
        const p = progress as {plays:bigint;victories:bigint;experience:bigint;gamePlays:readonly bigint[];gameVictories:readonly bigint[];bestScores:readonly number[];
            honorWeek:number;longestStreak:number;champion:readonly number[];podium:readonly number[];top10:readonly number[]};
        const growth: Progress = {plays: Number(p.plays), victories: Number(p.victories), experience: Number(p.experience), level: 1 + Number(p.experience / 100n),
            games: [0,1,2].map(i => ({plays:Number(p.gamePlays[i]),victories:Number(p.gameVictories[i]),bestScore:Number(p.bestScores[i])}))};
        const honors = {week:p.honorWeek, longestStreak:p.longestStreak, titles:[0,1,2].map(i => ({champion:p.champion[i]!,podium:p.podium[i]!,top10:p.top10[i]!}))};
        return {tokenId, owner:getAddress(owner as Address), ownershipEpoch:String(epoch), seed, sequence:String(sequence), revealed, progress:growth, honors};
    }
    return {
        collection: config.collection,
        token,
        async inspect(tokenId): Promise<GuardianSnapshot> {
            const t = await token(tokenId); if (!t.revealed) throw new OutingError('guardian_unavailable');
            return {chainId:91342, collection:config.collection, tokenId, owner:t.owner, ownershipEpoch:t.ownershipEpoch,
                seed:t.seed, traitsHash:guardianTraitsHash(t.seed), ruleset:ARCADE_RULESET_VERSION};
        },
        async roster(owner): Promise<GuardianRoster> {
            const n = await block();
            const [owned, minted, pending, fee, signer] = await Promise.all([
                read('tokensOfOwner',[owner],n), read('mintedBy',[owner],n), read('pendingMint',[owner],n), read('mintFee',[],n), read('resultSigner',[],n),
            ]);
            const ids = owned as readonly bigint[];
            if (ids.length > 3 || getAddress(signer as Address) !== config.signer.address) throw new OutingError('guardian_unavailable');
            const guardians: GuardianToken[] = [];
            for (const id of ids) guardians.push(await token(String(id),n));
            return {enabled:true,chainId:91342,collection:config.collection,signer:config.signer.address,mintFee:String(fee),minted:Number(minted),
                pendingTokenId:BigInt(pending as bigint) === 0n ? null : String(pending),guardians};
        },
        async claimed(paymentTx) {return await read('claimedPayments',[paymentTx]) as boolean;},
    };
}

/** Receipt success alone is insufficient for an irrevocable signed growth claim. The caller checked the chain and read the safe head. */
export async function safeReceipt(client: GuardianClient, row: StoredResult, safe: bigint): Promise<ReceiptEvidence> {
    // A payment the node no longer has (dropped by an unsafe-head reorg, or a node that never indexed it) waits like an
    // unsafe one; anything else thrown here is the node failing, which closes the batch.
    const receipt = await client.getTransactionReceipt({hash:row.result.paymentTx})
        .catch((e: unknown) => {if (e instanceof TransactionReceiptNotFoundError) throw new OutingError('receipt_unconfirmed'); throw e;});
    if (receipt.status !== 'success' || reconcileSettlementReceipt({logs:receipt.logs, asset:MOCK_USDC.address,
        payer:row.payer,payTo:ARCADE_PAY_TO,amount:ARCADE_TICKET_AMOUNT}).length) throw new OutingError('receipt_unconfirmed');
    if (receipt.blockNumber > safe) throw new OutingError('receipt_unconfirmed');
    const canonical = await client.getBlock({blockNumber:receipt.blockNumber});
    if (!canonical.hash || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new OutingError('receipt_unconfirmed');
    return {blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash};
}
/**
 * Signs the current owner's oldest unclaimed results of one guardian and, when the sealed honor totals would raise the NFT's, one
 * honor: together at most one claim batch. Unsafe payments wait for a later batch. The honor is local SQL and is signed first; each
 * result row costs serialized RPC reads (paced on the public endpoint), so signing stops once `budgetMs` has passed with at least
 * one entry: the web proxy gives up after 20 s, and the rest simply follow in the next batch.
 */
export function createGuardianClaims(config: Config, ledger: GuardianLedger, reader: GuardianReader, honors: Pick<GuardianHonorBook, 'honor'>,
    client: GuardianClient = createPublicClient({chain:giwaSepolia,transport:throttledHttp(config.rpcUrl, {}, {timeout:15_000,retryCount:1})}), budgetMs = 10_000) {
    return async (owner: Address, tokenId: string): Promise<GuardianClaimBatch> => {
        const deadline = Date.now() + budgetMs, token = await reader.token(tokenId);
        if (token.owner.toLowerCase() !== owner.toLowerCase()) throw new OutingError('not_found');
        const signer = await client.readContract({address:config.collection,abi:guardianAbi,functionName:'resultSigner'});
        if (getAddress(signer as Address) !== config.signer.address) throw new OutingError('guardian_unavailable');
        if (await client.getChainId() !== 91342) throw new OutingError('receipt_unconfirmed');
        const safe = (await client.getBlock({blockTag:'safe'})).number;
        if (safe === null) throw new OutingError('receipt_unconfirmed');
        // The contract seals a week on block.timestamp, which trails this clock by the chain's lag; an honor signed in that gap
        // reverts the whole batch, results included. Signing from a clock held back by the margin never produces such an honor.
        const sealed = token.revealed ? honors.honor(tokenId, Date.now() - HONOR_CLOCK_MARGIN_MS) : null;
        let honor: GuardianClaimBatch['honor'] = null;
        if (sealed && honorAdvances(token.honors, sealed)) {
            // Sign the lane-wise maxima the contract will store, so the honor never shows a lane below the NFT's own.
            const json = guardianHonorJson(tokenId, {...sealed, longestStreak: Math.max(sealed.longestStreak, token.honors.longestStreak),
                titles: sealed.titles.map((game, g) => ({champion: Math.max(game.champion, token.honors.titles[g]!.champion),
                    podium: Math.max(game.podium, token.honors.titles[g]!.podium), top10: Math.max(game.top10, token.honors.titles[g]!.top10)}))});
            honor = {honor: json, signature: await config.signer.signTypedData({domain:guardianResultDomain(config.collection),types:GUARDIAN_HONOR_TYPES,primaryType:'Honor',message:guardianHonorFromJson(json)})};
        }
        const claims: GuardianClaimBatch['claims'] = [], cap = GUARDIAN_CLAIM_BATCH - (honor ? 1 : 0);
        for (const row of ledger.unclaimed(config.collection, tokenId)) {
            if (claims.length === cap || (claims.length || honor) && Date.now() >= deadline) break;
            if (await reader.claimed(row.result.paymentTx)) {ledger.markClaimed(row.result.resultId); continue;}
            // Recheck canonical provenance even when a previous signature exists.
            let evidence: ReceiptEvidence;
            try {evidence = await safeReceipt(client,row,safe);} catch (e) {if (e instanceof OutingError && e.code === 'receipt_unconfirmed') continue; throw e;}
            const signature = await config.signer.signTypedData({domain:guardianResultDomain(config.collection),types:GUARDIAN_RESULT_TYPES,primaryType:'Result',message:guardianResultFromJson(row.result)});
            ledger.attest(row.result.resultId,evidence,config.signer.address,signature);
            claims.push({result:row.result,signature});
        }
        return {collection:config.collection,signer:config.signer.address,claims,honor};
    };
}
