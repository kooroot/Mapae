import {encodePacked, isHash, keccak256, type Address, type Hex} from "viem";

export const GUARDIAN_CHAIN_ID = 91342;
export const GUARDIAN_TRAITS_VERSION = 1;
export const GUARDIAN_CAPACITY = 3;
export const GUARDIAN_ENTROPY = "0x0708325268dF9F66270F1401206434524814508b" as const;
export const GUARDIAN_PROVIDER = "0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344" as const;
export const GUARDIAN_ZODIACS = ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"] as const;
export const GUARDIAN_HATS = ["none", "topknot", "gat", "satgat", "samo", "ikseongwan", "jeonrip", "paeraengi", "headwrap"] as const;
export const GUARDIAN_OUTFITS = ["gonryongpo", "minister", "official", "military", "scholar", "artisan", "hemp", "performer"] as const;
export const GUARDIAN_SHOES = ["jipsin", "namaksin", "taesahye", "heukhwa", "beoseon"] as const;
export const GUARDIAN_BACKDROPS = ["dawn", "moon", "jade", "ember"] as const;
export const GUARDIAN_CHARMS = ["mapae", "scroll", "pouch", "none"] as const;
export const GUARDIAN_COLORS = ["red", "jade", "ink"] as const;
export const GUARDIAN_TEMPERAMENTS = ["curious", "bold", "calm"] as const;
export const GUARDIAN_APTITUDES = [[4, 5, 6], [4, 6, 5], [5, 4, 6], [5, 6, 4], [6, 4, 5], [6, 5, 4]] as const;
export type GuardianAptitudes = {stamp: number; race: number; shop: number};

/** Birth-word decoder shared with GuardianTraits.sol. No clocks, wallet keys or rerolls. */
export function guardianTraits(seed: Hex) {
    if (!isHash(seed)) throw new Error("Invalid guardian birth seed");
    const pick = <T,>(index: number, values: readonly T[]): T => values[Number(BigInt(keccak256(encodePacked(["bytes32", "uint8"], [seed, index]))) % BigInt(values.length))]!;
    const [stamp, race, shop] = pick(8, GUARDIAN_APTITUDES);
    return {
        version: GUARDIAN_TRAITS_VERSION, seed,
        zodiac: pick(0, GUARDIAN_ZODIACS), hat: pick(1, GUARDIAN_HATS), outfit: pick(2, GUARDIAN_OUTFITS), shoes: pick(3, GUARDIAN_SHOES),
        backdrop: pick(4, GUARDIAN_BACKDROPS), charm: pick(5, GUARDIAN_CHARMS), color: pick(6, GUARDIAN_COLORS),
        temperament: pick(7, GUARDIAN_TEMPERAMENTS), aptitudes: {stamp, race, shop} as GuardianAptitudes,
    };
}
export type GuardianTraits = ReturnType<typeof guardianTraits>;
export type GuardianSnapshot = {
    chainId: 91342; collection: Address; tokenId: string; owner: Address; ownershipEpoch: string;
    seed: Hex; traitsHash: Hex; ruleset: number;
};
export function guardianTraitsHash(seed: Hex): Hex {
    if (!isHash(seed)) throw new Error("Invalid guardian birth seed");
    // abi.encode(bytes32) is exactly its 32 bytes.
    return keccak256(seed);
}
export function validGuardianAptitudes(value: unknown): value is GuardianAptitudes {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 3 && GUARDIAN_APTITUDES.some(([stamp, race, shop]) => v.stamp === stamp && v.race === race && v.shop === shop);
}
export function guardianTokenId(value: unknown): value is string {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) return false;
    return BigInt(value) < 1n << 256n;
}
export const GUARDIAN_RESULT_TYPES = {Result: [
    {name: "resultId", type: "bytes32"}, {name: "tokenId", type: "uint256"}, {name: "actor", type: "address"},
    {name: "ownershipEpoch", type: "uint64"}, {name: "paymentTx", type: "bytes32"}, {name: "traitsHash", type: "bytes32"},
    {name: "inputsHash", type: "bytes32"}, {name: "ruleset", type: "uint32"}, {name: "seed", type: "uint32"},
    {name: "game", type: "uint8"}, {name: "score", type: "uint32"}, {name: "victory", type: "bool"},
]} as const;
export type GuardianResult = {
    resultId: Hex; tokenId: bigint; actor: Address; ownershipEpoch: bigint; paymentTx: Hex;
    traitsHash: Hex; inputsHash: Hex; ruleset: number; seed: number; game: number; score: number; victory: boolean;
};
export type GuardianResultJson = Omit<GuardianResult, "tokenId" | "ownershipEpoch"> & {tokenId: string; ownershipEpoch: string};
export const guardianResultDomain = (collection: Address) => ({name: "Mapae Guardians", version: "1", chainId: GUARDIAN_CHAIN_ID, verifyingContract: collection}) as const;
export function guardianResultFromJson(value: GuardianResultJson): GuardianResult {
    if (!guardianTokenId(value.tokenId) || !guardianTokenId(value.ownershipEpoch) || BigInt(value.ownershipEpoch) >= 1n << 64n) throw new Error("Invalid guardian result identity");
    return {...value, tokenId: BigInt(value.tokenId), ownershipEpoch: BigInt(value.ownershipEpoch)};
}
