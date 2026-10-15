import {resolve} from "node:path";

/** The shop's store, shared by the server and the seed: one file, read by both. */
export function readStorePath(): string {
    return process.env.STORE_PATH?.trim() || "./data/seller.sqlite";
}
/**
 * The share card's art: the asset repository's `arcade/` with `share/*.png` and `wardrobe/fit.json`. The web's public
 * directory by default, where CI and the mini copy the repository; set ARCADE_ART_DIR when it lives elsewhere.
 */
export function readArcadeArtDir(): string {
    return process.env.ARCADE_ART_DIR?.trim() || resolve(import.meta.dir, "../web/public/arcade");
}
