import {encodePacked,keccak256,isHash,parseAbi,type Hex} from 'viem';
export const entropyRecoveryAbi=parseAbi([
    'function getRequestV2(address provider,uint64 sequenceNumber) view returns ((address provider,uint64 sequenceNumber,uint32 numHashes,bytes32 commitment,uint64 blockNumber,address requester,bool useBlockhash,uint8 callbackStatus,uint16 gasLimit10k))',
    'function revealWithCallback(address provider,uint64 sequenceNumber,bytes32 userContribution,bytes32 providerRevelation)',
]);
/** Verify the provider proof against this exact onchain request before asking for a recovery transaction. */
export function verifyRevelation(userContribution:Hex,providerRevelation:unknown,numHashes:number,commitment:Hex):Hex {
    if(typeof providerRevelation!=='string'||!isHash(providerRevelation)||!isHash(userContribution)||!Number.isInteger(numHashes)||numHashes<1||numHashes>1000)throw Error('recovery_proof');
    let candidate:Hex=providerRevelation;
    for(let i=0;i<numHashes;i++)candidate=keccak256(candidate);
    const actual=keccak256(encodePacked(['bytes32','bytes32'],[keccak256(userContribution),candidate]));
    if(actual.toLowerCase()!==commitment.toLowerCase())throw Error('recovery_proof');
    return providerRevelation;
}
