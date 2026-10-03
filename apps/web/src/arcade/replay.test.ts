import {describe, expect, test} from "bun:test";
import {DEFAULT_SHOP_CONFIG, createShop} from "@mapae/arcade/shop";
import type {ActivityOutcome} from "@mapae/arcade";
import {admitActivity, admitHumanActivity, completeActivity, isOutcome} from "./activity";
import {addCharacter, admitPracticeRun, newArcadeState, newCompanion} from "./state";
import {parseProfile, projectProfile} from "./profile/model";
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
