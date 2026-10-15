import type {Hex} from "viem";
import {GAME_NAMES} from "@mapae/arcade";
import {BACKDROP_COLORS, SEAL_COLORS, ZODIAC_NAMES} from "@mapae/arcade/guardian-art";
import {guardianName, guardianTraits} from "@mapae/arcade/guardians";
import type {RankedCard, SeasonCard} from "@mapae/arcade/ranking";
import {SEASON} from "@mapae/arcade/season";
import {guardianAppearance} from "../guardian";
import {guardianLayers, type ArtLayer} from "../guardian-layers";
import type {Bitmap} from "./png";
import {GLYPH_HEIGHT, textWidth} from "./pixel-font";
import {createBitmap, drawImage, drawText, fillCircle, fillRoundRect, fitScale, rgb, strokeRoundRect, type Rgb} from "./raster";

/** Bump whenever the layer art or the composition below changes, so cached cards are redrawn. */
export const CARD_REVISION = 1;
export const CARD_WIDTH = 1200, CARD_HEIGHT = 630;
/** The decoded layer PNGs a card needs, keyed by the layer's own (WebP) source path. */
export type LayerImages = ReadonlyMap<string, Bitmap>;

const INK = {bg: rgb("#0e0c0a"), frame: rgb("#efd2b0"), gold: rgb("#e9c99f"), cream: rgb("#faf6e9"), dim: rgb("#bca788"), score: rgb("#f2c14e")};
const MEDALS: Record<number, Rgb> = {1: rgb("#e2b24a"), 2: rgb("#c9c9c9"), 3: rgb("#c7784a")};
/** The text column beside the portrait. */
const COLUMN = {x: 584, width: 544, right: 1128};
/** The 400px guardian canvas lands in the 480px panel. */
const PORTRAIT = {x: 72, y: 75, size: 480, scale: 1.2};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The PNG the Worker composes in place of a wardrobe or charm WebP: the same name under /arcade/share. */
export function shareLayerPath(src: string): string {
    const m = /^\/arcade\/(?:wardrobe|guardians)\/((?:hat|head|outfit|shoes|charm)-[a-z]+)\.webp$/.exec(src);
    if (!m) throw new Error(`No share layer for ${src}`);
    return `/arcade/share/${m[1]}.png`;
}
export const cardLayers = (seed: Hex): ArtLayer[] => guardianLayers(guardianAppearance(seed));

const monthDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
/** Draws one line of the column at `y`, shrinking from `scale` until it fits. */
const line = (b: Bitmap, text: string, y: number, scale: number, color: Rgb, x = COLUMN.x, width = COLUMN.width) => drawText(b, text, x, y, fitScale(text, width, scale), color);

function portrait(b: Bitmap, seed: Hex, images: LayerImages): void {
    const t = guardianTraits(seed), tones = BACKDROP_COLORS[t.backdrop], {x, y, size, scale} = PORTRAIT;
    fillRoundRect(b, x, y, size, size, 28, rgb(tones[1]));
    fillCircle(b, x + 200 * scale, y + 186 * scale, 156 * scale, rgb(tones[0]));
    for (const layer of guardianLayers(guardianAppearance(seed))) {
        const image = images.get(layer.src);
        if (!image) throw new Error(`Missing share layer ${layer.src}`);
        // The same fit as guardianCanvas: meet inside the box, bottom-centred, unless the layer is stretched to its box.
        const fit = Math.min(layer.width / image.width, layer.height / image.height);
        const width = layer.stretch ? layer.width : image.width * fit, height = layer.stretch ? layer.height : image.height * fit;
        const clip = layer.clip?.map(p => ({x: x + p.x * scale, y: y + p.y * scale}));
        drawImage(b, image, x + (layer.x + (layer.width - width) / 2) * scale, y + (layer.y + layer.height - height) * scale, width * scale, height * scale, clip);
    }
    strokeRoundRect(b, x + 10, y + 10, size - 20, size - 20, 26, 4, rgb(SEAL_COLORS[t.color]));
}
/** The chrome every card shares: frame, header, the guardian's name, footer. */
function frame(tokenId: string, seed: Hex, images: LayerImages): Bitmap {
    const b = createBitmap(CARD_WIDTH, CARD_HEIGHT, INK.bg);
    strokeRoundRect(b, 24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48, 20, 1, INK.frame, 0.25);
    portrait(b, seed, images);
    drawText(b, "MAPAE ARCADE", COLUMN.x, 96, 3, INK.gold);
    drawText(b, "@MAPAE_IO", COLUMN.right, 96, 3, INK.dim, "right");
    const name = guardianName(tokenId, "en"), split = name.lastIndexOf(" ");
    line(b, name.slice(0, split), 140, 4, INK.gold);
    line(b, name.slice(split + 1), 184, 6, INK.cream);
    drawText(b, "MAPAE.IO/ARCADE", PORTRAIT.x, 572, 3, INK.dim);
    drawText(b, "GIWA SEPOLIA · TESTNET", COLUMN.right, 572 + GLYPH_HEIGHT, 2, INK.dim, "right");
    return b;
}
/** The big number with its unit on the same baseline. */
function scoreBlock(b: Bitmap, value: number, unit: string): void {
    const text = value.toLocaleString("en"), unitScale = 4, scale = fitScale(text, COLUMN.width - 20 - textWidth(unit, unitScale), 10);
    const width = drawText(b, text, COLUMN.x, 318, scale, INK.score);
    drawText(b, unit, COLUMN.x + width + 20, 318 + GLYPH_HEIGHT * (scale - unitScale), unitScale, INK.dim);
}
/** The place line, with a medal block before it for the podium. */
function placeLine(b: Bitmap, rank: number, text: string): void {
    const medal = MEDALS[rank];
    if (medal) fillRoundRect(b, COLUMN.x, 434, 24, 24, 6, medal);
    line(b, text, 430, 4, INK.gold, medal ? COLUMN.x + 36 : COLUMN.x, medal ? COLUMN.width - 36 : COLUMN.width);
}

/** A ranked round's card: the game, today's (or that day's) score and place, then the season total or the guardian's own flavour. */
export function renderRankedCard(card: RankedCard, images: LayerImages): Bitmap {
    const b = frame(card.tokenId, card.seed, images), t = guardianTraits(card.seed);
    line(b, `${GAME_NAMES.en[card.game]} · RANKED`, 262, 3, INK.dim);
    scoreBlock(b, card.score, "PTS");
    placeLine(b, card.rank, `#${card.rank} OF ${card.entrants} · ${card.final ? monthDay(card.day) : "TODAY"}`);
    line(b, card.season ? `SEASON ${SEASON.id} · ${card.season.points.toLocaleString("en")} PTS · #${card.season.rank}/${card.season.entrants}`
        : `${ZODIAC_NAMES.en[t.zodiac]} · ${t.charm === "none" ? "NO CHARM" : `CHARM: ${t.charm}`} · ${t.temperament}`, 492, 3, INK.dim);
    return b;
}
/** A season standing's card: the season and its dates, total points and place, days played, the run and its bonus. */
export function renderSeasonCard(card: SeasonCard, images: LayerImages): Bitmap {
    const b = frame(card.tokenId, card.seed, images), {status, season} = card;
    line(b, `SEASON ${status.id}${status.phase === "closed" ? " FINAL" : ""} · ${monthDay(status.start!)} - ${monthDay(status.end!)}`, 262, 3, INK.dim);
    scoreBlock(b, season.points, "SEASON PTS");
    placeLine(b, season.rank, `#${season.rank} OF ${season.entrants} · ${season.days} ${season.days === 1 ? "DAY" : "DAYS"}`);
    line(b, `${season.streak}-DAY RUN · BONUS +${season.bonus}`, 492, 3, INK.dim);
    return b;
}
