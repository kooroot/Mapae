import {expect, test} from "bun:test";
import type {Hex} from "viem";
import {GUARDIAN_HATS, GUARDIAN_ZODIACS} from "../guardians";
import {parseGuardianFitting, type GuardianFitting} from "../guardian-art";
import type {RankedCard, SeasonCard, SeasonStanding} from "../ranking";
import {renderRankedCard, renderSeasonCard, SHARE_LAYER_NAMES, type ShareCardArt} from "./card";
import {CARD_HEIGHT, CARD_WIDTH} from "./contract";
import {decodePng, encodePng, type Bitmap} from "./png";
import {createBitmap, pixelAt, rgb} from "./raster";

const SEED_A = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const SEED_B = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const artDir = new URL("../../../../apps/web/public/arcade/", import.meta.url);
const hasArt = await Bun.file(new URL("share/head-dragon.png", artDir)).exists();
/** The installed layer art and fit when the asset repository has been copied in, else a stand-in per layer with a transparent border and one seat for every hat. */
const art: ShareCardArt = hasArt ? {
    fitting: parseGuardianFitting(await Bun.file(new URL("wardrobe/fit.json", artDir)).json()),
    images: new Map(await Promise.all(SHARE_LAYER_NAMES.map(async name => [name, await decodePng(await Bun.file(new URL(`share/${name}.png`, artDir)).bytes())] as const))),
} : {
    fitting: {
        heads: Object.fromEntries(GUARDIAN_ZODIACS.map(z => [z, {x: 200, y: 115, width: 110}])) as GuardianFitting["heads"],
        hats: Object.fromEntries(GUARDIAN_HATS.filter(h => h !== "none").map(h => [h, {ratio: 1, opening: {x: .5, y: .7, width: .9}}])) as GuardianFitting["hats"],
    },
    images: new Map(SHARE_LAYER_NAMES.map(name => {
        const stub = createBitmap(64, 64, rgb("#5a8a7a"));
        for (let i = 0; i < stub.data.length; i += 4) {const x = (i / 4) % 64, y = Math.floor(i / 4 / 64); if (x < 8 || y < 8 || x >= 56 || y >= 56) stub.data[i + 3] = 0;}
        return [name, stub];
    })),
};
const season: SeasonStanding = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};
const ranked: RankedCard = {game: "race", day: "2026-10-14", tokenId: "407", seed: SEED_A, score: 12_340, rank: 3, entrants: 41, leader: 15_000, final: false, season};
const closed: SeasonCard = {tokenId: "12", seed: SEED_B, status: {id: 1, start: "2026-10-05", end: "2026-11-01", today: "2026-11-03", phase: "closed"}, season: {...season, rank: 1, today: 0}, marks: []};
const inkAt = (b: Bitmap, x: number, y: number, color: string) => pixelAt(b, x, y).every((c, i) => c === rgb(color)[i]);
const hasInk = (b: Bitmap, x0: number, y0: number, w: number, h: number, color: string) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inkAt(b, x, y, color)) return true;
    return false;
};
async function save(name: string, b: Bitmap): Promise<void> {
    const dir = process.env.MAPAE_SHARE_CARD_DIR;
    if (dir) await Bun.write(`${dir}/${name}.png`, await encodePng(b));
}

test("the layer set is the 36 share PNGs, and a card without one of its layers is refused", () => {
    expect(SHARE_LAYER_NAMES).toHaveLength(36); expect(new Set(SHARE_LAYER_NAMES).size).toBe(36);
    expect(SHARE_LAYER_NAMES).toContain("head-dragon"); expect(SHARE_LAYER_NAMES).toContain("hat-satgat"); expect(SHARE_LAYER_NAMES).toContain("charm-mapae");
    expect(SHARE_LAYER_NAMES.some(name => name.endsWith("-none") || name.endsWith("-768"))).toBe(false);
    expect(() => renderRankedCard(ranked, {...art, images: new Map()})).toThrow("Missing share layer");
});
test("a ranked card paints the frame, the portrait panel and every text block inside the CPU budget", async () => {
    const started = performance.now(), b = renderRankedCard(ranked, art), took = performance.now() - started;
    expect(b.width).toBe(CARD_WIDTH); expect(b.height).toBe(CARD_HEIGHT);
    expect(inkAt(b, 10, 10, "#0e0c0a")).toBe(true);
    expect(inkAt(b, 100, 520, "#bd785a") || inkAt(b, 100, 520, "#43465f") || inkAt(b, 100, 520, "#416c60") || inkAt(b, 100, 520, "#733b3d")).toBe(true);
    expect(hasInk(b, 600, 96, 528, 24, "#e9c99f")).toBe(true); // MAPAE ARCADE
    expect(hasInk(b, 600, 184, 528, 48, "#faf6e9")).toBe(true); // given name
    expect(hasInk(b, 600, 318, 528, 80, "#f2c14e")).toBe(true); // score
    expect(inkAt(b, 596, 446, "#c7784a")).toBe(true); // bronze medal block
    expect(hasInk(b, 600, 492, 528, 24, "#bca788")).toBe(true); // season line
    expect(hasInk(b, 72, 572, 300, 24, "#bca788")).toBe(true); // footer
    expect(took).toBeLessThan(hasArt ? 120 : 60);
    await save("card-run-407", b);
});
test("a round without a season standing shows the guardian's flavour, a past day its date and a leader gold", async () => {
    const b = renderRankedCard({...ranked, season: null, rank: 1, leader: 12_340, final: true, day: "2026-10-13"}, art);
    expect(inkAt(b, 596, 446, "#e2b24a")).toBe(true);
    expect(hasInk(b, 600, 492, 528, 24, "#bca788")).toBe(true);
    await save("card-run-final", b);
});
test("a season card draws total points, the podium medal and the run line, open or closed", async () => {
    const b = renderSeasonCard(closed, art);
    expect(inkAt(b, 596, 446, "#e2b24a")).toBe(true);
    expect(hasInk(b, 600, 318, 528, 80, "#f2c14e")).toBe(true);
    expect(hasInk(b, 600, 262, 528, 24, "#bca788")).toBe(true);
    await save("card-season-12", b);
    const open = renderSeasonCard({...closed, status: {...closed.status, today: "2026-10-14", phase: "open"}, season}, art);
    expect(inkAt(open, 596, 446, "#c9c9c9")).toBe(true);
    await save("card-season-open", open);
});
test("the card encodes to a PNG that decodes back to the same size", async () => {
    const png = await encodePng(renderRankedCard(ranked, art));
    expect(png.length).toBeLessThan(400_000);
    const back = await decodePng(png);
    expect(back.width).toBe(CARD_WIDTH); expect(back.height).toBe(CARD_HEIGHT);
});
