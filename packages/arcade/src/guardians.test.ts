import {describe, expect, test} from "bun:test";
import {encodeAbiParameters, hashTypedData, keccak256, pad, toHex} from "viem";
import {
    emptyHonors, GUARDIAN_APTITUDES, GUARDIAN_GIVEN_NAMES, GUARDIAN_HONOR_TYPES, GUARDIAN_MAX_SUPPLY, GUARDIAN_NAME_MODIFIERS, guardianHonorFromJson, guardianHonorJson,
    guardianHonorsOf, guardianName, guardianResultDomain, guardianResultFromJson, guardianTokenId, guardianTraits, guardianTraitsHash, honorAdvances, packGuardianTitles,
    unpackGuardianTitles, validGuardianAptitudes, validGuardianHonors, type GuardianHonors,
} from "./guardians";
import {STREAK_MILESTONES} from "./ranking";

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

describe("guardian display names", () => {
    test("both locales carry 100 distinct, index-aligned modifiers and given names", () => {
        for (const list of [GUARDIAN_NAME_MODIFIERS, GUARDIAN_GIVEN_NAMES]) for (const locale of ["ko", "en"] as const) {
            expect(list[locale]).toHaveLength(100);
            expect(new Set(list[locale]).size).toBe(100);
        }
        for (const given of GUARDIAN_GIVEN_NAMES.en) expect(given).toMatch(/^[A-Z][a-z]+$/);
        for (const modifier of GUARDIAN_NAME_MODIFIERS.en) expect(modifier).toMatch(/^[A-Z][a-z]*(-[A-Za-z][a-z]*)*$/);
    });
    test("every token ID 1..10000 gets its own name in both locales", () => {
        for (const locale of ["ko", "en"] as const) {
            const names = new Set<string>();
            for (let id = 1; id <= GUARDIAN_MAX_SUPPLY; id++) names.add(guardianName(id, locale));
            expect(names.size).toBe(GUARDIAN_MAX_SUPPLY);
        }
    });
    test("names are stable across input encodings", () => {
        expect(guardianName(1, "ko")).toBe("졸린 돌쇠");
        expect(guardianName("1", "en")).toBe("Sleepy Dolsoe");
        expect(guardianName(2n, "ko")).toBe("낮잠 자는 겨울이");
        expect(guardianName("2", "en")).toBe("Napping Gyeouri");
        expect(guardianName(10_000, "en")).toBe("Bundle-Carrying Childeugi");
    });
    test("refuses IDs outside the minted range or not plain integers", () => {
        for (const bad of [0, 10_001, -1, 1.5, Number.NaN, "abc", "0", "01", "1.0", "10001", 0n, 10_001n]) expect(() => guardianName(bad, "ko")).toThrow();
    });
});

describe("guardian honors", () => {
    // Lanes [1,0,2,0,3,0,4,0,5]: stamp {1,0,2}, race {0,3,0}, shop {4,0,5}.
    const honors: GuardianHonors = {week: 2961, longestStreak: 7, titles: [{champion: 1, podium: 0, top10: 2}, {champion: 0, podium: 3, top10: 0}, {champion: 4, podium: 0, top10: 5}]};
    test("the typed-data digest matches MapaeGuardians.honorDigest (test_fixedTypeScriptHonorVector)", () => {
        const honor = guardianHonorFromJson(guardianHonorJson("1", honors));
        expect(honor).toEqual({tokenId: 1n, week: 2961, longestStreak: 7, titles: 0x500000004000000030000000200000001n});
        expect(hashTypedData({domain: guardianResultDomain("0x1111111111111111111111111111111111111111"), types: GUARDIAN_HONOR_TYPES, primaryType: "Honor", message: honor}))
            .toBe("0x001abf80aceaef48a8dde8319e0edab78ddb0a02f99e6dd7b3933d374e6d568c");
        expect(guardianHonorsOf(honor)).toEqual(honors);
    });
    test("titles pack into nine 16-bit lanes, game * 3 + tier, and refuse anything wider", () => {
        expect(packGuardianTitles(emptyHonors().titles)).toBe(0n);
        expect(packGuardianTitles([{champion: 0, podium: 0, top10: 0}, {champion: 0, podium: 0, top10: 0}, {champion: 0, podium: 0, top10: 0xffff}])).toBe(0xffffn << 128n);
        expect(unpackGuardianTitles(0xffffn << 128n)[2]).toEqual({champion: 0, podium: 0, top10: 0xffff});
        for (const bad of [[], honors.titles.slice(0, 2), [{...honors.titles[0]!, champion: 0x10000}, honors.titles[1]!, honors.titles[2]!], [{...honors.titles[0]!, podium: -1}, honors.titles[1]!, honors.titles[2]!]])
            expect(() => packGuardianTitles(bad)).toThrow();
        expect(() => unpackGuardianTitles(1n << 144n)).toThrow();
        for (const bad of [{week: 0}, {week: 65536}, {longestStreak: 65536}, {titles: (1n << 144n).toString()}, {titles: "01"}, {titles: "-1"}, {tokenId: "0"}])
            expect(() => guardianHonorFromJson({...guardianHonorJson("1", honors), ...bad})).toThrow();
        expect(validGuardianHonors(honors)).toBe(true);
        for (const bad of [null, {...honors, week: -1}, {...honors, titles: honors.titles.slice(1)}, {...honors, titles: [{champion: 1.5, podium: 0, top10: 0}, honors.titles[1], honors.titles[2]]}])
            expect(validGuardianHonors(bad)).toBe(false);
    });
    test("an honor advances only with a newer week that raises a lane", () => {
        expect(honorAdvances(emptyHonors(), honors)).toBe(true);
        expect(honorAdvances(honors, {...honors, week: 2962})).toBe(false);
        expect(honorAdvances(honors, {...honors, week: 2962, longestStreak: 8})).toBe(true);
        expect(honorAdvances(honors, {...honors, longestStreak: 8})).toBe(false);
        expect(honorAdvances(honors, {...honors, week: 2962, titles: [honors.titles[0]!, honors.titles[1]!, {...honors.titles[2]!, podium: 1}]})).toBe(true);
    });
    test("GuardianMetadata's milestones are STREAK_MILESTONES", () => {
        expect([...STREAK_MILESTONES]).toEqual([3, 7, 14, 30, 100]);
    });
});
