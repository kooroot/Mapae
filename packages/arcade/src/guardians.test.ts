import {describe, expect, test} from "bun:test";
import {encodeAbiParameters, keccak256, pad, toHex} from "viem";
import {GUARDIAN_APTITUDES, guardianResultFromJson, guardianTokenId, guardianTraits, guardianTraitsHash, validGuardianAptitudes} from "./guardians";

describe("immutable guardian birth mapping", () => {
    test("all trait domains vary independently while aptitude budget stays balanced", () => {
        const combinations = new Set<string>();
        const temperaments = new Set<string>();
        for (let i = 0; i < 512; i++) {
            const seed = pad(toHex(i), {size: 32}), traits = guardianTraits(seed);
            expect(guardianTraits(seed)).toEqual(traits);
            expect(guardianTraitsHash(seed)).toBe(keccak256(encodeAbiParameters([{type: "bytes32"}], [seed])));
            expect(validGuardianAptitudes(traits.aptitudes)).toBe(true);
            expect(Object.values(traits.aptitudes).reduce((a, b) => a + b, 0)).toBe(15);
            combinations.add(JSON.stringify(traits.aptitudes)); temperaments.add(traits.temperament);
        }
        expect(combinations.size).toBe(GUARDIAN_APTITUDES.length);
        expect(temperaments.size).toBe(3);
    });
    test("refuses malformed seeds and user-assigned unfair aptitude totals", () => {
        expect(() => guardianTraits("0x01")).toThrow();
        expect(() => guardianTraitsHash("0x01")).toThrow();
        for (const bad of [null, [], {stamp: 5, race: 5, shop: 5}, {stamp: 4, race: 5, shop: 6, extra: 1}, {stamp: 4, race: 6, shop: 6}]) expect(validGuardianAptitudes(bad)).toBe(false);
    });
    test("token IDs never pass through floating-point or accept ambiguous encodings", () => {
        for (const value of ["1", "9007199254740993", ((1n << 256n) - 1n).toString()]) expect(guardianTokenId(value)).toBe(true);
        for (const value of [0, 1, "0", "01", "1e3", "-1", (1n << 256n).toString()]) expect(guardianTokenId(value)).toBe(false);
        const base = {resultId: pad("0x01"), actor: `0x${"11".repeat(20)}`, paymentTx: pad("0x02"), traitsHash: pad("0x03"), inputsHash: pad("0x04"), ruleset: 3, seed: 0, game: 0, score: 100, victory: true} as const;
        expect(guardianResultFromJson({...base, tokenId: "9007199254740993", ownershipEpoch: "1"}).tokenId).toBe(9007199254740993n);
        expect(() => guardianResultFromJson({...base, tokenId: "1", ownershipEpoch: (1n << 64n).toString()})).toThrow();
    });
});
