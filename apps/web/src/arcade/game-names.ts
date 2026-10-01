import type {GameId} from "@mapae/arcade";
import type {Locale} from "../lib/i18n";

export const GAME_NAMES: Record<Locale, Record<GameId, string>> = {
    ko: {race: "달려라 마패", shop: "흥정상회", stamp: "도깨비 도장찍기"},
    en: {race: "Auto Race", shop: "Tiny Shop", stamp: "Dokkaebi Stamp"},
};
