import {guardianArtLayers, parseGuardianFitting, type ArtLayer as NamedLayer} from "@mapae/arcade/guardian-art";
import type {Guardian} from "./guardian";
import fittingJson from "../../public/arcade/wardrobe/fit.json?raw";

// Bundle the published metadata in both Vite dev and production; public JSON
// URLs themselves are static responses and cannot be JavaScript module imports.
const fitting = parseGuardianFitting(JSON.parse(fittingJson));

export type ArtLayer = NamedLayer & {src: string};
/** Where a layer's WebP lives: charms and the wardrobe-less zodiac art under /arcade/guardians, the wardrobe pieces under /arcade/wardrobe. */
const layerUrl = (name: string) => `/arcade/${name.startsWith("charm-") || name.endsWith("-768") ? "guardians" : "wardrobe"}/${name}.webp`;
/** One composition shared by SVG, PNG exports and receipts, each layer with its WebP. Coordinates use a 400px canvas. */
export const guardianLayers = (g: Guardian): ArtLayer[] => guardianArtLayers(g, fitting).map(layer => ({...layer, src: layerUrl(layer.name)}));

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
