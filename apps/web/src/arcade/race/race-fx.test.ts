import {afterEach, beforeEach, expect, test} from "bun:test";
import {makeRaceCourse, raceEvents, raceFrameAt, simulateRace, RACE_BASE_SPEED, type RaceCommand, type RaceSimulation} from "@mapae/arcade/race";
import type {ArcadeSound, SoundKind} from "../sound";
import {dueEvents, gallopRate, MAX_CUE_JUMP, RaceCues, runnerVelocity} from "./race-fx";

const long = {...makeRaceCourse(0, 0), weather: "clear" as const, course: "long" as const, distance: 1_250};
const calls: RaceCommand[] = [{at: 12, pace: "save", route: "shortcut"}, {at: 24, pace: "steady", route: "wide"}];
const pair = [{id: "owner", name: "Coach", strategy: "conserve" as const}, {id: "rival", name: "Rival", strategy: "burst" as const}];
const race = simulateRace(long, pair, calls, 30);
const events = raceEvents(race);
const pass = events.find(event => event.type === "pass")!;

test("an event fires once, inside (previous, now], and a jump past the limit or a step back fires nothing", () => {
    expect(dueEvents(events, pass.time - .05, pass.time)).toContainEqual(pass);
    expect(dueEvents(events, pass.time, pass.time + .05)).not.toContainEqual(pass);
    expect(dueEvents(events, pass.time - MAX_CUE_JUMP, pass.time)).toContainEqual(pass);
    expect(dueEvents(events, pass.time - MAX_CUE_JUMP - .01, pass.time)).toEqual([]);
    expect(dueEvents(events, pass.time + .05, pass.time - .05)).toEqual([]);
    expect(dueEvents(events, 30, 30)).toEqual([]);
});

test("strides follow the horse's speed and the viewing speed, clamped, and drag when tired", () => {
    expect(gallopRate(RACE_BASE_SPEED, 1, 80)).toBe(1);
    expect(gallopRate(RACE_BASE_SPEED * 1.5, 1, 80)).toBeCloseTo(1.5);
    expect(gallopRate(RACE_BASE_SPEED, 2, 80)).toBe(2);
    expect(gallopRate(RACE_BASE_SPEED * 3, 2, 80)).toBe(2.2);
    expect(gallopRate(1, 1, 80)).toBe(.6);
    expect(gallopRate(RACE_BASE_SPEED, 1, 24)).toBeCloseTo(.8);
    expect(gallopRate(1, 1, 10)).toBeCloseTo(.48);
});

test("runner speed is the engine step's distance over its time, and the burst shows in it", () => {
    const step = (time: number) => (raceFrameAt(race, (time + .1) / race.seconds).positions[0]!.distance - raceFrameAt(race, time / race.seconds).positions[0]!.distance) / .1;
    expect(runnerVelocity(race, 20.05, 0)).toBeCloseTo(step(20), 6);
    expect(runnerVelocity(race, 31.05, 0)).toBeGreaterThan(runnerVelocity(race, 29.95, 0) * 1.5);
    expect(runnerVelocity(race, 0, 0)).toBeCloseTo(step(0), 6);
    expect(runnerVelocity(race, race.seconds + 5, 0)).toBe(0);
});

const realDocument = globalThis.document;
let hidden = false;
beforeEach(() => {hidden = false; Object.defineProperty(globalThis, "document", {value: {get hidden() {return hidden;}}, configurable: true});});
afterEach(() => {Object.defineProperty(globalThis, "document", {value: realDocument, configurable: true});});

function stage() {
    const played: SoundKind[] = [];
    return {played, stage: {tier: "full" as const, sound: {play: (kind: SoundKind) => {played.push(kind);}} as unknown as ArcadeSound, sprite: () => undefined}};
}
const walk = (cues: RaceCues, sim: RaceSimulation, from: number, to: number, run: ReturnType<typeof stage>["stage"]) => {
    for (let time = from; time <= to + 1e-9; time += 1 / 60 * 3) cues.fire(sim, time, run);
};

test("the owner hears each moment once as the clock crosses it, and a recomputed race keeps the mark", () => {
    const cues = new RaceCues(), {played, stage: run} = stage();
    walk(cues, race, 0, pass.time + .2, run);
    expect(played.filter(kind => kind === "combo")).toHaveLength(1);
    expect(played).toContain("fever");
    expect(played.filter(kind => kind === "tick")).toHaveLength(2);
    // The same round recomputed (a coach call or burst) never replays the moments already crossed.
    const recomputed = simulateRace(long, pair, calls, 30);
    cues.fire(recomputed, pass.time + .2, run);
    walk(cues, recomputed, pass.time + .2, pass.time + .25, run);
    expect(played.filter(kind => kind === "combo")).toHaveLength(1);
});

test("a jump to the result, a hidden tab and a new round's start fire nothing they skipped", () => {
    const cues = new RaceCues(), {played, stage: run} = stage();
    cues.fire(race, 0, run);
    cues.fire(race, race.seconds, run);
    expect(played).toEqual([]);
    const next = simulateRace({...long, round: 1}, pair, calls, 30);
    hidden = true;
    walk(cues, next, 0, pass.time + .2, run);
    expect(played).toEqual([]);
    hidden = false;
    cues.fire(next, pass.time + .3, run);
    expect(played).toEqual([]);
});

test("edging ahead off the gate is not a lead change", () => {
    const early = simulateRace(long, [{id: "owner", name: "Coach", strategy: "burst"}, {id: "rival", name: "Rival", strategy: "conserve"}]);
    expect(raceEvents(early).find(event => event.type === "lead")!.id).toBe("owner");
    const cues = new RaceCues(), {played, stage: run} = stage();
    walk(cues, early, 0, 3, run);
    expect(played).not.toContain("golden");
});
