import {guardianAsset, charmAsset, type Guardian, type Zodiac} from "./guardian";
import {wardrobeAsset, type Hat} from "./wardrobe";

type ArtBox = {x: number; y: number; width: number; height: number};
export type ArtLayer = ArtBox & {src: string; clip?: ArtBox};
// Contact is the opening against the forehead, not the image's bottom tassel.
const HAT_ART: Record<Exclude<Hat, "none">, {width: number; ratio: number; contact: number; front: number}> = {
    topknot: {width: 150, ratio: 512 / 504, contact: .74, front: .82},
    gat: {width: 185, ratio: 345 / 512, contact: .92, front: 1},
    satgat: {width: 218, ratio: 418 / 512, contact: .66, front: .67},
    samo: {width: 225, ratio: 273 / 512, contact: .84, front: 1},
    ikseongwan: {width: 118, ratio: 512 / 428, contact: .81, front: 1},
    jeonrip: {width: 172, ratio: 484 / 512, contact: .77, front: .79},
    paeraengi: {width: 200, ratio: 425 / 512, contact: .67, front: .69},
    headwrap: {width: 180, ratio: 421 / 512, contact: .49, front: .59},
};
const HEAD_SEAT: Record<Zodiac, {x: number; y: number; scale: number}> = {
    rat: {x: 200, y: 128, scale: .96}, ox: {x: 201, y: 125, scale: .98},
    tiger: {x: 207, y: 125, scale: .98}, rabbit: {x: 207, y: 153, scale: .82},
    dragon: {x: 200, y: 113, scale: .91}, snake: {x: 207, y: 99, scale: .8},
    horse: {x: 203, y: 127, scale: .95}, goat: {x: 206, y: 130, scale: 1},
    monkey: {x: 202, y: 135, scale: .95}, rooster: {x: 207, y: 143, scale: .82},
    dog: {x: 204, y: 130, scale: .92}, pig: {x: 204, y: 130, scale: .97},
};
/** One composition shared by SVG, PNG exports and receipts. Coordinates use a 400px canvas. */
export function guardianLayers(g: Guardian): ArtLayer[] {
    const w = g.wardrobe;
    const layers: ArtLayer[] = w ? [
        {src: wardrobeAsset("shoes", w.shoes), x: 124, y: 321, width: 152, height: 59},
        {src: wardrobeAsset("outfit", w.outfit), x: 89, y: 199, width: 222, height: 151},
    ] : [{src: guardianAsset(g.zodiac), x: 8, y: 0, width: 384, height: 384}];
    let front: ArtLayer | undefined;
    if (w && w.hat !== "none") {
        const art = HAT_ART[w.hat], seat = HEAD_SEAT[g.zodiac];
        const scale = Math.min(seat.scale, (seat.y - 12) / (art.width * art.ratio * art.contact));
        const width = art.width * scale, height = width * art.ratio;
        const hat = {src: wardrobeAsset("hat", w.hat), x: seat.x - width / 2, y: seat.y - height * art.contact, width, height};
        if (art.front < 1) {
            const cut = height * art.front;
            layers.push({...hat, clip: {x: hat.x, y: hat.y + cut, width, height: height - cut}});
            front = {...hat, clip: {x: hat.x, y: hat.y, width, height: cut}};
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
        const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        context.save();
        if (layer.clip) {context.beginPath(); context.rect(layer.clip.x, layer.clip.y, layer.clip.width, layer.clip.height); context.clip();}
        context.drawImage(image, layer.x + (layer.width - width) / 2, layer.y + layer.height - height, width, height);
        context.restore();
    });
    return canvas;
}
