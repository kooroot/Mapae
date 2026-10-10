import {describe, expect, test} from "bun:test";
import {ARCADE_RULESET_VERSION, type AgentProfile} from "./contracts";
import {GUARDIAN_APTITUDES, type GuardianAptitudes} from "./guardians";
import {advanceAgent, newGame, ROUND_MS} from "./stamp";
import {applyRaceRound, chooseRaceAction, createRaceSeason, makeRaceCourse, RACE_ROUNDS, simulateRace} from "./race";
import {createShop, DEFAULT_SHOP_CONFIG, shopOutcome, shopPatience, simulateShop} from "./shop";
import {chooseOutingGame, raceOutcome, runArcadeSimulation, stampOutcome, stampStrategy, type RaceNote} from "./simulation";

const low: GuardianAptitudes = {stamp: 4, race: 5, shop: 6};
const high: GuardianAptitudes = {stamp: 6, race: 4, shop: 5};
const base: AgentProfile = {name: "Guardian", color: "red", temperament: "bold", goal: "score"};

describe("real aptitude mechanics", () => {
    test("stamp motor is frame-independent at each immutable focus value", () => {
        for (const [stamp, race, shop] of GUARDIAN_APTITUDES) for (const tempo of ["quick", "careful"] as const) {
            const aptitudes = {stamp, race, shop}, whole = advanceAgent(newGame(42, "auto", aptitudes), ROUND_MS, tempo);
            let framed = newGame(42, "auto", aptitudes), index = 0;
            while (!framed.finished) framed = advanceAgent(framed, [16, 83.5, 3000, 7.25][index++ % 4]!, tempo);
            expect(framed).toEqual(whole);
            const profile = {...base, aptitudes, temperament: tempo === "quick" ? "bold" as const : "calm" as const};
            expect(runArcadeSimulation({game: "stamp", seed: 42, profile, locale: "en"})).toEqual(stampOutcome(whole, base.name, stampStrategy(profile, "en").explanation));
        }
    });
    test("focus changes actual hits and aggregate performance, never a result multiplier", () => {
        let strong = 0, weak = 0, differingHits = 0;
        for (let seed = 0; seed < 512; seed++) {
            const a = advanceAgent(newGame(seed, "auto", low), ROUND_MS, "quick");
            const b = advanceAgent(newGame(seed, "auto", high), ROUND_MS, "quick");
            strong += b.score; weak += a.score;
            if (a.hits !== b.hits) differingHits++;
        }
        expect(differingHits).toBeGreaterThan(0);
        expect(strong).toBeGreaterThan(weak);
        expect(strong / weak).toBeLessThan(1.1);
    });
    test("race aptitude alters movement with equal stamina, while legal tactics still matter", () => {
        const course = makeRaceCourse(42, 0);
        const solo = (aptitude: number) => simulateRace(course, [{id: "owner", name: "G", strategy: "conserve", aptitude}]);
        expect(solo(6).finish[0]!.seconds).toBeLessThan(solo(4).finish[0]!.seconds);
        expect(solo(6).frames[0]!.positions[0]!.stamina).toBe(solo(4).frames[0]!.positions[0]!.stamina);
        expect(() => solo(99)).toThrow();
        for (const [stamp, race, shop] of GUARDIAN_APTITUDES) {
            const profile = {...base, aptitudes: {stamp, race, shop}};
            let season = createRaceSeason(42, base.name, "en", profile.aptitudes);
            const notes: RaceNote[] = [];
            for (let round = 0; round < RACE_ROUNDS; round++) {
                const policy = chooseRaceAction(profile, makeRaceCourse(42, round), season.runners[0]!.tokens);
                notes.push({round, ...policy.action, decision: {source: "rules", action: policy.action, explanation: policy.explanation.en}});
                season = applyRaceRound(season, policy.action);
            }
            expect(runArcadeSimulation({game: "race", seed: 42, locale: "en", profile})).toEqual(raceOutcome(season, notes, "en"));
        }
    });
    test("shop aptitude grants bounded negotiation chances without adding funds or customer secrets", () => {
        const weak = createShop(42, DEFAULT_SHOP_CONFIG, undefined, {stamp: 6, race: 5, shop: 4});
        const strong = createShop(42, DEFAULT_SHOP_CONFIG, undefined, {stamp: 4, race: 5, shop: 6});
        expect(strong.cash).toBe(weak.cash);
        expect(strong.buyers).toEqual(weak.buyers);
        expect(shopPatience(strong) - shopPatience(weak)).toBe(2);
        for (const [stamp, race, shop] of GUARDIAN_APTITUDES) {
            const aptitudes = {stamp, race, shop};
            const state = simulateShop(42, DEFAULT_SHOP_CONFIG, "careful", undefined, aptitudes);
            expect(state.phase).toBe("finished");
            const outcome = shopOutcome(state, base.name, "en");
            expect(outcome.replay?.aptitudes).toEqual(aptitudes);
            expect(typeof outcome.achievement?.victory).toBe("boolean");
            expect(state.buyers.every(b => b.spent <= b.cap && b.balance >= 0)).toBe(true);
        }
    });
    test("only validated balanced inputs execute and every result carries replay and typed achievement", () => {
        for (const game of ["stamp", "race", "shop"] as const) {
            expect(() => runArcadeSimulation({game, seed: 1, locale: "en", profile: {...base, aptitudes: {stamp: 6, race: 6, shop: 6}}})).toThrow();
            const profile = {...base, aptitudes: low};
            const en = runArcadeSimulation({game, seed: 1, locale: "en", profile});
            const ko = runArcadeSimulation({game, seed: 1, locale: "ko", profile});
            expect(en.score).toBe(ko.score);
            expect(en.achievement).toEqual(ko.achievement);
            expect(typeof en.achievement?.victory).toBe("boolean");
            expect(en.replay?.aptitudes).toEqual(low);
            expect(en.replay?.version).toBe(ARCADE_RULESET_VERSION);
        }
        expect(chooseOutingGame({...base, aptitudes: low}, "auto", [])).toBe("shop");
        expect(chooseOutingGame({...base, aptitudes: high}, "auto", [])).toBe("stamp");
        expect(chooseOutingGame({...base, aptitudes: high}, "race", [])).toBe("race");
    });
});
