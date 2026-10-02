import {PROFILE_GENERATION, serverRestored} from "./model";
import {describe, expect, test} from "bun:test";
import {addCharacter, admitPracticeRun, finishPracticeRun, newArcadeState, newCompanion, updateCharacter} from "../state";
import {emptyProfile, importDeviceProfile, mergeProfiles, parseProfile, profileState, projectProfile} from "./model";
const state = () => addCharacter(newArcadeState(), newCompanion("horse", {name: "마루", color: "red", temperament: "curious"}));
describe("cross-device profile reconciliation", () => {
    test("imports device-only records once without creating default characters", () => {
        expect(importDeviceProfile(emptyProfile(), emptyProfile())).toEqual(emptyProfile());
        const mobile = projectProfile(state());
        expect(importDeviceProfile(mobile, emptyProfile())).toEqual(mobile);
        expect(importDeviceProfile(mobile, mobile)).toEqual(mobile);
    });
    test("disjoint character edits and creations survive concurrent saves", () => {
        const base = state(), a = updateCharacter(base, "horse", {name: "구름"});
        const b = addCharacter(updateCharacter(base, "horse", {color: "jade"}), newCompanion("tiger", {name: "호야", color: "ink", temperament: "bold"}));
        const merged = mergeProfiles(projectProfile(base), projectProfile(a), projectProfile(b));
        expect(merged.characters).toHaveLength(2); expect(merged.characters[0]).toMatchObject({name: "구름", color: "jade"});
    });
    test("the same edited field conflicts instead of silently overwriting", () => {
        const base = state();
        expect(() => mergeProfiles(projectProfile(base), projectProfile(updateCharacter(base, "horse", {name: "구름"})), projectProfile(updateCharacter(base, "horse", {name: "두리"})))).toThrow("concurrent_edit");
    });
    test("import preserves server customization and higher scores", () => {
        const old = state(); old.characters[0]!.best = 500;
        const server = updateCharacter(state(), "horse", {name: "서버친구"}); server.characters[0]!.bests.race = 200;
        expect(importDeviceProfile(projectProfile(old), projectProfile(server)).characters[0]).toMatchObject({name: "서버친구", best: 500, bests: {race: 200}});
    });
    test("completed history cannot regress when a stale device returns", () => {
        const first = admitPracticeRun(state(), "run", 123); if (!first.ok) throw new Error("fixture");
        const done = finishPracticeRun(first.demo, "run", {score: 300, bestCombo: 4, hits: 9, mistakes: 0, missed: 0});
        const merged = mergeProfiles(projectProfile(first.demo), projectProfile(first.demo), projectProfile(done));
        expect(merged.runs[0]?.status).toBe("complete"); expect(merged.characters[0]?.best).toBe(300);
    });
    test("server profiles exclude device preferences and credential extensions", () => {
        const source = {...state(), sound: true, reducedMotion: true, privateKey: "secret"}, p = projectProfile(source);
        expect(p).not.toHaveProperty("sound"); expect(p).not.toHaveProperty("privateKey");
        expect(profileState(p, source).sound).toBe(true); expect(parseProfile({...p, privateKey: "secret"})).toEqual(p);
    });
    test("duplicate identifiers, invalid records and character overflow are refused", () => {
        const p = projectProfile(state());
        expect(parseProfile({...p, characters: [...p.characters, ...p.characters]})).toBeNull();
        expect(parseProfile({...p, activities: [{}]})).toBeNull();
        const remote = {...p, characters: Array.from({length: 12}, (_, i) => ({...p.characters[0]!, id: `friend-${i}`}))};
        expect(() => importDeviceProfile(p, remote)).toThrow("character_limit");
    });
});

test("restoration is detected even when the restored revision catches up", () => {
    const base = {revision: 7, generation: PROFILE_GENERATION};
    expect(serverRestored(base, {revision: 6, generation: PROFILE_GENERATION})).toBe(true);
    expect(serverRestored(base, {revision: 7, generation: "recovery-new"})).toBe(true);
    expect(serverRestored(base, {revision: 10, generation: "recovery-new"})).toBe(true);
    expect(serverRestored(base, {revision: 8, generation: PROFILE_GENERATION})).toBe(false);
});
