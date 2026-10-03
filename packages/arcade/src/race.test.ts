import {describe, expect, test} from "bun:test";
import {applyRaceRound, chooseRaceAction, createRaceSeason, makeRaceCourse, parseRaceAction, raceFrameAt, raceObservation,
    raceMotorCall, raceHighlights, RACE_BURST_COST, RACE_BURST_SECONDS, raceEndTime, raceNextCheckpoint, raceLiveRank, RACE_CHECKPOINTS, RACE_ROUNDS, RACE_STRATEGIES, SEASON_TOKENS, seasonRanking, simulateRace, type RaceCourse, type Racer} from "./race";
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


describe("Human race checkpoint calls", () => {
    const racers: Racer[] = [{id: "owner", name: "Coach", strategy: "surge"}, ...entrants];
    test("a late sprint wins on a short clear course while conserving beats it on a rainy long course", () => {
        const time = (course: RaceCourse, pace: "save" | "steady" | "push") => simulateRace(course, racers,
            [{at: 12, pace: "steady", route: "wide"}, {at: 24, pace, route: "wide"}]).finish.find(f => f.id === "owner")!.seconds;
        expect(time(clearShort, "push")).toBeLessThan(time(clearShort, "steady"));
        const rainy: RaceCourse = {...clearShort, weather: "rain", course: "long", distance: 1_250};
        expect(time(rainy, "save")).toBeLessThan(time(rainy, "push"));
        expect(time(rainy, "save")).toBeLessThan(time(rainy, "steady"));
    });
    test("a checkpoint changes only future owner frames, with no teleport or rival rewrite", () => {
        const original = simulateRace(clearShort, racers);
        const changed = simulateRace(clearShort, racers, [{at: 12, pace: "push", route: "wide"}]);
        expect(changed.frames.filter(f => f.time <= 12)).toEqual(original.frames.filter(f => f.time <= 12));
        expect(changed.frames.find(f => f.time === 14)!.positions[0]!.distance).toBeGreaterThan(original.frames.find(f => f.time === 14)!.positions[0]!.distance);
        for (const rival of entrants) expect(changed.finish.find(f => f.id === rival.id)!.seconds).toBe(original.finish.find(f => f.id === rival.id)!.seconds);
        expect(changed.finish.find(f => f.id === "owner")!.stamina).toBeLessThan(original.finish.find(f => f.id === "owner")!.stamina);
    });
    test("a second call preserves the first section and all choices replay deterministically", () => {
        const first = simulateRace(clearShort, racers, [{at: 12, pace: "save", route: "wide"}]);
        const full = simulateRace(clearShort, racers, [{at: 12, pace: "save", route: "wide"}, {at: 24, pace: "push", route: "wide"}]);
        expect(full.frames.filter(f => f.time <= 24)).toEqual(first.frames.filter(f => f.time <= 24));
        expect(simulateRace(clearShort, racers, [{at: 12, pace: "save", route: "wide"}, {at: 24, pace: "push", route: "wide"}])).toEqual(full);
    });
    test("only the ordered checkpoints accept bounded pace names", () => {
        expect(() => simulateRace(clearShort, racers, [{at: 24, pace: "push", route: "wide"}])).toThrow("checkpoint");
        expect(() => simulateRace(clearShort, racers, [{at: -1, pace: "push", route: "wide"}])).toThrow("checkpoint");
        expect(() => simulateRace(clearShort, entrants, [{at: 12, pace: "push", route: "wide"}])).toThrow("checkpoint");
        expect(() => simulateRace(clearShort, racers, [{at: 12, pace: "push", route: "wide"}, {at: 24, pace: "save", route: "wide"}, {at: 30, pace: "push", route: "wide"}])).toThrow("checkpoint");
    });
    test("recomputing from the round start consumes one entry and scores only the final finish", () => {
        const start = createRaceSeason(1, "Coach", "en");
        const before = JSON.stringify(start);
        const result = applyRaceRound(start, {enter: true, strategy: "surge"}, [{at: 12, pace: "steady", route: "wide"}, {at: 24, pace: "push", route: "wide"}]);
        expect(JSON.stringify(start)).toBe(before);
        expect(result.round).toBe(1);
        expect(result.runners[0]!.tokens).toBe(2);
        expect(result.runners[0]!.points).toBe(result.rounds[0]!.simulation.finish.find(f => f.id === "owner")!.points);
        expect(result.rounds[0]!.commands).toHaveLength(2);
    });
});

describe("Terrain and route trade-offs", () => {
    const racers: Racer[] = [{id: "owner", name: "Coach", strategy: "conserve"}, ...entrants];
    const at20 = (course: RaceCourse, route: "wide" | "shortcut", pace: "steady" | "push" = "steady") =>
        simulateRace(course, racers, [{at: 12, pace, route}]).frames.find(f => f.time === 20)!.positions[0]!;
    test("a meadow shortcut gains distance at the expense of stamina", () => {
        const meadow = {...clearShort, round: 1};
        const inner = at20(meadow, "shortcut"), outer = at20(meadow, "wide");
        expect(inner.distance).toBeGreaterThan(outer.distance);
        expect(inner.stamina).toBeLessThan(outer.stamina);
    });
    test("mud rewards a controlled shortcut but punishes sprinting down it", () => {
        const muddy = {...clearShort, weather: "rain" as const};
        expect(at20(muddy, "shortcut").distance).toBeGreaterThan(at20(muddy, "wide").distance);
        expect(at20(muddy, "shortcut", "push").distance).toBeLessThan(at20(muddy, "wide", "push").distance);
    });
    test("changing a route preserves the past and rival results", () => {
        const wide = simulateRace(clearShort, racers, [{at: 12, pace: "steady", route: "wide"}]);
        const shortcut = simulateRace(clearShort, racers, [{at: 12, pace: "steady", route: "shortcut"}]);
        expect(shortcut.frames.filter(f => f.time <= 12)).toEqual(wide.frames.filter(f => f.time <= 12));
        expect(shortcut.finish.filter(f => f.id !== "owner")).toEqual(wide.finish.filter(f => f.id !== "owner"));
        // @ts-expect-error Deliberately malformed external command.
        expect(() => simulateRace(clearShort, racers, [{at: 12, pace: "steady", route: "teleport"}])).toThrow("checkpoint");
    });
});


describe("Two coach calls and live standings", () => {
    test("the third arrival settles every place without waiting for or teleporting the fourth horse", () => {
        const race = simulateRace({...clearShort, distance: 1250, course: "long"}, [{id: "owner", name: "Coach", strategy: "burst"}, ...entrants], [{at: 12, pace: "push", route: "shortcut"}, {at: 24, pace: "push", route: "shortcut"}], null);
        const end = raceEndTime(race), frame = raceFrameAt(race, end / race.seconds);
        expect(end).toBe(race.finish[2]!.seconds);
        expect(race.finish[3]!.seconds - end).toBeGreaterThan(20);
        expect(frame.positions.filter(p => p.distance === race.course.distance)).toHaveLength(3);
        for (const finish of race.finish) expect(raceLiveRank(race, frame, finish.id)).toBe(finish.rank);
        expect(race.finish[3]!.points).toBe(1);
        expect(frame.positions.find(p => p.id === race.finish[3]!.id)!.distance).toBeLessThan(race.course.distance);
    });
    test("short fields and tied arrivals settle correctly, and late coach calls cannot delay the result", () => {
        for (const size of [1, 2, 3, 4]) {
            const race = simulateRace(clearShort, Array.from({length: size}, (_, i) => ({id: String(i), name: String(i), strategy: "conserve"})));
            const end = raceEndTime(race);
            expect(race.finish.every(f => f.seconds === end && f.rank === 1)).toBe(true);
            expect(raceFrameAt(race, end / race.seconds).positions.every(p => p.distance === race.course.distance)).toBe(true);
        }
        const race = simulateRace({...clearShort, distance: 700}, [{id: "owner", name: "Coach", strategy: "conserve"}, ...entrants], [{at: 12, pace: "save", route: "wide"}]);
        expect(raceEndTime(race)).toBeLessThan(race.finish.find(f => f.id === "owner")!.seconds);
        expect(raceNextCheckpoint(race, 1)).toBe(24);
        expect(raceNextCheckpoint(race, 2)).toBeUndefined();
        expect(raceNextCheckpoint(race, 3)).toBeUndefined();
    });
    test("each additional call preserves all already seen frames and consumes no extra ticket", () => {
        const start = createRaceSeason(0, "Coach", "en");
        const commands: import("./race").RaceCommand[] = [];
        let previous = applyRaceRound(start, {enter: true, strategy: "conserve"});
        for (const at of RACE_CHECKPOINTS) {
            commands.push({at, pace: at === 24 ? "push" : "save", route: "wide"});
            const next = applyRaceRound(start, {enter: true, strategy: "conserve"}, commands);
            expect(next.rounds[0]!.simulation.frames.filter(f => f.time <= at)).toEqual(previous.rounds[0]!.simulation.frames.filter(f => f.time <= at));
            expect(next.runners[0]!.tokens).toBe(2);
            previous = next;
        }
        expect(previous.rounds[0]!.commands).toHaveLength(2);
    });
    test("live standings share opening ties and retain actual finish order", () => {
        const race = simulateRace(clearShort, [...entrants].reverse());
        for (const runner of race.entrants) {
            expect(raceLiveRank(race, race.frames[0]!, runner.id)).toBe(1);
            expect(raceLiveRank(race, raceFrameAt(race, 1), runner.id)).toBe(race.finish.find(f => f.id === runner.id)!.rank);
        }
    });
});


describe("One-use bursts, shared motors and season rivals", () => {
    const racers: Racer[] = [{id: "owner", name: "Coach", strategy: "conserve"}, ...entrants];
    test("manual bursts preserve every seen frame and have one exact upfront cost", () => {
        const original = simulateRace(clearShort, racers, [], null);
        const changed = simulateRace(clearShort, racers, [], 10.1);
        expect(changed.frames.filter(frame => frame.time <= 10.1)).toEqual(original.frames.filter(frame => frame.time <= 10.1));
        for (const time of [9.99, 10, 10.05, 10.1]) expect(raceFrameAt(changed, time / changed.seconds)).toEqual(raceFrameAt(original, time / original.seconds));
        const before = raceFrameAt(original, 10.2 / original.seconds).positions[0]!;
        const after = raceFrameAt(changed, 10.2 / changed.seconds).positions[0]!;
        expect(before.stamina - after.stamina).toBeCloseTo(RACE_BURST_COST, 6);
        expect(after.distance).toBeGreaterThan(before.distance);
        expect(changed.bursts.filter(burst => burst.id === "owner")).toHaveLength(1);
        expect(original.bursts.some(burst => burst.id === "owner")).toBe(false);
        for (const rival of entrants) expect(changed.finish.find(f => f.id === rival.id)!.seconds).toBe(original.finish.find(f => f.id === rival.id)!.seconds);
        expect(simulateRace(clearShort, racers, [], 10.1)).toEqual(changed);
    });
    test("no actor can burst with insufficient stamina or alter legal timing bounds", () => {
        const tired: Racer[] = [{id: "owner", name: "Coach", strategy: "burst"}, ...entrants];
        const exhausted = simulateRace({...clearShort, distance: 1_250, weather: "rain"}, tired,
            [{at: 12, pace: "push", route: "shortcut"}, {at: 24, pace: "push", route: "shortcut"}], 45);
        expect(exhausted.bursts.some(burst => burst.id === "owner")).toBe(false);
        for (const at of [-1, NaN, Infinity, .15, 201]) expect(() => simulateRace(clearShort, racers, [], at)).toThrow("burst");
        expect(() => simulateRace(clearShort, entrants, [], 10)).toThrow("burst");
        expect(parseRaceAction({enter: true, strategy: "surge", burstSpeed: 50})).toBeNull();
    });
    test("humans can reproduce the exact motor calls and burst of an equally equipped opponent", () => {
        const equal: Racer[] = [{id: "owner", name: "Coach", strategy: "surge"}, {id: "rival", name: "Rival", strategy: "surge"}];
        const bot = simulateRace(clearShort, equal);
        const calls = bot.calls.filter(call => call.id === "rival").map(({at, pace, route}) => ({at, pace, route}));
        const manual = simulateRace(clearShort, equal, calls, bot.bursts.find(burst => burst.id === "rival")!.at);
        expect(manual.finish[0]!.seconds).toBe(manual.finish[1]!.seconds);
        expect(manual.finish.map(finish => finish.rank)).toEqual([1, 1]);
        expect(manual.frames).toEqual(bot.frames);
        expect(raceMotorCall(clearShort, "surge", 0, 100).at).toBe(12);
    });
    test("every motor stays within two forks and one burst across varied courses", () => {
        const winners = new Set<string>();
        for (let seed = 0; seed < 40; seed++) {
            const race = simulateRace(makeRaceCourse(seed, seed % 3), entrants);
            winners.add(race.finish[0]!.id);
            for (const runner of entrants) {
                expect(race.calls.filter(call => call.id === runner.id).map(call => call.at)).toEqual([12, 24]);
                expect(race.bursts.filter(burst => burst.id === runner.id).length).toBeLessThanOrEqual(1);
            }
            expect(race.bursts.every(burst => burst.staminaBefore >= RACE_BURST_COST)).toBe(true);
        }
        expect([...winners].sort()).toEqual([...RACE_STRATEGIES].sort());
    });
    test("highlights use observed burst positions and never invent an unused burst", () => {
        expect(raceHighlights(simulateRace(clearShort, racers, [], null))).toEqual([]);
        const race = simulateRace(clearShort, racers, [], 30);
        const highlight = raceHighlights(race);
        expect(highlight).toHaveLength(1);
        const burst = race.bursts.find(item => item.id === "owner")!;
        const after = raceFrameAt(race, Math.min(burst.at + RACE_BURST_SECONDS, raceEndTime(race)) / race.seconds);
        const gained = raceLiveRank(race, raceFrameAt(race, burst.at / race.seconds), "owner") - raceLiveRank(race, after, "owner");
        expect(highlight[0]!.en).toContain(gained > 0 ? `gained ${gained} place` : `place ${raceLiveRank(race, after, "owner")}`);
    });
    test("the seeded rival stays the same for all three races and is a real entrant", () => {
        let season = createRaceSeason(9, "Coach", "ko");
        const rival = season.rivalId;
        expect(rival).not.toBe("owner");
        expect(createRaceSeason(9, "Someone else", "en").rivalId).toBe(rival);
        for (let round = 0; round < 3; round++) {
            season = applyRaceRound(season, {enter: true, strategy: "conserve"});
            expect(season.rivalId).toBe(rival);
            expect(season.rounds[round]!.simulation.entrants.some(runner => runner.id === rival)).toBe(true);
        }
    });
});
