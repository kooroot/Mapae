import type {Hex} from "viem";
import {GUARDIAN_BACKDROPS, GUARDIAN_CHARMS, GUARDIAN_COLORS, GUARDIAN_HATS, GUARDIAN_OUTFITS, GUARDIAN_SHOES, GUARDIAN_ZODIACS, guardianTraits, type GuardianZodiac} from "./guardians";

/**
 * How a guardian is composed from its layer art, shared by the web's SVG/canvas views and the seller's share card. A layer
 * names its art (`head-dragon`, `hat-satgat`, `charm-mapae`, or `<zodiac>-768` for a wardrobe-less local character); each
 * drawer maps the name to its own copy of the art. Coordinates use a 400px canvas.
 */
export type GuardianHat = typeof GUARDIAN_HATS[number];
export type GuardianOutfit = typeof GUARDIAN_OUTFITS[number];
export type GuardianShoes = typeof GUARDIAN_SHOES[number];
export type GuardianBackdrop = typeof GUARDIAN_BACKDROPS[number];
export type GuardianCharm = typeof GUARDIAN_CHARMS[number];
export type GuardianColor = typeof GUARDIAN_COLORS[number];
export type GuardianLook = {zodiac: GuardianZodiac; charm: GuardianCharm; wardrobe?: {hat: GuardianHat; outfit: GuardianOutfit; shoes: GuardianShoes}};
export type ArtPoint = {x: number; y: number};
export type ArtLayer = {name: string; x: number; y: number; width: number; height: number; clip?: readonly ArtPoint[]; stretch?: boolean};
/**
 * Calibrated data that ships with the artwork in Mapae-arcade-asset (`wardrobe/fit.json`). Hat openings and front edges are
 * measured in normalized source-image coordinates; a head's forehead centre and width are in the composed 400px avatar,
 * excluding ears, horns, mane and comb, which are not the hat's opening size.
 */
export type GuardianFitting = {
    heads: Record<GuardianZodiac, {x: number; y: number; width: number}>;
    hats: Record<Exclude<GuardianHat, "none">, {ratio: number; opening: {x: number; y: number; width: number}; front?: readonly ArtPoint[]}>;
};

export const ZODIAC_NAMES: Record<"ko" | "en", Record<GuardianZodiac, string>> = {
    ko: {rat: "쥐", ox: "소", tiger: "호랑이", rabbit: "토끼", dragon: "용", snake: "뱀", horse: "말", goat: "양", monkey: "원숭이", rooster: "닭", dog: "개", pig: "돼지"},
    en: {rat: "Rat", ox: "Ox", tiger: "Tiger", rabbit: "Rabbit", dragon: "Dragon", snake: "Snake", horse: "Horse", goat: "Goat", monkey: "Monkey", rooster: "Rooster", dog: "Dog", pig: "Pig"},
};
/** The portrait panel's [light, dark] tones per backdrop. */
export const BACKDROP_COLORS: Record<GuardianBackdrop, [string, string]> = {dawn: ["#ead3a5", "#bd785a"], moon: ["#a9abc8", "#43465f"], jade: ["#bbd7b7", "#416c60"], ember: ["#e3a18a", "#733b3d"]};
export const SEAL_COLORS: Record<GuardianColor, string> = {red: "#c7483d", jade: "#347c6e", ink: "#303445"};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const point = (v: unknown): v is ArtPoint => object(v) && finite(v.x) && finite(v.y);
const box = (v: unknown): v is {x: number; y: number; width: number} => object(v) && finite(v.x) && finite(v.y) && finite(v.width) && v.width > 0;
/** A fit.json read from disk or a bundle, checked to hold every head and hat before any layer is placed by it. */
export function parseGuardianFitting(v: unknown): GuardianFitting {
    if (!object(v) || !object(v.heads) || !object(v.hats)) throw new Error("Guardian fitting must hold heads and hats");
    for (const zodiac of GUARDIAN_ZODIACS) if (!box(v.heads[zodiac])) throw new Error(`Guardian fitting lacks the ${zodiac} head`);
    for (const hat of GUARDIAN_HATS) {
        if (hat === "none") continue;
        const art = v.hats[hat];
        if (!object(art) || !finite(art.ratio) || art.ratio <= 0 || !box(art.opening) || art.opening.width <= 0 || (art.front !== undefined && (!Array.isArray(art.front) || art.front.length < 3 || !art.front.every(point))))
            throw new Error(`Guardian fitting lacks the ${hat} hat`);
    }
    return v as GuardianFitting;
}

/** The look a minted guardian's birth seed decodes to: what the NFT image and the share card both draw. */
export function guardianLook(seed: Hex): GuardianLook {
    const t = guardianTraits(seed);
    return {zodiac: t.zodiac, charm: t.charm, wardrobe: {hat: t.hat, outfit: t.outfit, shoes: t.shoes}};
}

/** One composition shared by SVG, canvas, PNG exports and the share card, bottom to top. */
export function guardianArtLayers(g: GuardianLook, fitting: GuardianFitting): ArtLayer[] {
    const w = g.wardrobe;
    const layers: ArtLayer[] = w ? [
        {name: `shoes-${w.shoes}`, x: 124, y: 321, width: 152, height: 59},
        {name: `outfit-${w.outfit}`, x: 89, y: 199, width: 222, height: 151},
    ] : [{name: `${g.zodiac}-768`, x: 8, y: 0, width: 384, height: 384}];
    let front: ArtLayer | undefined;
    if (w && w.hat !== "none") {
        const art = fitting.hats[w.hat], seat = fitting.heads[g.zodiac];
        const width = seat.width / art.opening.width;
        // Keep the opening fitted to the skull when a tall crown reaches the top.
        // Shrinking both axes here would turn wide-headed guardians' hats tiny.
        const height = Math.min(width * art.ratio, (seat.y - 12) / art.opening.y);
        const hat: ArtLayer = {name: `hat-${w.hat}`, x: seat.x - width * art.opening.x, y: seat.y - height * art.opening.y, width, height, stretch: true};
        // The satgat's sloping rim is in front; its hollow underside and cords sit behind the head. A horizontal split would
        // lay the whole underside over the face.
        if (art.front) {
            layers.push(hat);
            front = {...hat, clip: art.front.map(({x, y}) => ({x: hat.x + x * width, y: hat.y + y * height}))};
        } else front = hat;
    }
    if (w) layers.push({name: `head-${g.zodiac}`, x: 84, y: 47, width: 232, height: 190});
    if (front) layers.push(front);
    if (g.charm !== "none") layers.push({name: `charm-${g.charm}`, x: 282, y: 284, width: 98, height: 98});
    return layers;
}
