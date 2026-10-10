import {afterEach, beforeEach, expect, test} from "bun:test";
import {makeRaceCourse, raceEvents, raceFrameAt, raceWeatherFactor, simulateRace, RACE_BASE_SPEED, type RaceCommand, type RaceSimulation} from "@mapae/arcade/race";
import type {ArcadeSound, SoundKind} from "../sound";
import {burstGlow, ceremonyMs, confettiPieces, cueStartBeat, dueEvents, gallopRate, groundAt, windRate, MAX_CUE_JUMP, photoFinish, photoFinishEvent, RaceCues, runnerVelocity, sealDelay, staggerTiming, startSignal, START_BEATS} from "./race-fx";

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

test("a horse feels the fork's ground only on the shortcut, for the call's eight seconds, until it arrives", () => {
    // Round 0 in the clear: the first fork is a hill, the second a meadow.
    expect(groundAt(race, 11.9, "owner")).toBeNull();
    expect(groundAt(race, 12, "owner")).toEqual({terrain: "hill", slip: false});
    expect(groundAt(race, 19.9, "owner")).toEqual({terrain: "hill", slip: false});
    expect(groundAt(race, 20, "owner")).toBeNull();
    expect(groundAt(race, 25, "owner")).toBeNull();
    const meadow = simulateRace(long, pair, [calls[0]!, {at: 24, pace: "push", route: "shortcut"}], 30);
    expect(groundAt(meadow, 25, "owner")).toEqual({terrain: "meadow", slip: false});
    const arrived: RaceSimulation = {...meadow, finish: meadow.finish.map(item => item.id === "owner" ? {...item, seconds: 26} : item)};
    expect(groundAt(arrived, 26, "owner")).toBeNull();
    // Rain turns the first fork to mud, and only a push through it slips.
    const rain = {...long, weather: "rain" as const};
    expect(groundAt(simulateRace(rain, pair, [{at: 12, pace: "push", route: "shortcut"}], null), 13, "owner")).toEqual({terrain: "mud", slip: true});
    expect(groundAt(simulateRace(rain, pair, [{at: 12, pace: "save", route: "shortcut"}], null), 13, "owner")).toEqual({terrain: "mud", slip: false});
});

test("the wind blows at 1× on the average headwind, faster as the gust bites, and stays within its bounds", () => {
    expect(windRate(.96)).toBeCloseTo(1);
    expect(windRate(.89)).toBeGreaterThan(windRate(.93));
    expect(windRate(.89)).toBeLessThanOrEqual(2);
    expect(windRate(1.03)).toBe(.5);
    const wind = {...long, weather: "wind" as const};
    for (let distance = 0; distance <= wind.distance; distance += 50) {
        const rate = windRate(raceWeatherFactor(wind, distance));
        expect(rate).toBeGreaterThanOrEqual(.5);
        expect(rate).toBeLessThanOrEqual(2);
    }
});

const realDocument = globalThis.document;
let hidden = false;
beforeEach(() => {hidden = false; Object.defineProperty(globalThis, "document", {value: {get hidden() {return hidden;}}, configurable: true});});
afterEach(() => {Object.defineProperty(globalThis, "document", {value: realDocument, configurable: true});});

function stage() {
    const played: SoundKind[] = [];
    return {played, stage: {tier: "full" as const, sound: {play: (kind: SoundKind) => {played.push(kind);}} as unknown as ArcadeSound, sprite: () => undefined, point: () => undefined, layer: null, flag: null}};
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

test("the start signal belongs to a player's own race at full motion: a watched agent or reduced motion starts at once", () => {
    expect(startSignal(true, "full")).toBe(true);
    expect(startSignal(true, "still")).toBe(false);
    expect(startSignal(true, "light")).toBe(false);
    expect(startSignal(false, "full")).toBe(false);
});

test("the signal ticks twice and goes on its last beat, and a hidden tab hears none of it", () => {
    const {played, stage: run} = stage();
    for (let beat = 0; beat < START_BEATS; beat++) cueStartBeat(beat, run.sound);
    expect(played).toEqual(["tick", "tick", "go"]);
    hidden = true;
    cueStartBeat(0, run.sound);
    expect(played).toHaveLength(3);
});

test("a watched agent's ceremonies end within 300ms and a player's keep their length", () => {
    expect(ceremonyMs("light", 420)).toBe(300);
    expect(ceremonyMs("light", 160)).toBe(160);
    expect(ceremonyMs("full", 420)).toBe(420);
    expect(ceremonyMs("still", 420)).toBe(420);
    const light = staggerTiming("light", 3, 50, 300);
    expect(light.delay + light.duration).toBeLessThanOrEqual(300);
    expect(staggerTiming("full", 3, 50, 300)).toEqual({delay: 450, duration: 240});
});

test("a photo finish is first and second within .8s, dead heat included, and flashes on the second arrival", () => {
    const [first, second] = race.finish;
    const at = (gap: number): RaceSimulation => ({...race, finish: [first!, {...second!, seconds: first!.seconds + gap}]});
    const arrivals = events.filter(event => event.type === "finish");
    expect(photoFinish(at(.5))).toBe(true);
    expect(photoFinish(at(0))).toBe(true);
    expect(photoFinish(at(.81))).toBe(false);
    expect(photoFinishEvent(at(.5), events)).toBe(arrivals[1]);
    expect(photoFinishEvent(at(2), events)).toBeUndefined();
    expect(photoFinish({...race, finish: [first!]})).toBe(false);
});

test("the burst glow holds, then fades over the burst's last 30%", () => {
    expect(burstGlow(0)).toBe(1);
    expect(burstGlow(2.8)).toBeCloseTo(1);
    expect(burstGlow(3.4)).toBeCloseTo(.5);
    expect(burstGlow(4)).toBe(0);
    expect(burstGlow(6)).toBe(0);
});

test("confetti is fourteen obangsaek pieces thrown upward, the same every time", () => {
    const pieces = confettiPieces();
    expect(pieces).toHaveLength(14);
    expect(pieces).toEqual(confettiPieces());
    expect(pieces.every(piece => piece.dy < 0 && piece.delay < 100)).toBe(true);
    expect(new Set(pieces.map(piece => piece.color)).size).toBe(5);
    expect(pieces.some(piece => piece.dx < 0) && pieces.some(piece => piece.dx > 0)).toBe(true);
});

test("the result seal's thump lands 40% into the slam, after its delay; no animation means at once", () => {
    expect(sealDelay({animationDelay: "160ms", animationDuration: ".42s"})).toBeCloseTo(328);
    expect(sealDelay({animationDelay: "0s", animationDuration: "0s"})).toBe(0);
});
