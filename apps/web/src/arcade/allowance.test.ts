import {describe, expect, test} from "bun:test";
import type {Address, Hex} from "viem";
import {CharacterAllowances, type CharacterPermission} from "./giwa-allowance-session";
import {planOutings, validAllowance} from "./allowance";
import {arcadePolicy} from "./giwa-client";
import {addCharacter, newArcadeState, newCompanion, updateCharacter} from "./state";
import {parseProfile, projectProfile, mergeProfiles} from "./profile/model";
import {ruleDecision, parseOutingDecision} from "./agents";

const owner: Address = "0x1111111111111111111111111111111111111111";
const payer: Address = "0x2222222222222222222222222222222222222222";
function permission(characterId: string, limit: number, context: Hex): CharacterPermission {
    return {characterId, name: characterId, limit, context, owner, payer, expires: Date.now() / 1000 + 1800,
        provider: async () => ({delegationManager: owner, delegator: payer, permissionContext: context})};
}
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
        expect(a.expiresAfterSeconds).toBe(1800);
    });
    test("settling or recovering one friend's ticket cannot debit another friend's allowance", () => {
        const book = new CharacterAllowances(), a = permission("maru", 2, "0x11"), b = permission("cloud", 5, "0x22");
        book.add(a); book.add(b);
        expect(book.get("maru")?.provider).toBe(a.provider);
        expect(book.get("cloud")?.provider).toBe(b.provider);
        book.settled("maru", "ticket-a"); book.settled("maru", "ticket-a");
        expect(book.remaining("maru")).toBe(1); expect(book.remaining("cloud")).toBe(5);
        book.settled("maru", "ticket-b");
        expect(book.remaining("maru")).toBe(0);
        expect(planOutings(["maru", "cloud", "unsigned"], book.view(), "auto").map(j => j.characterId)).toEqual(Array(5).fill("cloud"));
    });
    test("outings alternate friends and stop at each approved budget", () => {
        const book = new CharacterAllowances(); book.add(permission("maru", 2, "0x11")); book.add(permission("cloud", 4, "0x22"));
        expect(planOutings(["maru", "cloud", "maru", "unsigned"], book.view(), "auto")).toEqual(
            ["maru", "cloud", "maru", "cloud", "cloud", "cloud"].map(characterId => ({characterId, choice: "auto"})),
        );
        expect(planOutings(["maru", "cloud"], book.view(), "race").every(job => job.choice === "race")).toBe(true);
    });
    test("expiration and selective revocation discard authority without affecting other friends", () => {
        const book = new CharacterAllowances(), now = Date.now() / 1000;
        book.add({...permission("maru", 2, "0x11"), expires: now + 10});
        book.add(permission("cloud", 4, "0x22"));
        const snapshot = book.view();
        expect(planOutings(["maru", "cloud"], snapshot, "auto", now + 11).map(j => j.characterId)).toEqual(Array(4).fill("cloud"));
        expect(book.get("maru", now + 11)).toBeUndefined();
        book.revoke("0x11"); expect(book.remaining("cloud")).toBe(4);
        book.revoke("0x22"); expect(book.view()).toEqual({});
        // Cross-device recovery has no local agent key to debit or resurrect.
        book.settled("cloud", "recovered"); expect(book.view()).toEqual({});
    });
    test("partial approval survives a retry and active permission cannot be overwritten", () => {
        const book = new CharacterAllowances(); book.add(permission("maru", 2, "0x11"));
        expect(() => book.add(permission("maru", 10, "0x33"))).toThrow("Stop the existing allowance");
        book.add(permission("cloud", 4, "0x22"));
        book.stop("maru"); book.add(permission("maru", 10, "0x33"));
        expect(book.remaining("cloud")).toBe(4); expect(book.remaining("maru")).toBe(10);
        expect(Object.keys(book.view().maru!).sort()).toEqual(["expires", "limit", "name", "remaining"]);
        expect(JSON.stringify(book.view())).not.toMatch(/provider|permissionContext|privateKey|0x33/);
        book.stop(); expect(book.view()).toEqual({});
    });
    test("bad limits and expired permissions cannot start a session", () => {
        const book = new CharacterAllowances();
        for (const limit of [0, 37, 0.5, NaN]) expect(() => book.add(permission("maru", limit, "0x11"))).toThrow();
        expect(() => book.add({...permission("maru", 2, "0x11"), expires: 0})).toThrow();
        expect(() => book.add(permission("../other", 2, "0x11"))).toThrow();
    });
    test("automatic exploration chooses games anew and exhausts only the intended budgets", () => {
        const book = new CharacterAllowances(), histories: Record<string, string[]> = {maru: [], cloud: []};
        book.add(permission("maru", 2, "0x11")); book.add(permission("cloud", 4, "0x22"));
        const jobs = planOutings(["maru", "cloud"], book.view(), "auto");
        for (const [index, job] of jobs.entries()) {
            const decision = ruleDecision({kind: "outing", locale: "ko", profile: {name: job.characterId, color: "red", temperament: "curious", goal: "explore"},
                observation: {allowance: book.remaining(job.characterId), balance: 10, free: false, requested: job.choice, visited: histories[job.characterId]!}});
            const plan = parseOutingDecision(decision, "auto"); expect(plan.enter).toBe(true);
            histories[job.characterId]!.push(plan.game); book.settled(job.characterId, `ticket-${index}`);
        }
        expect(histories.maru).toEqual(["race", "shop"]);
        expect(histories.cloud).toEqual(["race", "shop", "stamp", "race"]);
        expect(book.remaining("maru")).toBe(0); expect(book.remaining("cloud")).toBe(0);
        expect(planOutings(["maru", "cloud"], book.view(), "auto")).toEqual([]);
    });
});
