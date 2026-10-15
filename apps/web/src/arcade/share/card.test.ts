import {expect, test} from "bun:test";
import type {Hex} from "viem";
import type {RankedCard, SeasonCard, SeasonStanding} from "@mapae/arcade/ranking";
import {CARD_HEIGHT, CARD_WIDTH, cardLayers, renderRankedCard, renderSeasonCard, shareLayerPath, type LayerImages} from "./card";
import {parseRankedCard, parseSeasonCard} from "./data";
import {decodePng, encodePng, type Bitmap} from "./png";
import {createBitmap, pixelAt, rgb} from "./raster";

const SEED_A = "0x7a1e9c4d2b6f80135e7c9a2d4f6b8e0c1a3d5f7b9e2c4a6d8f0b1e3c5a7d9f2b" as Hex;
const SEED_B = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const layerDir = new URL("../../../public/arcade/share/", import.meta.url);
const hasArt = await Bun.file(new URL("head-dragon.png", layerDir)).exists();
/** The installed layer art when the asset repository has been copied in, else a stand-in per layer with a transparent border. */
async function images(seed: Hex): Promise<LayerImages> {
    const out = new Map<string, Bitmap>();
    for (const layer of cardLayers(seed)) {
        if (out.has(layer.src)) continue;
        if (hasArt) out.set(layer.src, await decodePng(await Bun.file(new URL(shareLayerPath(layer.src).slice("/arcade/share/".length), layerDir)).bytes()));
        else {
            const stub = createBitmap(64, 64, rgb("#5a8a7a"));
            for (let i = 0; i < stub.data.length; i += 4) {const x = (i / 4) % 64, y = Math.floor(i / 4 / 64); if (x < 8 || y < 8 || x >= 56 || y >= 56) stub.data[i + 3] = 0;}
            out.set(layer.src, stub);
        }
    }
    return out;
}
const season: SeasonStanding = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};
const ranked: RankedCard = {game: "race", day: "2026-10-14", tokenId: "407", seed: SEED_A, score: 12_340, rank: 3, entrants: 41, leader: 15_000, final: false, season};
const closed: SeasonCard = {tokenId: "12", seed: SEED_B, status: {id: 1, start: "2026-10-05", end: "2026-11-01", today: "2026-11-03", phase: "closed"}, season: {...season, rank: 1, today: 0}};
const inkAt = (b: Bitmap, x: number, y: number, color: string) => pixelAt(b, x, y).every((c, i) => c === rgb(color)[i]);
const hasInk = (b: Bitmap, x0: number, y0: number, w: number, h: number, color: string) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inkAt(b, x, y, color)) return true;
    return false;
};
async function save(name: string, b: Bitmap): Promise<void> {
    const dir = process.env.MAPAE_SHARE_CARD_DIR;
    if (dir) await Bun.write(`${dir}/${name}.png`, await encodePng(b));
}

test("share layers map onto the PNG copies and nothing else", () => {
    expect(shareLayerPath("/arcade/wardrobe/hat-satgat.webp")).toBe("/arcade/share/hat-satgat.png");
    expect(shareLayerPath("/arcade/guardians/charm-mapae.webp")).toBe("/arcade/share/charm-mapae.png");
    expect(() => shareLayerPath("/arcade/guardians/dragon-768.webp")).toThrow("No share layer");
    expect(cardLayers(SEED_A).length).toBeGreaterThanOrEqual(3);
});
test("a ranked card paints the frame, the portrait panel and every text block inside the CPU budget", async () => {
    const art = await images(SEED_A), started = performance.now(), b = renderRankedCard(ranked, art), took = performance.now() - started;
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
    const b = renderRankedCard({...ranked, season: null, rank: 1, leader: 12_340, final: true, day: "2026-10-13"}, await images(SEED_A));
    expect(inkAt(b, 596, 446, "#e2b24a")).toBe(true);
    expect(hasInk(b, 600, 492, 528, 24, "#bca788")).toBe(true);
    await save("card-run-final", b);
});
test("a season card draws total points, the podium medal and the run line, open or closed", async () => {
    const art = await images(SEED_B), b = renderSeasonCard(closed, art);
    expect(inkAt(b, 596, 446, "#e2b24a")).toBe(true);
    expect(hasInk(b, 600, 318, 528, 80, "#f2c14e")).toBe(true);
    expect(hasInk(b, 600, 262, 528, 24, "#bca788")).toBe(true);
    await save("card-season-12", b);
    const open = renderSeasonCard({...closed, status: {...closed.status, today: "2026-10-14", phase: "open"}, season}, art);
    expect(inkAt(open, 596, 446, "#c9c9c9")).toBe(true);
    await save("card-season-open", open);
});
test("the card encodes to a PNG that decodes back to the same size", async () => {
    const png = await encodePng(renderRankedCard(ranked, await images(SEED_A)));
    expect(png.length).toBeLessThan(400_000);
    const back = await decodePng(png);
    expect(back.width).toBe(CARD_WIDTH); expect(back.height).toBe(CARD_HEIGHT);
});

test("a ranked card answer is copied only when it echoes the request and holds together", () => {
    const today = "2026-10-14", raw = {...ranked, seed: SEED_A.toUpperCase().replace("0X", "0x")};
    expect(parseRankedCard(raw, "race", "2026-10-14", "407", today)).toEqual(ranked);
    expect(parseRankedCard({...ranked, season: null}, "race", "2026-10-14", "407", today)?.season).toBeNull();
    for (const bad of [
        {...ranked, game: "shop"}, {...ranked, day: "2026-10-13"}, {...ranked, tokenId: "408"}, {...ranked, seed: "0x12"}, {...ranked, score: -1}, {...ranked, score: 1e10},
        {...ranked, rank: 0}, {...ranked, rank: 42}, {...ranked, entrants: 10_001, rank: 10_001}, {...ranked, leader: 12_000}, {...ranked, rank: 1}, {...ranked, leader: 12_340},
        {...ranked, final: true}, {...ranked, season: {...season, points: 5}}, {...ranked, extra: 1}, [], null, "card",
    ]) expect(parseRankedCard(bad, "race", "2026-10-14", "407", today)).toBeNull();
    expect(parseRankedCard({...ranked, day: "2026-10-13", final: true}, "race", "2026-10-13", "407", today)?.final).toBe(true);
    expect(parseRankedCard({...ranked, day: "2026-10-13"}, "race", "2026-10-13", "407", today)).toBeNull();
});
test("a season card answer needs our season in a phase with a board and a standing in it", () => {
    const ours = {id: 1, start: "2026-10-05", end: "2026-11-01"};
    expect(parseSeasonCard(closed, "12", ours)).toEqual(closed);
    for (const bad of [
        {...closed, tokenId: "13"}, {...closed, seed: "nope"}, {...closed, status: {...closed.status, id: 2}}, {...closed, status: {...closed.status, phase: "open"}},
        {...closed, status: {id: 1, start: null, end: null, today: "2026-10-01", phase: "pending"}}, {...closed, season: null}, {...closed, season: {...season, streak: 10}}, {...closed, more: true},
    ]) expect(parseSeasonCard(bad, "12", ours)).toBeNull();
    expect(parseSeasonCard(closed, "12", {id: 2, start: null, end: null})).toBeNull();
});
