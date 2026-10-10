import {guardianAsset, charmAsset, type Guardian, type Zodiac} from "./guardian";
import {wardrobeAsset, type Hat} from "./wardrobe";
import fittingJson from "../../public/arcade/wardrobe/fit.json?raw";
import type Fitting from "../../public/arcade/wardrobe/fit.json";

// Bundle the published metadata in both Vite dev and production; public JSON
// URLs themselves are static responses and cannot be JavaScript module imports.
const fitting: typeof Fitting = JSON.parse(fittingJson);

type ArtBox = {x: number; y: number; width: number; height: number};
type Point = {x: number; y: number};
export type ArtLayer = ArtBox & {src: string; clip?: readonly Point[]; stretch?: boolean};
// Calibrated data ships with the artwork in Mapae-arcade-asset.
// Openings and front edges are measured in normalized source-image coordinates.
// The satgat's sloping rim is in front; its hollow underside and cords sit behind
// the head. A horizontal split incorrectly lays the entire underside over it.
const HAT_ART: Record<Exclude<Hat, "none">, {ratio: number; opening: {x: number; y: number; width: number}; front?: readonly Point[]}> = fitting.hats;
// Forehead center and width in the composed 400px avatar, excluding ears,
// horns, mane and comb. Those protrusions are not the hat's opening size.
const HEAD_FIT: Record<Zodiac, {x: number; y: number; width: number}> = fitting.heads;
/** One composition shared by SVG, PNG exports and receipts. Coordinates use a 400px canvas. */
export function guardianLayers(g: Guardian): ArtLayer[] {
    const w = g.wardrobe;
    const layers: ArtLayer[] = w ? [
        {src: wardrobeAsset("shoes", w.shoes), x: 124, y: 321, width: 152, height: 59},
        {src: wardrobeAsset("outfit", w.outfit), x: 89, y: 199, width: 222, height: 151},
    ] : [{src: guardianAsset(g.zodiac), x: 8, y: 0, width: 384, height: 384}];
    let front: ArtLayer | undefined;
    if (w && w.hat !== "none") {
        const art = HAT_ART[w.hat], seat = HEAD_FIT[g.zodiac];
        const width = seat.width / art.opening.width;
        // Keep the opening fitted to the skull when a tall crown reaches the top.
        // Shrinking both axes here would turn wide-headed guardians' hats tiny.
        const height = Math.min(width * art.ratio, (seat.y - 12) / art.opening.y);
        const hat: ArtLayer = {src: wardrobeAsset("hat", w.hat), x: seat.x - width * art.opening.x,
            y: seat.y - height * art.opening.y, width, height, stretch: true};
        if (art.front) {
            layers.push(hat);
            front = {...hat, clip: art.front.map(({x, y}) => ({x: hat.x + x * width, y: hat.y + y * height}))};
        } else front = hat;
    }
    if (w) layers.push({src: wardrobeAsset("head", g.zodiac), x: 84, y: 47, width: 232, height: 190});
    if (front) layers.push(front);
    if (g.charm !== "none") layers.push({src: charmAsset(g.charm), x: 282, y: 284, width: 98, height: 98});
    return layers;
}

export async function guardianCanvas(g: Guardian, size = 400): Promise<HTMLCanvasElement> {
    const layers = guardianLayers(g);
    const images = await Promise.all(layers.map(async layer => {const image = new Image(); image.src = layer.src; await image.decode(); return image;}));
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
    context.scale(size / 400, size / 400);
    layers.forEach((layer, i) => {
        const image = images[i]!;
        const scale = Math.min(layer.width / image.naturalWidth, layer.height / image.naturalHeight);
        const width = layer.stretch ? layer.width : image.naturalWidth * scale;
        const height = layer.stretch ? layer.height : image.naturalHeight * scale;
        context.save();
        if (layer.clip) {
            context.beginPath();
            layer.clip.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
            context.closePath(); context.clip();
        }
        context.drawImage(image, layer.x + (layer.width - width) / 2, layer.y + layer.height - height, width, height);
        context.restore();
    });
    return canvas;
}
