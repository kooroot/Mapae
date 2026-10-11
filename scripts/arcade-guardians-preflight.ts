/** Public read-only release evidence. This tool never loads a wallet or sends a transaction. */
import {createPublicClient, getAddress, http, isAddress, parseAbi, type Address} from 'viem';
import {giwaSepolia} from '../packages/shared/src/index';
import {GUARDIAN_CHAIN_ID, GUARDIAN_ENTROPY, GUARDIAN_PROVIDER, guardianTokenId, guardianTraits} from '../packages/arcade/src/guardians';
import {guardianAbi} from '../packages/arcade/src/guardian-abi';

// ERC-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const entropyAbi = parseAbi([
    'function getDefaultProvider() view returns (address)',
    'function getFeeV2(address,uint32) view returns (uint128)',
    'function getProviderInfoV2(address) view returns ((uint128 feeInWei,uint128 accruedFeesInWei,bytes32 originalCommitment,uint64 originalCommitmentSequenceNumber,bytes commitmentMetadata,bytes uri,uint64 endSequenceNumber,uint64 sequenceNumber,bytes32 currentCommitment,uint64 currentCommitmentSequenceNumber,address feeManager,uint32 maxNumHashes,uint32 defaultGasLimit))',
]);

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('bun --no-env-file scripts/arcade-guardians-preflight.ts [--collection 0x…] [--token 1]');
        return;
    }
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        if (!['--collection', '--token'].includes(args[i]!) || !args[i + 1] || options.has(args[i]!)) throw Error('invalid_arguments');
        options.set(args[i]!, args[i + 1]!);
    }
    const collection = options.get('--collection'), token = options.get('--token');
    if (collection && !isAddress(collection)) throw Error('invalid_collection');
    if (token && (!collection || !guardianTokenId(token) || BigInt(token) > 10000n)) throw Error('invalid_token');
    const client = createPublicClient({chain: giwaSepolia, transport: http(undefined, {timeout: 15000, retryCount: 1})});
    const [chainId, block, safe, code] = await Promise.all([client.getChainId(), client.getBlock(), client.getBlock({blockTag: 'safe'}), client.getCode({address: GUARDIAN_ENTROPY})]);
    if (chainId !== GUARDIAN_CHAIN_ID || !code || code === '0x' || block.number === null || safe.number === null) throw Error('chain_unavailable');
    if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 180) throw Error('stale_chain_head');
    const [provider, fee, info] = await Promise.all([
        client.readContract({address: GUARDIAN_ENTROPY, abi: entropyAbi, functionName: 'getDefaultProvider', blockNumber: block.number}),
        client.readContract({address: GUARDIAN_ENTROPY, abi: entropyAbi, functionName: 'getFeeV2', args: [GUARDIAN_PROVIDER, 500000], blockNumber: block.number}),
        client.readContract({address: GUARDIAN_ENTROPY, abi: entropyAbi, functionName: 'getProviderInfoV2', args: [GUARDIAN_PROVIDER], blockNumber: block.number}),
    ]);
    if (provider.toLowerCase() !== GUARDIAN_PROVIDER.toLowerCase() || info.originalCommitment === `0x${'0'.repeat(64)}` || info.sequenceNumber >= info.endSequenceNumber || info.defaultGasLimit < 500000 || fee <= 0n) throw Error('provider_unavailable');
    const response = await fetch('https://fortuna-staging.dourolabs.app/ready', {signal: AbortSignal.timeout(15000)});
    if (!response.ok || (await response.text()).trim() !== 'OK') throw Error('provider_not_ready');
    let deployed: Record<string, unknown> | null = null;
    if (collection) {
        const address = collection as Address;
        if (!await client.getCode({address})) throw Error('collection_missing');
        // The collection is a UUPS proxy: its implementation slot must point at deployed code.
        const slot = await client.getStorageAt({address, slot: IMPLEMENTATION_SLOT, blockNumber: block.number});
        const implementation = slot && BigInt(slot) !== 0n ? getAddress(`0x${slot.slice(-40)}`) : null;
        if (!implementation || !await client.getCode({address: implementation, blockNumber: block.number})) throw Error('collection_not_a_proxy');
        const read = {address, abi: guardianAbi, blockNumber: block.number} as const;
        const [entropy, selectedProvider, signer, admin, mintPaused, supply, imageBase] = await Promise.all([
            client.readContract({...read, functionName: 'entropy'}), client.readContract({...read, functionName: 'entropyProvider'}),
            client.readContract({...read, functionName: 'resultSigner'}), client.readContract({...read, functionName: 'owner'}),
            client.readContract({...read, functionName: 'mintPaused'}), client.readContract({...read, functionName: 'totalSupply'}),
            client.readContract({...read, functionName: 'imageBaseURI'}),
        ]);
        if (entropy.toLowerCase() !== GUARDIAN_ENTROPY.toLowerCase() || selectedProvider.toLowerCase() !== GUARDIAN_PROVIDER.toLowerCase() || signer.toLowerCase() === admin.toLowerCase()) throw Error('collection_configuration_mismatch');
        deployed = {address, implementation, signer, admin, mintPaused, supply, imageBase, token: null};
        if (token) {
            // Safe-head state is evidence of a persisted reveal, not merely latest mempool/UI state.
            const [seed, sequence, revealed] = await client.readContract({...read, blockNumber: safe.number, functionName: 'birth', args: [BigInt(token)]});
            deployed.token = {tokenId: token, sequence, revealed, seed: revealed ? seed : null, traits: revealed ? guardianTraits(seed) : null, readAtSafeBlock: safe.number};
            if (!revealed) throw Error('canary_not_revealed_at_safe_head');
        }
    }
    console.log(JSON.stringify({observedAt: new Date().toISOString(), mode: 'read-only; no transactions sent', chainId, head: block.number,
        headHash: block.hash, safeHead: safe.number, entropy: GUARDIAN_ENTROPY, provider, feeWei: fee, nextProviderSequence: info.sequenceNumber,
        providerReady: true, collection: deployed, limitation: token ? 'Verify the original mint and reveal receipts separately; this checks current safe state.' : 'Provider readiness is not proof of a successful callback. A real request/reveal canary is still required.'}, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    console.log('PREFLIGHT_READ_ONLY_OK');
}

if (import.meta.main) {
    try {await main();} catch (error) {
        // Never print library RPC exceptions, which may contain transport credentials.
        const known = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'rpc_or_provider_check_failed';
        console.error(`Guardian preflight failed: ${known}`); process.exitCode = 1;
    }
}
