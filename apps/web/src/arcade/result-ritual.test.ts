import {describe, expect, test} from "bun:test";
import {LIGHT_MS} from "./juice";
import {owedCue, ritualEnd, ritualPlan} from "./result-ritual";

const dur = {tap: 90, quick: 160, base: 240, slow: 420, ceremony: 900};

describe("ritualPlan", () => {
    test("a player's ritual prints, counts, then seals with its thump and a 2px shake on the impact", () => {
        const plan = ritualPlan("full", {record: false, stats: 4}, dur);
        expect(plan.paper).toBe(360);
        expect(plan.count).toEqual({at: 180, ms: 900});
        expect(plan.seal).toEqual({at: 1100, ms: 300});
        expect(plan.shake).toBe(1220);
        expect(plan.sounds).toEqual([{kind: "end", at: 0}, {kind: "seal", at: 1220}]);
        expect(plan.record).toBeNull();
    });
    test("stats follow the seal 60ms apart and turning points follow the stats 80ms apart", () => {
        const plan = ritualPlan("full", {record: false, stats: 4}, dur);
        expect(plan.stats).toEqual({start: 1220, step: 60});
        expect(plan.points).toEqual({start: 1460, step: 80});
    });
    test("a new record adds the brush underline and its fanfare once the seal has landed", () => {
        const plan = ritualPlan("full", {record: true, stats: 0}, dur);
        expect(plan.record).toEqual({at: 1400, ms: 420});
        expect(plan.sounds.at(-1)).toEqual({kind: "record", at: 1400});
    });
    test("the whole player ritual lands in about 1.4s", () => {
        const plan = ritualPlan("full", {record: true, stats: 4}, dur);
        expect(ritualEnd(plan, "full", {stats: 4, points: 0}, dur)).toBeLessThanOrEqual(1900);
        expect(ritualEnd(ritualPlan("full", {record: false, stats: 0}, dur), "full", {stats: 0, points: 0}, dur)).toBe(1400);
    });
    test("a watched agent's result settles within LIGHT_MS and never shakes", () => {
        for (const record of [false, true]) {
            const plan = ritualPlan("light", {record, stats: 4}, dur);
            expect(plan.shake).toBeNull();
            expect(ritualEnd(plan, "light", {stats: 4, points: 3}, dur)).toBeLessThanOrEqual(LIGHT_MS);
        }
    });
    test("reduced motion keeps no seal, count or underline motion, only the bell", () => {
        const plan = ritualPlan("still", {record: true, stats: 4}, dur);
        expect([plan.seal, plan.shake, plan.record]).toEqual([null, null, null]);
        expect(plan.sounds).toEqual([{kind: "record", at: 0}]);
        expect(ritualEnd(plan, "still", {stats: 4, points: 3}, dur)).toBeLessThanOrEqual(dur.base);
    });
    test("the end bell rings once, unless a short ritual gives its one cue to the record fanfare", () => {
        for (const tier of ["full", "light", "still"] as const) for (const record of [false, true])
            expect(ritualPlan(tier, {record, stats: 2}, dur).sounds.filter(cue => cue.kind === "end").length).toBe(record && tier !== "full" ? 0 : 1);
    });
});

describe("owedCue", () => {
    const sounds = ritualPlan("full", {record: true, stats: 4}, dur).sounds;
    test("a skip before the seal lands owes only the last cue, not a pile", () => expect(owedCue(sounds, 300)).toBe("record"));
    test("a skip after the seal owes the fanfare still to come", () => expect(owedCue(sounds, 1300)).toBe("record"));
    test("nothing is owed once every cue has played", () => expect(owedCue(sounds, 1500)).toBeNull());
});
