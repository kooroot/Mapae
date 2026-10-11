import type {Address, Hex} from 'viem';
import type {GuardianSnapshot, GuardianResult} from '@mapae/arcade/guardians';
import type {OutingResult} from '@mapae/arcade/outings';

export type {GuardianSnapshot};
export type Progress = {plays: number; victories: number; experience: number; level: number; games: {plays: number; victories: number; bestScore: number}[]};
export const emptyProgress = (): Progress => ({plays: 0, victories: 0, experience: 0, level: 1, games: Array.from({length: 3}, () => ({plays: 0, victories: 0, bestScore: 0}))});
export type GuardianToken = {
    tokenId: string; owner: Address; ownershipEpoch: string; revealed: boolean;
    seed: Hex; sequence: string; progress: Progress;
};
export type GuardianRoster = {
    enabled: boolean; chainId: 91342; collection: Address | null; signer: Address | null;
    mintFee: string | null; minted: number; pendingTokenId: string | null; guardians: GuardianToken[];
};
export type ResultJson = Omit<GuardianResult, 'tokenId' | 'ownershipEpoch'> & {tokenId: string; ownershipEpoch: string};
export type VerifiedResult = Omit<OutingResult,'transaction'> & {
    transaction: Hex | null;
    tokenId: string; actor: Address | null; ownershipEpoch: string; ruleset: number;
    score: number; victory: boolean; claimed: boolean;
};
export type GuardianDetail = {guardian: GuardianToken; earned: Progress; results: VerifiedResult[]; nextCursor: string | null};
export type GuardianClaim = {collection: Address; signer: Address; result: ResultJson; signature: Hex | null; claimed: boolean};
/** Signed, still-unclaimed results of one guardian, oldest first: exactly the arguments of one claimResults transaction. */
export type GuardianClaimBatch = {collection: Address; signer: Address; claims: {result: ResultJson; signature: Hex}[]};
export interface GuardianReader {
    readonly collection: Address;
    inspect(tokenId: string): Promise<GuardianSnapshot>;
    roster(owner: Address): Promise<GuardianRoster>;
    token(tokenId: string): Promise<GuardianToken>;
    /** Whether the result's payment already grew a guardian on-chain (each paymentTx grows at most one result). */
    claimed(paymentTx: Hex): Promise<boolean>;
}
export type ReceiptEvidence = {blockNumber: string; blockHash: Hex};
