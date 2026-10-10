import {describe, expect, test} from "bun:test";
import {bannerBeats, ceremonyMs, gateTier, opacityOnly, parseTime, shakeFrames, LIGHT_MS} from "./juice";

const dur = {tap: 90, quick: 160, base: 240, slow: 420, ceremony: 900};

describe("gateTier", () => {
    test("a game passes its tier through", () => expect(gateTier({tier: "light"})).toBe("light"));
    test("a shell's still flag maps to still or full", () => {
        expect(gateTier({still: true})).toBe("still");
        expect(gateTier({still: false, essential: true})).toBe("full");
    });
});

describe("parseTime", () => {
    test("reads milliseconds and seconds", () => {
        expect(parseTime("90ms")).toBe(90);
        expect(parseTime(" .42s ")).toBe(420);
    });
    test("an unset or broken token is zero, never NaN", () => {
        expect(parseTime("")).toBe(0);
        expect(parseTime("fast")).toBe(0);
        expect(parseTime("-5ms")).toBe(0);
    });
});

describe("opacityOnly", () => {
    test("keeps the fade at the offsets WAAPI would have used and drops the movement", () => {
        expect(opacityOnly([{opacity: 0, scale: 1.9}, {opacity: 1, scale: .92, offset: .4}, {scale: 1.04}, {scale: 1}, {opacity: 1, scale: 1}])).toEqual([{opacity: 0, offset: 0}, {opacity: 1, offset: .4}, {opacity: 1, offset: 1}]);
    });
    test("spreads unset middle offsets evenly", () => {
        expect(opacityOnly([{opacity: 1}, {opacity: .5}, {opacity: .2}, {opacity: 0}])).toEqual([{opacity: 1, offset: 0}, {opacity: .5, offset: 1 / 3}, {opacity: .2, offset: 2 / 3}, {opacity: 0, offset: 1}]);
    });
    test("property-indexed effects keep only their opacity track", () => {
        expect(opacityOnly({opacity: [0, 1], translate: ["0 8px", "0 0"]})).toEqual({opacity: [0, 1]});
        expect(opacityOnly({opacity: [1, 0], offset: [0, 1], scale: [1, 2]})).toEqual({opacity: [1, 0], offset: [0, 1]});
    });
    test("pure movement has no fade to keep", () => {
        expect(opacityOnly([{translate: "0 0"}, {translate: "0 -12px"}])).toBeNull();
        expect(opacityOnly({rotate: ["0deg", "8deg"]})).toBeNull();
    });
});

describe("shakeFrames", () => {
    test("never reaches past 6px, starts and ends at rest", () => {
        const frames = shakeFrames(20, "x");
        expect(frames[0]).toEqual({transform: "translateX(0px)"});
        expect(frames.at(-1)).toEqual({transform: "translateX(0px)"});
        expect(frames.map(f => Math.abs(Number(/(-?[\d.]+)px/.exec(String(f.transform))![1])))).toSatisfy(xs => Math.max(...xs) === 6);
    });
    test("shakes along the requested axis", () => expect(shakeFrames(4, "y")[1]).toEqual({transform: "translateY(-4px)"}));
});

describe("bannerBeats", () => {
    test("a player sees the full unfurl, hold and exit", () => expect(bannerBeats("full", dur)).toEqual({unfurl: 240, hold: 900, exit: 240}));
    test("a watched agent's banner fits the 300ms ceremony budget", () => {
        const {unfurl, hold, exit} = bannerBeats("light", dur);
        expect(unfurl + hold + exit).toBeLessThanOrEqual(300);
        expect(hold).toBeGreaterThan(0);
    });
});

describe("ceremonyMs", () => {
    test("a watched agent's ceremony is clipped to LIGHT_MS, inside its 2× auto-advance beat", () => {
        expect(LIGHT_MS).toBeLessThan(1050 / 2);
        expect(ceremonyMs("light", 420)).toBe(LIGHT_MS);
        expect(ceremonyMs("light", 160)).toBe(160);
    });
    test("a player and reduced motion keep the authored length", () => {
        expect(ceremonyMs("full", 420)).toBe(420);
        expect(ceremonyMs("still", 420)).toBe(420);
    });
});
