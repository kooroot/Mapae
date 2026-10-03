import {describe, expect, test} from "bun:test";
import type {ActivityOutcome, AgentDecisionRequest} from "@mapae/arcade";
import {admitActivity, admitHumanActivity, completeActivity, isOutcome, parseActivities, practiceBest} from "./activity";
import {mergeProfiles, parseProfile, projectProfile, profileState} from "./profile/model";
import {addCharacter, newCompanion, selectCharacter, selectedCharacter, updateCharacter, newArcadeState, parseArcadeState} from "./state";
import {serializeArcadeState} from "./state-store";
import {parseOutingDecision, parseTicket, ruleDecision} from "./agents";

const created = () => addCharacter(newArcadeState(), newCompanion("maru", {name: "마루", color: "red", temperament: "curious"}));
const admission = (id: string) => ({id, characterId: "maru", game: "race" as const, mode: "rules" as const, source: "mapae-giwa" as const, ticketId: `0x${Buffer.from(id).toString("hex").padEnd(64, "0")}`, giwa: {balanceAfter: "2.99", allowanceAfter: "0.02"}, model: null, reason: "Race"});
const result: ActivityOutcome = {game: "race", score: 15, summary: {ko: "완주", en: "Finished"}, metrics: [], transcript: [], ranking: []};
const request: AgentDecisionRequest = {kind: "outing", profile: {...selectedCharacter(created())!, goal: "explore"}, locale: "ko", observation: {balance: 20, allowance: 2, free: false, requested: "auto", visited: []}};

describe("Shared agent outings", () => {
    test("exploration visits all games and checks permission again before each admission", () => {
        const visited: string[] = [];
        for (const game of ["race", "shop", "stamp"] as const) {
            const d = ruleDecision({...request, observation: {...request.observation, visited}});
            expect(parseOutingDecision(d, "auto")).toEqual({enter: true, game}); visited.push(game);
        }
        expect(ruleDecision({...request, observation: {...request.observation, allowance: 0}}).action.enter).toBe(false);
        expect(ruleDecision({...request, observation: {...request.observation, balance: 0, allowance: 0, free: true}}).action.enter).toBe(true);
    });
    test("goal and explicit destination govern choice; an invalid model choice cannot override owner", () => {
        expect(ruleDecision({...request, profile: {...request.profile, goal: "save"}}).action.game).toBe("shop");
        expect(ruleDecision({...request, observation: {...request.observation, requested: "stamp"}}).action.game).toBe("stamp");
        expect(() => parseOutingDecision({source: "llm", action: {enter: true, game: "shop"}, explanation: "x"}, "race")).toThrow();
    });
    test("an empty wallet cannot record admission before a character is created", () => {
        expect(admitActivity(newArcadeState(), admission("first"), 1)).toEqual({ok: false, reason: "character"});
    });
    test("GIWA admission requires a transaction and cannot consume it twice", () => {
        const a = admission("first");
        const entered = admitActivity(created(), a, 1);
        expect(entered.ok).toBe(true); if (!entered.ok) return;
        expect(entered.demo).not.toHaveProperty("balance");
        expect(entered.activity.giwa).toEqual({balanceAfter: "2.99", allowanceAfter: "0.02"});
        expect(admitActivity(entered.demo, {...a, id: "second"}, 2)).toEqual({ok: false, reason: "duplicate"});
        expect(admitActivity(entered.demo, {...a, id: "third", ticketId: ""}, 3)).toEqual({ok: false, reason: "ticket"});
    });
    test("completion is once-only and all-time best survives trimmed activity history", () => {
        const entered = admitActivity(created(), admission("one"), 1); if (!entered.ok) throw Error();
        const done = completeActivity(entered.demo, "one", result);
        expect(selectedCharacter(done)?.bests.race).toBe(15);
        expect(completeActivity(done, "one", {...result, score: 999})).toBe(done);
        const trimmed = {...done, activities: []};
        expect(selectedCharacter(parseArcadeState(serializeArcadeState(trimmed)))?.bests.race).toBe(15);
    });
    test("wrong game, nonfinite and oversized results cannot alter records", () => {
        const entered = admitActivity(created(), admission("one"), 1); if (!entered.ok) throw Error();
        expect(completeActivity(entered.demo, "one", {...result, game: "shop"})).toBe(entered.demo);
        expect(isOutcome({...result, score: Infinity})).toBe(false);
        expect(isOutcome({...result, transcript: [{speaker: "test", text: "x".repeat(1001)}]})).toBe(false);
        const stopped = completeActivity(entered.demo, "one", null);
        expect(stopped.activities[0]?.status).toBe("stopped"); expect(selectedCharacter(stopped)?.bests.race).toBe(0);
    });
    test("receipts survive reload without persisting unknown secrets", () => {
        const entered = admitActivity(created(), admission("one"), 1_790_704_800_000); if (!entered.ok) throw Error();
        const demo = completeActivity(entered.demo, "one", result);
        Object.assign(demo.activities[0]!, {privateKey: "secret"});
        const wire = serializeArcadeState(demo); expect(wire).not.toContain("secret");
        expect(parseArcadeState(wire).activities[0]?.outcome).toEqual(result);
    });
    test("external ticket boundary rejects wrong units and malformed payment values", () => {
        const v = {source: "mapae-simulation", ticket: {id: "x", game: "race", status: "ready", runId: null, amount: "1.00", unit: "mUSDC", transaction: null, payer: `0x${"1".repeat(40)}`}};
        expect(parseTicket(v).ticket.transaction).toBeNull();
        expect(() => parseTicket({...v, ticket: {...v.ticket, unit: "USDC"}})).toThrow();
        expect(() => parseTicket({...v, ticket: {...v.ticket, transaction: "secret"}})).toThrow();
        expect(() => parseTicket({...v, source: "live"})).toThrow();
    });
});

describe("Multiple character admissions", () => {
    test("multiple characters retain separate receipts under one wallet", () => {
        let demo = addCharacter(created(), newCompanion("cloud", {name: "구름", color: "jade", temperament: "bold"}));
        for (const [id, characterId] of [["first", "maru"], ["second", "cloud"]]) {
            const next = admitActivity(demo, {...admission(id!), characterId: characterId!}, 1);
            if (!next.ok) throw Error(next.reason);
            demo = completeActivity(next.demo, id!, result);
        }
        expect(demo.activities.map(a => a.name)).toEqual(["구름", "마루"]);
        expect(demo.activities).toHaveLength(2);
        expect(demo.characters.every(c => c.bests.race === 15)).toBe(true);
    });
    test("result belongs to its character regardless of current selection", () => {
        let demo = addCharacter(created(), newCompanion("cloud", {name: "구름", color: "jade", temperament: "bold"}));
        const entered = admitActivity(demo, admission("first"), 1); if (!entered.ok) throw Error();
        demo = updateCharacter(selectCharacter(entered.demo, "cloud"), "maru", {name: "새 이름", color: "ink"});
        demo = completeActivity(demo, "first", result);
        expect(selectedCharacter(demo)?.bests.race).toBe(0);
        expect(demo.characters.find(c => c.id === "maru")?.bests.race).toBe(15);
        expect(demo.activities[0]).toMatchObject({characterId: "maru", name: "마루", color: "red"});
        const restored = parseArcadeState(serializeArcadeState(demo));
        expect(restored.selectedCharacterId).toBe("cloud");
        expect(restored.activities[0]?.characterId).toBe("maru");
    });
    test("unknown characters cannot enter or be restored from history", () => {
        expect(admitActivity(newArcadeState(), {...admission("absent"), characterId: "absent"}, 1)).toEqual({ok: false, reason: "character"});
        const entered = admitActivity(created(), admission("one"), 1); if (!entered.ok) throw Error();
        const invalid = {...entered.demo, activities: entered.demo.activities.map(a => ({...a, characterId: "absent"}))};
        expect(parseArcadeState(JSON.stringify(invalid))).toEqual(newArcadeState());
    });
});

describe("Human practice records", () => {
    test("free race and shop records sync without tickets and never change agent best scores", () => {
        const base = created(); let state = base;
        for (const game of ["race", "shop"] as const) {
            const admitted = admitHumanActivity(state, game, "maru", game, 10);
            if (!admitted.ok) throw Error("admission failed");
            state = completeActivity(admitted.demo, game, {...result, game, score: game === "shop" ? -2 : 15});
        }
        expect(state.characters[0]?.bests).toEqual({stamp: 0, race: 0, shop: 0});
        const profile = parseProfile(projectProfile(state)); expect(profile).not.toBeNull();
        const synced = profileState(mergeProfiles(projectProfile(base), profile!, projectProfile(base)));
        expect(practiceBest(synced, "maru", "race")).toBe(15);
        expect(practiceBest(synced, "maru", "shop")).toBe(-2);
        expect(synced.activities.every(a => a.source === "practice" && a.mode === "human" && a.ticketId === null && a.giwa === null)).toBe(true);
        expect(parseArcadeState(serializeArcadeState(state)).activities).toEqual(state.activities);
    });
    test("practice cannot be relabelled as a paid or automated record", () => {
        const admitted = admitHumanActivity(created(), "human", "maru", "shop", 10);
        if (!admitted.ok) throw Error("admission failed");
        for (const patch of [{source: "mapae-giwa"}, {mode: "rules"}, {ticketId: "0x" + "a".repeat(64)}, {giwa: {balanceAfter: "1", allowanceAfter: "1"}}]) {
            expect(parseActivities([{...admitted.activity, ...patch}])).toBeNull();
        }
        expect(admitHumanActivity(admitted.demo, "human", "maru", "race", 11).ok).toBe(false);
        expect(admitHumanActivity(created(), "bad", "absent", "race", 11).ok).toBe(false);
        const stopped = completeActivity(admitted.demo, "human", null);
        expect(completeActivity(stopped, "human", {...result, game: "shop"})).toBe(stopped);
        expect(practiceBest(stopped, "maru", "shop")).toBe(0);
    });
});
