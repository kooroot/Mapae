import {describe, expect, test} from "bun:test";
import {activateFever, advance, advanceAgent, newBossPractice, newGame, stamp, stampEvents, BOSS_CYCLE_MS, BOSS_GUARD_MS, BOSS_OPENINGS, BOSS_PERFECT_START_MS, FEVER_TARGET, ROUND_MS, type Actor, type Game, type StampEvent} from "./stamp";

/** A quiet board at `elapsed`: no arrivals until long after the step under test. */
function quiet(elapsed: number, game = newGame(7)): Game {
    return {...game, elapsed, nextSpawn: ROUND_MS};
}
function place(game: Game, actor: Partial<Actor> & Pick<Actor, "kind">, index = 0): Game {
    return {...game, cells: game.cells.map((cell, i) => i === index ? {actor: {bornAt: game.elapsed, expiresAt: game.elapsed + 1_000, ...actor}, impact: null} : cell)};
}
const types = (events: StampEvent[]) => events.map(event => event.type);
const of = <T extends StampEvent["type"]>(events: StampEvent[], type: T) => events.filter((event): event is Extract<StampEvent, {type: T}> => event.type === type);
/** A chief drill stepped to `at` milliseconds after the chief arrived. */
function chiefAt(at: number): Game {
    const spawned = advance(newBossPractice(3), 300);
    return at ? advance(spawned, at) : spawned;
}

describe("stampEvents", () => {
    test("a step that changes nothing visible reports nothing", () => {
        const game = quiet(1_000);
        expect(stampEvents(game, advance(game, 16))).toEqual([]);
        expect(stampEvents(game, game)).toEqual([]);
    });

    test("a stamped goblin is a hit carrying the face it landed on", () => {
        const game = place(quiet(2_000), {kind: "goblin", golden: true}, 3);
        const events = stampEvents(game, stamp(game, 3), 3);
        expect(of(events, "hit")).toEqual([{type: "hit", index: 3, actor: {kind: "goblin", special: undefined, golden: true}, points: 250}]);
        expect(types(events)).not.toContain("kill");
        expect(types(events)).not.toContain("dud");
    });

    test("a tap that changes nothing is a dud at that window, and only when a tap is named", () => {
        const game = quiet(2_000);
        expect(stampEvents(game, stamp(game, 5), 5)).toEqual([{type: "dud", index: 5}]);
        const cooling = stamp(place(game, {kind: "goblin", special: "armored", hp: 2}), 0);
        expect(stampEvents(cooling, stamp(cooling, 0), 0)).toEqual([{type: "dud", index: 0}]);
    });

    test("armor cracks on the first stamp and the second stamp is a hit and a kill", () => {
        const game = place(quiet(2_000), {kind: "goblin", special: "armored", hp: 2, expiresAt: 4_000});
        const cracked = stamp(game, 0);
        expect(stampEvents(game, cracked, 0)).toEqual([{type: "crack", index: 0, actor: {kind: "goblin", special: "armored", golden: undefined}}]);
        const later = advance(cracked, 120);
        const events = stampEvents(later, stamp(later, 0), 0);
        expect(types(events)).toEqual(["hit", "kill", "feverCharge"]);
        expect(of(events, "kill")).toEqual([{type: "kill", index: 0, variant: "armored"}]);
        expect(of(events, "hit")[0]!.actor.special).toBe("armored");
    });

    test("a stamped courier is wrong, costs points and breaks the streak", () => {
        const game = place({...quiet(6_000), score: 500, combo: 7}, {kind: "courier"}, 2);
        const events = stampEvents(game, stamp(game, 2), 2);
        expect(of(events, "wrong")).toEqual([{type: "wrong", index: 2, points: -100}]);
        expect(of(events, "comboBreak")).toEqual([{type: "comboBreak", from: 7}]);
    });

    test("an escaped goblin is a miss with its face; a courier leaving unharmed is a pass", () => {
        const game = place(place({...quiet(6_000), combo: 3}, {kind: "goblin", special: "armored", hp: 2}, 1), {kind: "courier"}, 7);
        const events = stampEvents(game, advance(game, 1_000));
        expect(of(events, "miss")).toEqual([{type: "miss", index: 1, actor: {kind: "goblin", special: "armored", golden: undefined}}]);
        expect(of(events, "pass")).toEqual([{type: "pass", index: 7}]);
        expect(of(events, "comboBreak")).toEqual([{type: "comboBreak", from: 3}]);
    });

    test("a miss is still reported when one long step also outlives its marker", () => {
        const game = place(quiet(6_000), {kind: "goblin"}, 4);
        const after = advance(game, 2_000);
        expect(after.cells[4]!.impact).toBeNull();
        expect(types(stampEvents(game, after))).toContain("miss");
    });

    test("actors the final bell clears never ran out their time, so they are neither missed nor passed", () => {
        const game = place(place(quiet(ROUND_MS - 10), {kind: "goblin"}, 0), {kind: "courier"}, 1);
        const events = stampEvents(game, advance(game, 20));
        expect(types(events)).not.toContain("miss");
        expect(types(events)).not.toContain("pass");
        expect(of(events, "finished")).toHaveLength(1);
        expect(of(events, "challenge")).toEqual([{type: "challenge", id: "courier"}]);
    });

    test("the multiplier reaching a new tier is a comboTier", () => {
        const game = place({...quiet(2_000), combo: 4}, {kind: "goblin"});
        expect(of(stampEvents(game, stamp(game, 0)), "comboTier")).toEqual([{type: "comboTier", multiplier: 2}]);
        const steady = place({...quiet(2_000), combo: 5}, {kind: "goblin"});
        expect(of(stampEvents(steady, stamp(steady, 0)), "comboTier")).toEqual([]);
    });

    test("charging, auto fever, manual fever and fever running out", () => {
        const charging = place({...quiet(2_000), feverCharge: 2}, {kind: "goblin"});
        expect(of(stampEvents(charging, stamp(charging, 0)), "feverCharge")).toEqual([{type: "feverCharge", charge: 3}]);
        const ready = place({...quiet(2_000), feverCharge: FEVER_TARGET - 1}, {kind: "goblin"});
        const auto = stampEvents(ready, stamp(ready, 0));
        expect(types(auto)).toContain("feverStart");
        expect(types(auto)).not.toContain("feverCharge");
        const manual = {...quiet(2_000, newGame(7, "manual")), feverCharge: FEVER_TARGET};
        expect(stampEvents(manual, activateFever(manual))).toEqual([{type: "feverStart"}]);
        const ending = {...quiet(2_000), feverUntil: 2_100};
        expect(stampEvents(ending, advance(ending, 50))).toEqual([]);
        expect(stampEvents(ending, advance(ending, 100))).toEqual([{type: "feverEnd"}]);
    });

    test("crossing into a new wave and each gold parade phase", () => {
        const wave = quiet(11_990);
        expect(stampEvents(wave, advance(wave, 20))).toEqual([{type: "wave", index: 1}]);
        const soon = quiet(15_990);
        expect(stampEvents(soon, advance(soon, 20))).toEqual([{type: "parade", phase: "soon"}]);
        const active = quiet(17_990);
        expect(stampEvents(active, advance(active, 20))).toEqual([{type: "parade", phase: "active"}]);
    });

    test("the chief arriving is a bossSpawn, not a phase change", () => {
        const drill = newBossPractice(3);
        expect(stampEvents(drill, advance(drill, 300))).toEqual([{type: "bossSpawn", index: 4}]);
    });

    test("the chief moving between guard, open and recover is a bossPhase with its opening", () => {
        const guard = chiefAt(BOSS_GUARD_MS - 10);
        expect(stampEvents(guard, advance(guard, 20))).toEqual([{type: "bossPhase", index: 4, phase: "open", opening: 0}]);
        const open = chiefAt(BOSS_CYCLE_MS - 10);
        expect(stampEvents(open, advance(open, 20))).toEqual([{type: "bossPhase", index: 4, phase: "guard", opening: 1}]);
        const hit = stamp(chiefAt(BOSS_GUARD_MS + 100), 4);
        expect(of(stampEvents(chiefAt(BOSS_GUARD_MS + 100), hit, 4), "bossPhase")).toEqual([{type: "bossPhase", index: 4, phase: "recover", opening: 0}]);
    });

    test("tapping the chief while it guards is a guard", () => {
        const game = chiefAt(200);
        expect(stampEvents(game, stamp(game, 4), 4)).toEqual([{type: "guard", index: 4}]);
    });

    test("a precise chief stamp is a crack and a perfect; the precise last opening is a hit, a perfect and a kill", () => {
        const first = chiefAt(BOSS_PERFECT_START_MS + 50);
        const events = stampEvents(first, stamp(first, 4), 4);
        expect(types(events)).toEqual(["crack", "perfect", "bossPhase"]);
        expect(of(events, "crack")[0]!.actor.special).toBe("boss");
        let game = chiefAt(0);
        for (let opening = 0; opening < BOSS_OPENINGS - 1; opening++) game = stamp(advance(game, opening * BOSS_CYCLE_MS + BOSS_PERFECT_START_MS + 50 - (game.elapsed - 300)), 4);
        game = advance(game, (BOSS_OPENINGS - 1) * BOSS_CYCLE_MS + BOSS_PERFECT_START_MS + 50 - (game.elapsed - 300));
        const last = stampEvents(game, stamp(game, 4), 4);
        expect(of(last, "hit")[0]).toMatchObject({index: 4, actor: {special: "boss"}});
        expect(of(last, "perfect")).toEqual([{type: "perfect", index: 4}]);
        expect(of(last, "kill")).toEqual([{type: "kill", index: 4, variant: "boss"}]);
        expect(of(last, "challenge").map(event => event.id)).toEqual(["boss", "precision"]);
    });

    test("finishing a round objective is a challenge", () => {
        const game = place({...quiet(2_000), hits: 19}, {kind: "goblin"});
        expect(of(stampEvents(game, stamp(game, 0)), "challenge")).toEqual([{type: "challenge", id: "hunter"}]);
    });

    test("each of the last ten seconds is an urgentSecond, and earlier seconds are not", () => {
        const early = quiet(48_990);
        expect(stampEvents(early, advance(early, 20))).toEqual([]);
        const urgent = quiet(50_990);
        expect(stampEvents(urgent, advance(urgent, 20))).toEqual([{type: "urgentSecond", seconds: 9}]);
        expect(of(stampEvents(quiet(49_990), advance(quiet(49_990), 20)), "urgentSecond")).toEqual([{type: "urgentSecond", seconds: 10}]);
    });

    test("frame-by-frame events over a whole agent round add up to the engine's own counters", () => {
        for (const tempo of ["careful", "quick"] as const) {
            let game = newGame(41, tempo === "careful" ? "manual" : "auto", {stamp: 6, race: 5, shop: 4});
            const events: StampEvent[] = [];
            while (!game.finished) {
                const next = advanceAgent(game, 16, tempo);
                events.push(...stampEvents(game, next));
                game = next;
            }
            const count = (type: StampEvent["type"]) => of(events, type).length;
            expect(count("hit")).toBe(game.hits);
            expect(count("miss")).toBe(game.missed);
            expect(count("wrong")).toBe(game.mistakes);
            expect(count("perfect")).toBe(game.perfectHits);
            expect(count("guard")).toBe(game.guardedHits);
            expect(count("feverStart")).toBe(game.feverActivations);
            expect(count("bossSpawn")).toBe(1);
            expect(of(events, "kill").filter(event => event.variant === "armored")).toHaveLength(game.armorHits);
            expect(of(events, "wave").map(event => event.index)).toEqual([1, 2, 3, 4]);
            expect(of(events, "urgentSecond").map(event => event.seconds)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
            expect(count("finished")).toBe(1);
        }
    });
});
