import {describe, expect, test} from "bun:test";
import {ZODIACS, ROLL_FIELDS, projectGuardian, guardianCode, guardianMetadata, rollGuardian, validGuardian, type RollLock} from "./guardian";
import {newCompanion, newArcadeState, addCharacter, updateCharacter, admitPracticeRun, parseArcadeState} from "./state";
import {serializeArcadeState} from "./state-store";
import {HATS, OUTFITS, SHOES, WARDROBE_PRESETS, wardrobeAsset, validWardrobe} from "./wardrobe";
import {guardianLayers} from "./guardian-layers";
import {existsSync} from "node:fs";
import {admitActivity} from "./activity";

const member = () => ({...newCompanion("maru", {name: "마루", color: "red", temperament: "calm"}), best: 700, agent: {mode: "llm" as const, rounds: 3, goal: "save" as const}});
const seed = "0123456789abcdef";

describe("Mapae guardian customization", () => {
    test("a public seed reproduces traits, covers all twelve guardians, and leaves identity and authority alone", () => {
        expect(rollGuardian(member(), seed)).toEqual(rollGuardian(member(), seed));
        const kinds = new Set<string>();
        const backdropCharms = new Set<string>();
        for (let i = 0; i < 512; i++) {
            const rolled = rollGuardian(member(), i.toString(16).padStart(16, "0"));
            expect(validGuardian(rolled.appearance)).toBe(true); kinds.add(rolled.appearance!.zodiac);
            backdropCharms.add(`${rolled.appearance!.backdrop}:${rolled.appearance!.charm}`);
            expect(rolled).toMatchObject({id: "maru", name: "마루", best: 700, agent: {mode: "llm", rounds: 3}});
        }
        expect([...kinds].sort()).toEqual([...ZODIACS].sort());
        expect(backdropCharms.size).toBe(16);
        expect(() => rollGuardian(member(), "0xprivate-key")).toThrow();
    });
    test("locks keep all chosen fields across rolls without mutating the original", () => {
        const original = rollGuardian(member(), seed);
        const locks = new Set<RollLock>(ROLL_FIELDS);
        const next = rollGuardian(original, "ffffffffffffffff", locks);
        expect(next.appearance).toEqual({...original.appearance!, seed: "ffffffffffffffff"});
        expect(next.color).toBe(original.color); expect(next.temperament).toBe(original.temperament); expect(next.agent).toEqual(original.agent);
        expect(original.appearance?.seed).toBe(seed);
        expect(guardianCode(next.appearance!, next.color)).toBe(guardianCode(original.appearance!, original.color));
    });
    test("appearance persists per character and practice/paid receipts keep the original look after edits", () => {
        const original = rollGuardian(member(), seed);
        const state = addCharacter(newArcadeState(), original);
        const practice = admitPracticeRun(state, "practice", 1); if (!practice.ok) throw new Error(practice.reason);
        const paid = admitActivity(practice.demo, {id: "paid", characterId: "maru", game: "race", mode: "rules", source: "mapae-giwa", ticketId: "0x" + "ab".repeat(32), model: null, reason: "test", giwa: {balanceAfter: "1", allowanceAfter: "1.00"}}, 2);
        if (!paid.ok) throw new Error(paid.reason);
        const edited = updateCharacter(paid.demo, "maru", {appearance: {...original.appearance!, zodiac: "pig", wardrobe: {hat: "satgat", outfit: "hemp", shoes: "namaksin"}}});
        const restored = parseArcadeState(serializeArcadeState(edited));
        expect(restored).toEqual(edited); expect(restored.characters[0]?.appearance?.zodiac).toBe("pig");
        expect(restored.runs[0]?.appearance).toEqual(original.appearance); expect(restored.activities[0]?.appearance).toEqual(original.appearance);
    });
    test("invalid asset paths, seeds and versions cannot enter stored appearance", () => {
        const good = rollGuardian(member(), seed); const state = addCharacter(newArcadeState(), good);
        for (const patch of [{zodiac: "../../private"}, {charm: "https://example.com/track"}, {backdrop: "unknown"}, {version: 2}, {seed: "bad"}, {wardrobe: null}, {wardrobe: {hat: "../../private", outfit: "hemp", shoes: "jipsin"}}, {wardrobe: {hat: "gat", outfit: "wrong", shoes: "jipsin"}}, {wardrobe: {hat: "gat", outfit: "hemp", shoes: "wrong"}}]) {
            const appearance = {...good.appearance!, ...patch};
            expect(validGuardian(appearance)).toBe(false);
            expect(parseArcadeState(JSON.stringify({...state, characters: [{...good, appearance}]}))).toEqual(newArcadeState());
        }
    });
    test("metadata and storage project only public traits, never injected keys or payment fields", () => {
        const good = rollGuardian(member(), seed);
        const tainted = {...good, privateKey: "secret-wallet", permissionContext: "secret-grant", appearance: {...good.appearance!, privateKey: "secret-art", wardrobe: {...good.appearance!.wardrobe!, permissionContext: "secret-clothes"}}};
        const metadata = guardianMetadata(tainted);
        expect(metadata.attributes).toHaveLength(9); expect(metadata.properties.status).toBe("local-character");
        expect(metadata.image).toBe("mapae-guardian-maru.png");
        expect(JSON.stringify(metadata)).not.toContain("secret-");
        expect(serializeArcadeState(addCharacter(newArcadeState(), tainted))).not.toContain("secret-");
        expect(metadata).not.toHaveProperty("tokenId"); expect(metadata).not.toHaveProperty("address");
    });
    test("matched outfits use the ten themes; mixed rolls reach every clothing part while preserving the chosen name", () => {
        const hats = new Set<string>(), outfits = new Set<string>(), shoes = new Set<string>(), matches = new Set<string>();
        for (let i = 0; i < 512; i++) {
            const nextSeed = i.toString(16).padStart(16, "0");
            const matched = rollGuardian(member(), nextSeed).appearance!.wardrobe!;
            expect(WARDROBE_PRESETS.some(p => JSON.stringify(p.clothes) === JSON.stringify(matched))).toBe(true);
            matches.add(JSON.stringify(matched));
            const mixed = rollGuardian(member(), nextSeed, new Set(), "mix");
            expect(mixed.name).toBe("마루"); expect(mixed.id).toBe("maru");
            hats.add(mixed.appearance!.wardrobe!.hat); outfits.add(mixed.appearance!.wardrobe!.outfit); shoes.add(mixed.appearance!.wardrobe!.shoes);
        }
        expect(matches.size).toBe(10);
        expect([...hats].sort()).toEqual([...HATS].sort()); expect([...outfits].sort()).toEqual([...OUTFITS].sort()); expect([...shoes].sort()).toEqual([...SHOES].sort());
        const original = rollGuardian(member(), seed);
        const changed = rollGuardian(original, "ffffffffffffffff", new Set(["hat", "shoes"]), "mix");
        expect(changed.appearance!.wardrobe!.hat).toBe(original.appearance!.wardrobe!.hat);
        expect(changed.appearance!.wardrobe!.shoes).toBe(original.appearance!.wardrobe!.shoes);
    });
    test("all composable assets exist and every combination has bounded layers and a unique look code", () => {
        const files = [...ZODIACS.map(x => wardrobeAsset("head", x)), ...HATS.filter(x => x !== "none").map(x => wardrobeAsset("hat", x)), ...OUTFITS.map(x => wardrobeAsset("outfit", x)), ...SHOES.map(x => wardrobeAsset("shoes", x))];
        expect(files).toHaveLength(33);
        for (const file of files) expect(existsSync(new URL(`../../public${file}`, import.meta.url))).toBe(true);
        const g = rollGuardian(member(), seed).appearance!; const codes = new Set<string>();
        for (const zodiac of ZODIACS) for (const hat of HATS) for (const outfit of OUTFITS) for (const shoes of SHOES) {
            const look = {...g, zodiac, wardrobe: {hat, outfit, shoes}};
            codes.add(guardianCode(look, "red"));
            const layers = guardianLayers(look);
            expect(layers.every(layer => layer.x >= 0 && layer.y >= 0 && layer.x + layer.width <= 400 && layer.y + layer.height <= 400)).toBe(true);
            expect(layers.every(layer => !layer.clip || (layer.clip.x >= layer.x && layer.clip.y >= layer.y && layer.clip.width > 0 && layer.clip.height > 0 && layer.clip.x + layer.clip.width <= layer.x + layer.width + .001 && layer.clip.y + layer.clip.height <= layer.y + layer.height + .001))).toBe(true);
        }
        expect(codes.size).toBe(12 * 9 * 8 * 5);
        const dragon = guardianLayers({...g, zodiac: "dragon", wardrobe: {hat: "satgat", outfit: "scholar", shoes: "taesahye"}});
        const head = dragon.findIndex(layer => layer.src === wardrobeAsset("head", "dragon"));
        const straps = dragon.findIndex(layer => layer.src === wardrobeAsset("hat", "satgat"));
        const brim = dragon.findLastIndex(layer => layer.src === wardrobeAsset("hat", "satgat"));
        expect(straps).toBeLessThan(head); expect(brim).toBeGreaterThan(head);
        const front = dragon[brim]!;
        expect(front.clip!.y + front.clip!.height).toBeLessThan(120);
        const original = {...g, wardrobe: undefined};
        expect(validGuardian(original)).toBe(true); expect(projectGuardian(original)).not.toHaveProperty("wardrobe");
        expect(validWardrobe([])).toBe(false);
    });
    test("appearance is opt-in for existing records; no character is created by reading or rolling a draft", () => {
        const original = member(); const state = addCharacter(newArcadeState(), original);
        expect(parseArcadeState(serializeArcadeState(state))).toEqual(state);
        expect(original.appearance).toBeUndefined(); expect(() => guardianMetadata(original)).toThrow();
        const draft = rollGuardian({...original, name: ""}, seed);
        expect(addCharacter(newArcadeState(), draft)).toEqual(newArcadeState());
    });
});
