import {describe, expect, test} from "bun:test";
import {applyRaceRound, chooseRaceAction, createRaceSeason, makeRaceCourse, parseRaceAction, raceFrameAt, raceObservation,
    RACE_ROUNDS, RACE_STRATEGIES, SEASON_TOKENS, seasonRanking, simulateRace, type RaceCourse, type Racer} from "./race";
import type {AgentProfile} from "./contracts";

const profile: AgentProfile = {name: "말랑", color: "jade", temperament: "curious", goal: "score"};
const entrants: Racer[] = RACE_STRATEGIES.map(strategy => ({id: strategy, name: strategy, strategy}));
const clearShort: RaceCourse = {...makeRaceCourse(0, 0), weather: "clear", course: "short", distance: 850, gust: 0};

describe("Auto Race engine", () => {
    test("the same seed, round and actions reproduce the complete race", () => {
        const first = simulateRace(makeRaceCourse(987, 1), entrants);
        expect(simulateRace(makeRaceCourse(987, 1), entrants)).toEqual(first);
        expect(first.finish).toHaveLength(3);
        expect(first.finish.every(finish => finish.seconds > 0)).toBe(true);
    });

    test("seeded seasons expose varied public conditions within fixed bounds", () => {
        const courses = Array.from({length: 100}, (_, seed) => makeRaceCourse(seed, seed % RACE_ROUNDS));
        expect(new Set(courses.map(course => course.weather)).size).toBe(3);
        expect(new Set(courses.map(course => course.course)).size).toBe(2);
        expect(courses.every(course => [850, 1_250].includes(course.distance))).toBe(true);
        expect(() => makeRaceCourse(NaN, 0)).toThrow();
        expect(() => makeRaceCourse(1, 3)).toThrow();
        expect(() => makeRaceCourse(1, -.1)).toThrow();
    });

    test("each strategy has conditions where it wins; none dominates every course", () => {
        expect(simulateRace(clearShort, entrants).finish[0]!.id).toBe("burst");
        expect(simulateRace({...clearShort, course: "long", distance: 1_250}, entrants).finish[0]!.id).toBe("surge");
        expect(simulateRace({...clearShort, course: "long", distance: 1_250, weather: "rain"}, entrants).finish[0]!.id).toBe("conserve");
    });

    test("early bursts actually lead early and a late surge changes the order", () => {
        const race = simulateRace({...clearShort, distance: 1_250, course: "long"}, entrants);
        const opening = raceFrameAt(race, .2).positions;
        expect(opening.find(item => item.id === "burst")!.distance).toBeGreaterThan(opening.find(item => item.id === "surge")!.distance);
        expect(race.finish[0]!.id).toBe("surge");
        expect(race.finish.find(item => item.id === "conserve")!.stamina).toBeGreaterThan(race.finish.find(item => item.id === "burst")!.stamina);
    });

    test("positions only advance and stamina stays bounded until everyone finishes", () => {
        const race = simulateRace({...clearShort, weather: "rain", distance: 1_250}, entrants);
        let previous = race.frames[0]!;
        for (const frame of race.frames) {
            for (const [index, position] of frame.positions.entries()) {
                expect(position.distance).toBeGreaterThanOrEqual(previous.positions[index]!.distance);
                expect(position.distance).toBeLessThanOrEqual(1_250);
                expect(position.stamina).toBeGreaterThanOrEqual(0);
                expect(position.stamina).toBeLessThanOrEqual(100);
            }
            previous = frame;
        }
        expect(race.frames.at(-1)!.positions.every(position => position.distance === 1_250)).toBe(true);
        expect(race.frames[0]!.positions.every(position => position.distance === 0 && position.stamina === 100)).toBe(true);
    });

    test("entrant order and identities do not change speed or break fair ties", () => {
        const tied: Racer[] = [{id: "owner", name: "말랑", strategy: "conserve"}, {id: "rival", name: "Steady", strategy: "conserve"}];
        const original = simulateRace(clearShort, tied);
        expect(simulateRace(clearShort, tied.toReversed()).finish).toEqual(original.finish);
        expect(original.finish.map(item => item.rank)).toEqual([1, 1]);
        expect(original.finish.map(item => item.points)).toEqual([5, 5]);
    });

    test("playback sampling, pause and jumping to the finish cannot alter a result", () => {
        const race = simulateRace(clearShort, entrants);
        const before = JSON.stringify(race);
        for (let frame = 0; frame <= 300; frame++) raceFrameAt(race, frame / 300);
        raceFrameAt(race, .3);
        raceFrameAt(race, .3);
        expect(raceFrameAt(race, 1).positions.every(position => position.distance === clearShort.distance)).toBe(true);
        expect(raceFrameAt(race, -1).positions.every(position => position.distance === 0)).toBe(true);
        expect(raceFrameAt(race, NaN).time).toBe(0);
        expect(JSON.stringify(race)).toBe(before);
    });

    test("invalid courses, duplicate racers and empty races fail explicitly", () => {
        expect(() => simulateRace(clearShort, [])).toThrow();
        expect(() => simulateRace(clearShort, [entrants[0]!, entrants[0]!])).toThrow();
        expect(() => simulateRace({...clearShort, distance: Infinity}, entrants)).toThrow();
        expect(() => simulateRace({...clearShort, gust: NaN}, entrants)).toThrow();
    });
});

describe("Auto Race decisions and equal-capital season", () => {
    test("actions accept only a bounded pre-race entry and strategy choice", () => {
        expect(parseRaceAction({enter: true, strategy: "surge"})).toEqual({enter: true, strategy: "surge"});
        for (const value of [null, [], {enter: 1, strategy: "burst"}, {enter: true, strategy: "teleport"},
            {enter: true, strategy: "burst", seasonTokens: 999}, {enter: true, strategy: "burst", speed: 999}, {enter: true}]) {
            expect(parseRaceAction(value)).toBeNull();
        }
    });

    test("everyone starts with equal capital and one admission covers exactly three races", () => {
        let season = createRaceSeason(10, profile.name, "ko");
        expect(season.runners.map(runner => runner.tokens)).toEqual([3, 3, 3, 3]);
        for (let round = 0; round < RACE_ROUNDS; round++) {
            const before = JSON.stringify(season);
            const next = applyRaceRound(season, {enter: true, strategy: "surge"});
            expect(JSON.stringify(season)).toBe(before);
            season = next;
        }
        expect(season.runners.every(runner => runner.tokens === 0 && runner.entries === 3)).toBe(true);
        expect(season.rounds).toHaveLength(3);
        expect(() => applyRaceRound(season, {enter: true, strategy: "surge"})).toThrow("finished season");
        expect(() => raceObservation(season, profile)).toThrow("Season already finished");
    });

    test("sitting out saves the owner's tokens, earns no points and still runs the system race", () => {
        let season = createRaceSeason(9, profile.name, "en");
        for (let round = 0; round < 3; round++) season = applyRaceRound(season, {enter: false, strategy: "conserve"});
        const owner = season.runners.find(runner => runner.id === "owner")!;
        expect(owner).toMatchObject({tokens: SEASON_TOKENS, points: 0, entries: 0, wins: 0});
        expect(season.rounds.every(round => round.simulation.entrants.length === 3)).toBe(true);
        expect(season.runners.filter(runner => runner.id !== "owner").every(runner => runner.tokens === 0)).toBe(true);
    });

    test("the engine rejects entries beyond the token limit regardless of a model's decision", () => {
        const season = createRaceSeason(0, profile.name, "ko");
        season.runners[0]!.tokens = 0;
        expect(() => applyRaceRound(season, {enter: true, strategy: "burst"})).toThrow("token limit");
        expect(applyRaceRound(season, {enter: false, strategy: "conserve"}).runners[0]!.tokens).toBe(0);
    });

    test("ranking points are the sum of engine finishes, not chosen by an agent", () => {
        let season = createRaceSeason(723, profile.name, "en");
        for (let round = 0; round < 3; round++) season = applyRaceRound(season, {enter: true, strategy: RACE_STRATEGIES[round]!});
        for (const runner of season.runners) {
            expect(runner.points).toBe(season.rounds.reduce((total, round) => total + round.simulation.finish.find(finish => finish.id === runner.id)!.points, 0));
            expect(runner.wins).toBe(season.rounds.filter(round => round.simulation.finish.find(finish => finish.id === runner.id)!.rank === 1).length);
        }
        const ranking = seasonRanking(season);
        expect(ranking[0]!.rank).toBe(1);
        expect(ranking.every((runner, index) => index === 0 || runner.points <= ranking[index - 1]!.points)).toBe(true);
    });

    test("decision observations contain course and game tokens without any owner wallet or real balance", () => {
        const season = createRaceSeason(9, profile.name, "ko");
        const observation = raceObservation(season, profile);
        expect(observation).toMatchObject({round: 1, seasonTokens: 3, entryCost: 1, remainingRounds: 3, ownerGoal: "score"});
        expect(Object.keys(observation)).not.toContain("balance");
        expect(Object.keys(observation)).not.toContain("allowance");
        expect(Object.keys(observation)).not.toContain("permissionContext");
        expect(JSON.stringify(observation)).not.toContain("privateKey");
    });

    test("local policy adapts to conditions, follows saving intent and never forces entry without tokens", () => {
        expect(chooseRaceAction(profile, clearShort, 3).action.strategy).toBe("burst");
        expect(chooseRaceAction(profile, {...clearShort, weather: "rain", course: "long"}, 3).action.strategy).toBe("conserve");
        expect(chooseRaceAction(profile, {...clearShort, course: "long"}, 3).action.strategy).toBe("surge");
        expect(chooseRaceAction({...profile, goal: "save"}, {...clearShort, weather: "rain", course: "long"}, 3).action.enter).toBe(false);
        expect(chooseRaceAction(profile, clearShort, 0).action.enter).toBe(false);
        expect(chooseRaceAction({...profile, goal: "explore"}, {...clearShort, round: 2}, 3).action.strategy).toBe("surge");
    });

    test("identical complete seasons reproduce ranks and points across several seeds", () => {
        for (let seed = 0; seed < 10; seed++) {
            const run = () => {
                let season = createRaceSeason(seed, profile.name, "ko");
                for (let round = 0; round < 3; round++) season = applyRaceRound(season, chooseRaceAction(profile, makeRaceCourse(seed, round), 3 - round).action);
                return seasonRanking(season);
            };
            expect(run()).toEqual(run());
        }
    });
});
