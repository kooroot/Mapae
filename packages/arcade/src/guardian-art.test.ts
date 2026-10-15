import {expect, test} from "bun:test";
import type {Hex} from "viem";
import {GUARDIAN_HATS, GUARDIAN_ZODIACS} from "./guardians";
import {guardianArtLayers, guardianLook, parseGuardianFitting, type GuardianFitting, type GuardianLook} from "./guardian-art";

const fitFile = Bun.file(new URL("../../../apps/web/public/arcade/wardrobe/fit.json", import.meta.url));
/** The calibrated fit when the asset repository has been copied in, else one that seats every hat the same way. */
const fitting: GuardianFitting = await fitFile.exists() ? parseGuardianFitting(await fitFile.json()) : {
    heads: Object.fromEntries(GUARDIAN_ZODIACS.map(z => [z, {x: 200, y: 115, width: 110}])) as GuardianFitting["heads"],
    hats: Object.fromEntries(GUARDIAN_HATS.filter(h => h !== "none").map(h => [h, {ratio: 1, opening: {x: .5, y: .7, width: .9},
        ...(h === "satgat" ? {front: [{x: 0, y: .6}, {x: .5, y: .5}, {x: 1, y: .8}, {x: 1, y: 1}, {x: 0, y: 1}]} : {})}])) as GuardianFitting["hats"],
};
const SEED = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const look: GuardianLook = {zodiac: "dragon", charm: "mapae", wardrobe: {hat: "gat", outfit: "scholar", shoes: "taesahye"}};

test("layers stack shoes, outfit, hat, head, hat front and charm inside the 400px canvas, by art name", () => {
    expect(guardianArtLayers(look, fitting).map(l => l.name)).toEqual(["shoes-taesahye", "outfit-scholar", "head-dragon", "hat-gat", "charm-mapae"]);
    expect(guardianArtLayers({...look, charm: "none", wardrobe: {...look.wardrobe!, hat: "none"}}, fitting).map(l => l.name)).toEqual(["shoes-taesahye", "outfit-scholar", "head-dragon"]);
    expect(guardianArtLayers({zodiac: "ox", charm: "pouch"}, fitting).map(l => l.name)).toEqual(["ox-768", "charm-pouch"]);
    for (const zodiac of GUARDIAN_ZODIACS) for (const hat of GUARDIAN_HATS) for (const layer of guardianArtLayers({...look, zodiac, wardrobe: {...look.wardrobe!, hat}}, fitting))
        expect(layer.x >= 0 && layer.y >= 0 && layer.x + layer.width <= 400 && layer.y + layer.height <= 400).toBe(true);
});
test("the satgat's cords go behind the head and its rim in front, clipped along the sloping front edge", () => {
    const layers = guardianArtLayers({...look, wardrobe: {...look.wardrobe!, hat: "satgat"}}, fitting);
    expect(layers.map(l => l.name)).toEqual(["shoes-taesahye", "outfit-scholar", "hat-satgat", "head-dragon", "hat-satgat", "charm-mapae"]);
    const [back, front] = [layers[2]!, layers[4]!];
    expect(back.clip).toBeUndefined(); expect(back.stretch).toBe(true);
    expect(front.clip!.length).toBeGreaterThanOrEqual(3);
    expect(front.clip!.every(p => p.x >= front.x - .001 && p.x <= front.x + front.width + .001 && p.y >= front.y - .001 && p.y <= front.y + front.height + .001)).toBe(true);
    // A high forehead must not shrink the hat's width along with its height: the opening follows the skull's width.
    const on = (zodiac: "snake" | "rabbit") => guardianArtLayers({...look, zodiac, wardrobe: {...look.wardrobe!, hat: "gat"}}, fitting).find(l => l.name === "hat-gat")!;
    expect(on("snake").width / on("rabbit").width).toBeCloseTo(fitting.heads.snake.width / fitting.heads.rabbit.width, 5);
});
test("a seed's look is its traits, and a fitting is refused unless every head and hat is measured", () => {
    expect(guardianLook(SEED)).toEqual({zodiac: expect.any(String), charm: expect.any(String), wardrobe: {hat: expect.any(String), outfit: expect.any(String), shoes: expect.any(String)}});
    expect(parseGuardianFitting(JSON.parse(JSON.stringify(fitting)))).toEqual(fitting);
    const without = (edit: (f: GuardianFitting) => void) => {const f = structuredClone(fitting) as GuardianFitting; edit(f); return f;};
    for (const bad of [null, [], {}, {heads: fitting.heads}, without(f => delete (f.heads as Partial<GuardianFitting["heads"]>).pig), without(f => delete (f.hats as Partial<GuardianFitting["hats"]>).gat),
        without(f => {f.heads.rat = {x: 1, y: 2, width: 0};}), without(f => {f.hats.gat.ratio = 0;}), without(f => {f.hats.satgat.front = [{x: 0, y: 0}];}), without(f => {f.hats.gat.opening = {x: Number.NaN, y: 1, width: 1};})])
        expect(() => parseGuardianFitting(bad)).toThrow("Guardian fitting");
});
