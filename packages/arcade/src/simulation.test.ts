import {describe, expect, test} from "bun:test";
import {ARCADE_RULESET_VERSION, type AgentProfile, type ActivityOutcome, type GameId} from "./contracts";
import {applyRaceRound, chooseRaceAction, createRaceSeason, makeRaceCourse, RACE_ROUNDS} from "./race";
import {applyBuyerAction, applySellerAction, createShop, DEFAULT_SHOP_CONFIG, nextShopCustomer, ruleBuyerAction, ruleSellerAction, shopBuyerObservation, shopOutcome, shopSellerObservation, type ShopMemory} from "./shop";
import {advanceAgent, newBossPractice, newGame, ROUND_MS} from "./stamp";
import {chooseOutingGame, raceOutcome, runArcadeSimulation, stampOutcome, stampStrategy, type RaceNote} from "./simulation";

const profile: AgentProfile = {name: "시험마패", color: "jade", temperament: "curious", goal: "explore"};
const games: GameId[] = ["race", "shop", "stamp"];
const locales = ["ko", "en"] as const;
const seeds = [0, 1, 2, 7, 19, 127, 65535, 0x7fffffff, 0xffffffff];
function assertWireBounds(outcome: ActivityOutcome) {
    expect(games).toContain(outcome.game);
    expect(Number.isSafeInteger(outcome.score)).toBe(true);
    expect(outcome.score).toBeGreaterThanOrEqual(0);
    expect(outcome.score).toBeLessThan(1e9);
    for (const line of [outcome.summary, ...(outcome.highlights ?? [])]) {
        expect(line.ko.length).toBeLessThanOrEqual(500);
        expect(line.en.length).toBeLessThanOrEqual(500);
    }
    expect(outcome.highlights?.length ?? 0).toBeLessThanOrEqual(2);
    expect(outcome.metrics.length).toBeLessThanOrEqual(8);
    for (const metric of outcome.metrics) expect(Number.isFinite(metric.value) && Math.abs(metric.value) <= 1e9).toBe(true);
    expect(outcome.transcript.length).toBeLessThanOrEqual(100);
    for (const line of outcome.transcript) {
        expect(line.speaker.length).toBeLessThanOrEqual(80);
        expect(line.text.length).toBeLessThanOrEqual(1000);
    }
    expect(outcome.ranking.length).toBeLessThanOrEqual(24);
    expect(outcome.ranking.every(rank => rank.name.length <= 80 && Number.isFinite(rank.score))).toBe(true);
    expect(outcome.replay?.version).toBe(ARCADE_RULESET_VERSION);
}

describe("Away game choice", () => {
    test("explicit choices override a goal and exploration only sees visited games", () => {
        for (const goal of ["score", "save", "explore"] as const) {
            for (const choice of games) expect(chooseOutingGame({...profile, goal}, choice, games)).toBe(choice);
        }
        expect(chooseOutingGame({...profile, goal: "score"}, "auto", games)).toBe("race");
        expect(chooseOutingGame({...profile, goal: "save"}, "auto", [])).toBe("shop");
        expect(chooseOutingGame(profile, "auto", [])).toBe("race");
        expect(chooseOutingGame(profile, "auto", ["race"])).toBe("shop");
        expect(chooseOutingGame(profile, "auto", ["race", "shop"])).toBe("stamp");
        expect(chooseOutingGame(profile, "auto", games)).toBe("race");
        expect(() => chooseOutingGame(profile, "other" as "auto", [])).toThrow();
    });
});

describe("Existing engine parity", () => {
    test("whole stamp rounds equal irregular browser frame partitions for both motors", () => {
        for (const seed of seeds) for (const tempo of ["careful", "quick"] as const) {
            const whole = advanceAgent(newGame(seed), ROUND_MS, tempo);
            for (const deltas of [[16, 33, 10, 71], [510, 45, 2000, 7], [17.3, 29.7, 310.25]]) {
                let frame = newGame(seed), index = 0;
                while (!frame.finished) frame = advanceAgent(frame, deltas[index++ % deltas.length]!, tempo);
                expect(frame).toEqual(whole);
            }
            const actor = {...profile, temperament: tempo === "quick" ? "bold" as const : "calm" as const};
            const result = runArcadeSimulation({game: "stamp", seed, profile: actor, locale: "ko"});
            expect(result).toEqual(stampOutcome(whole, actor.name, stampStrategy(actor, "ko").explanation));
            expect(whole.mistakes).toBe(0);
            expect(whole.guardedHits).toBe(0);
            expect(whole.hits).toBeGreaterThan(0);
            expect(whole.bossDefeated).toBe(1);
            expect(whole.perfectHits).toBe(tempo === "careful" ? 3 : 0);
        }
    });

    test("short chief drills keep the shared motor and cap their hits at three", () => {
        for (const tempo of ["careful", "quick"] as const) {
            const drill = advanceAgent(newBossPractice(91), 60000, tempo);
            expect(drill.finished).toBe(true);
            expect(drill.elapsed).toBe(10000);
            expect(drill.bossHits).toBe(3);
            expect(drill.bossDefeated).toBe(1);
            expect(drill.feverActivations).toBe(0);
            expect(drill.perfectHits).toBe(tempo === "careful" ? 3 : 0);
        }
    });

    test("race result comes from all three real seasons, calls, bursts and ranks", () => {
        for (const seed of seeds) for (const goal of ["score", "save", "explore"] as const) {
            const actor = {...profile, goal};
            let season = createRaceSeason(seed, actor.name, "ko");
            const notes: RaceNote[] = [];
            for (let round = 0; round < RACE_ROUNDS; round++) {
                const policy = chooseRaceAction(actor, makeRaceCourse(seed, round), season.runners[0]!.tokens);
                season = applyRaceRound(season, policy.action);
                notes.push({round, ...policy.action, decision: {source: "rules", action: policy.action, explanation: policy.explanation.ko}});
            }
            expect(season.rounds).toHaveLength(3);
            expect(season.rounds.every(round => round.simulation.frames.length > 0 && round.simulation.finish.length === 4)).toBe(true);
            expect(runArcadeSimulation({game: "race", seed, profile: actor, locale: "ko"})).toEqual(raceOutcome(season, notes, "ko"));
        }
    });

    test("shop follows the same role-limited decisions and localized conversation as browser play", () => {
        for (const seed of seeds) for (const locale of locales) {
            const config = {...DEFAULT_SHOP_CONFIG, name: locale === "ko" ? `${profile.name.slice(0, 10)} 잡화점` : `${profile.name.slice(0, 10)}'s shop`};
            let state = createShop(seed, config), turns = 0;
            while (state.phase !== "finished") {
                if (++turns > 40) throw new Error("Browser loop did not terminate");
                if (state.phase === "transition") state = nextShopCustomer(state);
                else if (state.phase === "seller") state = applySellerAction(state, ruleSellerAction(shopSellerObservation(state), locale));
                else state = applyBuyerAction(state, ruleBuyerAction(shopBuyerObservation(state)));
            }
            const outcome = runArcadeSimulation({game: "shop", seed, profile, locale});
            expect(outcome.transcript.slice(1)).toEqual(shopOutcome(state, profile.name, locale).transcript);
            expect({...outcome, transcript: []}).toEqual({...shopOutcome(state, profile.name, locale), transcript: []});
            expect(state.buyers.every(buyer => buyer.spent <= buyer.cap && buyer.spent <= buyer.balance)).toBe(true);
        }
    });

    test("return-visit memory uses a frozen starting scenario and publishes no private buyer balance", () => {
        const memory: ShopMemory = {npc: "twins", visits: 1, service: "complete", value: 100};
        Object.freeze(memory);
        Object.freeze(profile);
        const first = runArcadeSimulation({game: "shop", seed: 4, profile, locale: "ko", shopMemory: memory});
        expect(first.replay?.shopMemory).toEqual(memory);
        expect(first.shopMemory?.npc).toBe("twins");
        expect(first.shopMemory?.visits).toBe(2);
        const replay = runArcadeSimulation({game: "shop", seed: 4, profile, locale: "ko", shopMemory: first.replay!.shopMemory});
        expect(replay).toEqual(first);
        const raw = JSON.stringify(first);
        expect(raw).not.toContain('"buyers"');
        expect(raw).not.toContain('"balance"');
        expect(raw).not.toContain('"permissionContext"');
    });
});

describe("Bounded deterministic headless outcomes", () => {
    test("all profile choices, locales and boundary seeds produce deterministic finite wire results", () => {
        for (const seed of seeds) for (const temperament of ["curious", "bold", "calm"] as const) for (const goal of ["score", "save", "explore"] as const) for (const locale of locales) for (const game of games) {
            const input = {game, seed, profile: {...profile, name: "마".repeat(30), temperament, goal}, locale};
            const outcome = runArcadeSimulation(input);
            expect(runArcadeSimulation(input)).toEqual(outcome);
            expect(outcome.replay?.seed).toBe(seed);
            assertWireBounds(outcome);
        }
    });

    test("rejects malformed seeds, profile input, locale and memory before running a game", () => {
        const input = {game: "stamp" as const, seed: 4, profile, locale: "ko" as const};
        for (const seed of [-1, 1.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER]) expect(() => runArcadeSimulation({...input, seed})).toThrow();
        expect(() => runArcadeSimulation({...input, game: "fake" as GameId})).toThrow();
        expect(() => runArcadeSimulation({...input, locale: "ja" as "ko"})).toThrow();
        for (const name of ["", " ", "x".repeat(31)]) expect(() => runArcadeSimulation({...input, profile: {...profile, name}})).toThrow();
        expect(() => runArcadeSimulation({...input, profile: {...profile, goal: "fake" as "score"}})).toThrow();
        expect(() => runArcadeSimulation({...input, shopMemory: {npc: "twins", visits: 1, service: "missed", value: 50}})).toThrow();
        expect(() => runArcadeSimulation({...input, shopMemory: {...({npc: "twins", visits: 1, service: "complete", value: 100} as ShopMemory), balance: 900} as ShopMemory})).toThrow();
    });
});
