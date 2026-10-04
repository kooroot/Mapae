import {describe, expect, test} from "bun:test";
import {validAllowance} from "./allowance";
import {arcadePolicy} from "./giwa-client";
import {addCharacter, newArcadeState, newCompanion, updateCharacter} from "./state";
import {parseProfile, projectProfile, mergeProfiles} from "./profile/model";

function crew() {
    let state = newArcadeState();
    for (const [id, rounds] of [["maru", 5], ["cloud", 10]] as const) {
        const friend = newCompanion(id, {name: id, color: "jade", temperament: "calm"});
        state = addCharacter(state, {...friend, agent: {...friend.agent, rounds}});
    }
    return state;
}
describe("individual character allowances", () => {
    test("custom amounts survive cloud storage and independent device edits", () => {
        const base = crew(), a = updateCharacter(base, "maru", {agent: {...base.characters[0]!.agent, rounds: 36}});
        const b = updateCharacter(base, "cloud", {agent: {...base.characters[1]!.agent, rounds: 7}});
        const merged = mergeProfiles(projectProfile(base), projectProfile(a), projectProfile(b));
        expect(parseProfile(JSON.parse(JSON.stringify(merged)))?.characters.map(c => c.agent.rounds)).toEqual([36, 7]);
        for (const rounds of [0, 37, 1.5, Infinity, NaN, "5"]) {
            expect(validAllowance(rounds)).toBe(false);
            expect(parseProfile({...merged, characters: merged.characters.map(c => ({...c, agent: {...c.agent, rounds}}))})).toBeNull();
        }
    });
    test("each grant has its own lifetime cap, not the sum of the crew's budgets", () => {
        const a = arcadePolicy(5), b = arcadePolicy(10);
        expect(a.lifetimeTotalAmount).toBe(5_000_000n);
        expect(b.lifetimeTotalAmount).toBe(10_000_000n);
        expect(a.periodAmount).toBe(a.lifetimeTotalAmount!);
        expect(b.periodAmount).toBe(b.lifetimeTotalAmount!);
        expect(a.recipient).toBe(b.recipient);
        expect(a.expiresAfterSeconds).toBe(7200);
    });
});
