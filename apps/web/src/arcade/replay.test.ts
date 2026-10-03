import {describe, expect, test} from "bun:test";
import {DEFAULT_SHOP_CONFIG, createShop} from "@mapae/arcade/shop";
import type {ActivityOutcome} from "@mapae/arcade";
import {admitActivity, admitHumanActivity, completeActivity, isOutcome, latestShopMemory, paidBest, practiceBest} from "./activity";
import {addCharacter, admitPracticeRun, newArcadeState, newCompanion, finishPracticeRun} from "./state";
import {parseProfile, projectProfile, mergeProfiles, profileState} from "./profile/model";
import {ARCADE_REPLAY_VERSION, gameSeed, replaySeed, withReplay} from "./replay";

const fresh = () => addCharacter(newArcadeState(), newCompanion("maru", {name: "마루", color: "jade", temperament: "calm"}));
const outcome: ActivityOutcome = {game: "shop", score: 50, summary: {ko: "영업 끝", en: "Closed"}, metrics: [], transcript: [], ranking: [], highlights: [{ko: "꾸러미 하나 판매", en: "One bundle sold"}]};

describe("Same-scenario free practice", () => {
    test("a paid visit can be challenged for free without reusing its ticket or changing paid bests", () => {
        const paid = admitActivity(fresh(), {id: "12345678-abcd-4abc-a123-123456789abc", characterId: "maru", game: "shop", source: "mapae-giwa", mode: "rules", model: null, reason: "", ticketId: `0x${"a".repeat(64)}`, giwa: {balanceAfter: "9", allowanceAfter: "4"}}, 1);
        if (!paid.ok) throw Error("admission");
        const seed = gameSeed(paid.activity);
        const completed = completeActivity(paid.demo, paid.activity.id, withReplay(outcome, seed));
        const practice = admitHumanActivity(completed, "abcdef12-abcd-4abc-a123-123456789abc", "maru", "shop", 2, replaySeed(completed.activities[0]!.outcome));
        if (!practice.ok) throw Error("practice");
        expect(gameSeed(practice.activity)).toBe(seed);
        expect(practice.activity).toMatchObject({mode: "human", source: "practice", ticketId: null, giwa: null});
        const done = completeActivity(practice.demo, practice.activity.id, withReplay({...outcome, score: 999}, seed));
        expect(done.characters[0]!.bests.shop).toBe(50);
        expect(done.activities.find(a => a.id === paid.activity.id)).toEqual(completed.activities[0]);
    });
    test("highlights, original shop setup and practice seed round-trip through the wallet profile", () => {
        const admission = admitHumanActivity(fresh(), "12345678-example", "maru", "shop", 1, 0);
        if (!admission.ok) throw Error("admission");
        const shop = {...DEFAULT_SHOP_CONFIG, role: "buyer" as const, buyerGoal: "gift" as const, advertising: "poster" as const};
        const result = withReplay({...outcome, replay: {version: ARCADE_REPLAY_VERSION, seed: 0, shop}}, 0);
        const finished = completeActivity(admission.demo, admission.activity.id, result);
        const loaded = parseProfile(projectProfile(finished));
        expect(loaded?.activities[0]?.outcome).toEqual(result);
        expect(gameSeed(loaded!.activities[0]!)).toBe(0);
        expect(createShop(0, loaded!.activities[0]!.outcome!.replay!.shop)).toEqual(createShop(0, shop));
    });
    test("malformed seeds and metadata cannot enter saved records or paid admissions", () => {
        for (const seed of [-1, 0x1_0000_0000, .5, NaN, Infinity]) {
            expect(admitHumanActivity(fresh(), "practice", "maru", "race", 1, seed).ok).toBe(false);
            expect(() => admitPracticeRun(fresh(), "stamp", 1, seed)).toThrow();
            expect(isOutcome({...outcome, replay: {seed, version: 1}})).toBe(false);
        }
        expect(isOutcome({...outcome, highlights: Array(3).fill({ko: "a", en: "b"})})).toBe(false);
        expect(isOutcome({...outcome, highlights: [{ko: "x".repeat(501), en: "b"}]})).toBe(false);
        expect(isOutcome({...outcome, replay: {seed: 1, version: 1, shop: {...DEFAULT_SHOP_CONFIG, privateKey: "secret"}}})).toBe(false);
        expect(isOutcome({...outcome, game: "race", replay: {seed: 1, version: 1, shop: DEFAULT_SHOP_CONFIG}})).toBe(false);
    });
    test("outdated or absent scenario metadata never offers a false exact replay", () => {
        expect(replaySeed(outcome)).toBeUndefined();
        expect(replaySeed({...outcome, replay: {seed: 1, version: ARCADE_REPLAY_VERSION + 1}})).toBeUndefined();
        expect(replaySeed(withReplay(outcome, 0))).toBe(0);
        const original = admitPracticeRun(fresh(), "12345678-original", 1);
        if (!original.ok) throw Error("admission");
        const retry = admitPracticeRun(original.demo, "87654321-retry", 2, gameSeed(original.ticket));
        if (!retry.ok) throw Error("retry");
        expect(gameSeed(retry.ticket)).toBe(gameSeed(original.ticket));
    });
});

describe("Rule changes and authored shop memory", () => {
    test("an old high score stays in history but cannot outrank current rules or return through device merge", () => {
        const base = fresh();
        base.characters[0]!.recordVersion = 1;
        base.characters[0]!.best = 90000;
        base.characters[0]!.bests.shop = 9999;
        const old = admitHumanActivity(base, "old-shop", "maru", "shop", 1);
        if (!old.ok) throw Error();
        const oldState = completeActivity(old.demo, old.activity.id, {...outcome, score: 9999, replay: {seed: 4, version: 1}});
        expect(practiceBest(oldState, "maru", "shop")).toBe(0);
        expect(paidBest(oldState, "maru", "shop")).toBe(0);
        expect(practiceBest(oldState, "maru", "stamp")).toBe(0);
        const current = admitPracticeRun(oldState, "current-stamp", 2);
        if (!current.ok) throw Error();
        const next = finishPracticeRun(current.demo, current.ticket.id, {score: 700, bestCombo: 3, hits: 3, mistakes: 0, missed: 0});
        const merged = profileState(mergeProfiles(projectProfile(oldState), projectProfile(next), projectProfile(oldState)));
        expect(practiceBest(merged, "maru", "stamp")).toBe(700);
        expect(paidBest(merged, "maru", "shop")).toBe(0);
        expect(merged.activities[0]!.outcome!.score).toBe(9999);
        expect(merged.runs[0]!.ruleset).toBe(ARCADE_REPLAY_VERSION);
        expect(parseProfile(projectProfile(merged))).not.toBeNull();
    });
    test("completed follow-up and original starting memory both round-trip to another device", () => {
        const start = {npc: "twins" as const, visits: 1 as const, service: "complete" as const, value: 90};
        const next = {...start, visits: 2 as const, service: "partial" as const, value: 80};
        const a = admitHumanActivity(fresh(), "shop-memory", "maru", "shop", 20, 7);
        if (!a.ok) throw Error();
        const result = withReplay({...outcome, shopMemory: next, replay: {seed: 7, version: ARCADE_REPLAY_VERSION, shop: DEFAULT_SHOP_CONFIG, shopMemory: start}}, 7);
        const state = completeActivity(a.demo, a.activity.id, result);
        const loaded = parseProfile(projectProfile(state));
        expect(loaded).not.toBeNull();
        const synced = profileState(mergeProfiles(projectProfile(fresh()), loaded!, projectProfile(fresh())));
        expect(latestShopMemory(synced, "maru")).toEqual(next);
        expect(synced.activities[0]!.outcome!.replay!.shopMemory).toEqual(start);
        expect(latestShopMemory(synced, "someone-else")).toBeUndefined();
        const stopped = admitHumanActivity(synced, "interrupted", "maru", "shop", 30);
        if (!stopped.ok) throw Error();
        expect(latestShopMemory(completeActivity(stopped.demo, stopped.activity.id, null), "maru")).toEqual(next);
    });
    test("memory cannot smuggle money, authority, secrets or invalid stories into wallet profiles", () => {
        const valid = {npc: "courier", visits: 1, service: "missed", value: 0};
        for (const memory of [{...valid, cap: 9999}, {...valid, privateKey: "secret"}, {...valid, visits: 3}, {...valid, value: Infinity}, {...valid, npc: "admin"}]) {
            expect(isOutcome({...outcome, shopMemory: memory})).toBe(false);
            expect(isOutcome({...outcome, replay: {seed: 1, version: 2, shopMemory: memory}})).toBe(false);
        }
        expect(isOutcome({...outcome, game: "race", shopMemory: valid})).toBe(false);
    });
});
