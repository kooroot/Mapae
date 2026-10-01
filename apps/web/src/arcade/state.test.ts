import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {admitPracticeRun, addCharacter, newCompanion, selectedCharacter, selectCharacter, updateCharacter, MAX_CHARACTERS, finishPracticeRun, newArcadeState, parseArcadeState, type ArcadeState} from "./state";
import {arcadeStorageKey, readArcadeState, saveArcadeState, serializeArcadeState} from "./state-store";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const friend = () => newCompanion("cloud", {name: "구름", color: "jade", temperament: "calm"});
const created = () => addCharacter(newArcadeState(), newCompanion("maru", {name: "마루", color: "red", temperament: "curious"}));
function enter(state: ArcadeState, id: string) {
    const result = admitPracticeRun(state, id, 123);
    if (!result.ok) throw new Error(result.reason);
    return result;
}
function withStorage(run: (data: Map<string, string>) => void) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {configurable: true, value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {data.set(key, value);},
    }});
    try {run(data);} finally {
        if (original) Object.defineProperty(globalThis, "localStorage", original);
        else Reflect.deleteProperty(globalThis, "localStorage");
    }
}

describe("Wallet-first arcade state", () => {
    test("first visit has no characters, selection, records or local funds", () => {
        const state = newArcadeState();
        expect(state.characters).toEqual([]); expect(state.selectedCharacterId).toBeNull();
        expect(state.runs).toEqual([]); expect(state.activities).toEqual([]);
        expect(selectedCharacter(state)).toBeUndefined();
        expect(state).not.toHaveProperty("balance"); expect(state).not.toHaveProperty("allowance");
        expect(admitPracticeRun(state, "not-created", 0)).toEqual({ok: false, reason: "character"});
    });
    test("empty roster and preferences round-trip without inserting a character", () => {
        const state = {...newArcadeState(true), sound: true};
        expect(parseArcadeState(serializeArcadeState(state))).toEqual(state);
    });
    test("wallet identity is required and address casing shares the same records", () => {
        const lower = "0x5ea109edc7e89b6a752032aa2b6f1092e081e7ec";
        expect(arcadeStorageKey(lower)).toBe(arcadeStorageKey(getAddress(lower)));
        expect(arcadeStorageKey(owner)).not.toBe(arcadeStorageKey(other));
        expect(() => arcadeStorageKey("0x123")).toThrow();
    });
    test("old anonymous demo data is never loaded into a newly connected wallet", () => withStorage(data => {
        data.set("mapae.arcade.demo.v3", JSON.stringify({...created(), balance: 20, allowance: 3, freeUsed: false}));
        expect(readArcadeState(owner)).toEqual(newArcadeState());
        expect(data.size).toBe(1);
    }));
    test("wallet switches isolate rosters and reconnect restores only that wallet", () => withStorage(() => {
        expect(saveArcadeState(owner, created())).toBe(true);
        expect(readArcadeState(other)).toEqual(newArcadeState());
        expect(saveArcadeState(other, addCharacter(newArcadeState(), friend()))).toBe(true);
        expect(readArcadeState(owner)).toEqual(created());
        expect(readArcadeState(other).characters.map(c => c.name)).toEqual(["구름"]);
    }));
    test("corrupt or unavailable data never seeds a replacement character", () => {
        for (const value of [null, "{broken", "null", "[]", JSON.stringify({...created(), selectedCharacterId: null}),
            JSON.stringify({...newArcadeState(), selectedCharacterId: "maru"}),
            JSON.stringify({...created(), runs: [{score: "999"}]}),
            JSON.stringify({...created(), characters: [{...created().characters[0], color: "unknown"}]})]) {
            expect(parseArcadeState(value, true)).toEqual(newArcadeState(true));
        }
    });
    test("repeated human practice has no currency or allowance side effects", () => {
        const first = enter(created(), "first");
        const second = enter(first.demo, "second");
        expect(second.demo.characters).toEqual(created().characters);
        expect(second.ticket).not.toHaveProperty("cost");
        expect(second.demo).not.toHaveProperty("balance");
        expect(second.demo.activities).toEqual([]);
        expect(admitPracticeRun(second.demo, "second", 123)).toEqual({ok: false, reason: "duplicate"});
    });
    test("completion updates the same practice run once and records the best", () => {
        const {demo} = enter(created(), "first");
        const result = {score: 300, bestCombo: 3, hits: 3, mistakes: 0, missed: 1};
        const done = finishPracticeRun(demo, "first", result);
        expect(selectedCharacter(done)?.best).toBe(300);
        expect(done.runs[0]).toMatchObject({...result, status: "complete"});
        expect(finishPracticeRun(done, "first", {...result, score: 900})).toBe(done);
        expect(finishPracticeRun(done, "absent", result)).toBe(done);
    });
    test("recent practice history is bounded while all-time best survives", () => {
        let state = created(); state.characters[0]!.best = 9_000;
        for (let i = 0; i < 45; i++) state = enter(state, `run-${i}`).demo;
        expect(state.runs).toHaveLength(40); expect(state.runs[0]?.id).toBe("run-44");
        expect(selectedCharacter(state)?.best).toBe(9_000);
    });
    test("profile, settings and unfinished practice survive a reload", () => {
        const {demo} = enter(updateCharacter({...created(), sound: true, reducedMotion: true}, "maru", {name: "말랑", color: "jade", temperament: "calm"}), "practice");
        expect(parseArcadeState(serializeArcadeState(demo))).toEqual(demo);
    });
    test("storage projection excludes key material and obsolete fake balances", () => {
        const secret = "0x" + "ab".repeat(32);
        const {demo} = enter(created(), "one");
        const extended = {...demo, privateKey: secret, balance: 999, allowance: 999,
            characters: demo.characters.map(c => ({...c, privateKey: secret, agent: {...c.agent, privateKey: secret}})),
            runs: demo.runs.map(run => ({...run, privateKey: secret, permissionContext: secret}))};
        const saved = serializeArcadeState(extended);
        expect(saved).not.toContain(secret); expect(saved).not.toContain("privateKey");
        expect(saved).not.toContain("permissionContext"); expect(saved).not.toContain("999");
        expect(parseArcadeState(saved)).toEqual(demo);
    });
    test("separate profiles, settings and selection survive storage", () => {
        const original = created();
        const updated = updateCharacter(addCharacter(original, friend()), "cloud", {agent: {mode: "llm", goal: "save", rounds: 3}});
        expect(updated.characters).toHaveLength(2);
        expect(selectedCharacter(updated)).toMatchObject({id: "cloud", name: "구름", agent: {mode: "llm", rounds: 3}});
        expect(updated.characters[0]).toEqual(original.characters[0]);
        expect(parseArcadeState(serializeArcadeState(updated))).toEqual(updated);
    });
    test("completion after switching or renaming credits the original character", () => {
        const first = enter(created(), "first").demo;
        const switched = updateCharacter(addCharacter(first, friend()), "maru", {name: "새 마루", color: "ink"});
        const done = finishPracticeRun(switched, "first", {score: 600, bestCombo: 6, hits: 6, mistakes: 0, missed: 0});
        expect(selectedCharacter(done)?.best).toBe(0);
        expect(done.characters.find(c => c.id === "maru")?.best).toBe(600);
        expect(done.runs[0]).toMatchObject({name: "마루", color: "red", characterId: "maru", score: 600});
    });
    test("duplicates, invalid edits and the roster limit cannot overwrite a member", () => {
        let state = addCharacter(created(), friend());
        expect(addCharacter(state, {...friend(), name: "Other"})).toBe(state);
        expect(updateCharacter(state, "cloud", {name: "   "})).toBe(state);
        expect(selectCharacter(state, "absent")).toBe(state);
        for (let n = 2; n < MAX_CHARACTERS; n++) state = addCharacter(state, {...friend(), id: `friend-${n}`});
        expect(state.characters).toHaveLength(MAX_CHARACTERS);
        expect(addCharacter(state, {...friend(), id: "extra"})).toBe(state);
    });
    test("blank character drafts are not saved on creation or cancellation", () => {
        const state = newArcadeState();
        expect(addCharacter(state, {...friend(), name: ""})).toBe(state);
        expect(state.characters).toEqual([]);
    });
    test("storage rejects ambiguous or orphaned character references", () => {
        const state = enter(created(), "one").demo;
        for (const invalid of [
            {...state, characters: [state.characters[0], state.characters[0]]},
            {...state, selectedCharacterId: "missing"}, {...state, selectedCharacterId: ["maru"]},
            {...state, runs: state.runs.map(r => ({...r, characterId: "missing"}))},
        ]) expect(parseArcadeState(JSON.stringify(invalid))).toEqual(newArcadeState());
    });
});
