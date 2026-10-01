export const HATS = ["none", "topknot", "gat", "satgat", "samo", "ikseongwan", "jeonrip", "paeraengi", "headwrap"] as const;
export const OUTFITS = ["gonryongpo", "minister", "official", "military", "scholar", "artisan", "hemp", "performer"] as const;
export const SHOES = ["jipsin", "namaksin", "taesahye", "heukhwa", "beoseon"] as const;
export type Hat = typeof HATS[number];
export type Outfit = typeof OUTFITS[number];
export type Shoes = typeof SHOES[number];
export type Wardrobe = {hat: Hat; outfit: Outfit; shoes: Shoes};
export type WardrobeGroup = "royal" | "yangban" | "jungin" | "sangmin" | "cheonin";
type Label = {ko: string; en: string};
export const HAT_NAMES: Record<Hat, Label> = {
    none: {ko: "모자 없이", en: "No hat"}, topknot: {ko: "상투 · 망건", en: "Topknot & headband"},
    gat: {ko: "갓", en: "Gat"}, satgat: {ko: "삿갓", en: "Straw rain hat"}, samo: {ko: "사모", en: "Official's samo"},
    ikseongwan: {ko: "익선관", en: "Royal ikseongwan"}, jeonrip: {ko: "전립", en: "Military jeonrip"},
    paeraengi: {ko: "패랭이", en: "Bamboo paeraengi"}, headwrap: {ko: "머릿수건", en: "Cloth head wrap"},
};
export const OUTFIT_NAMES: Record<Outfit, Label> = {
    gonryongpo: {ko: "곤룡포", en: "Royal dragon robe"}, minister: {ko: "자주 단령", en: "Wine court robe"},
    official: {ko: "청색 단령", en: "Blue court robe"}, military: {ko: "철릭 · 전복", en: "Military coat"},
    scholar: {ko: "선비 도포", en: "Scholar's dopo"}, artisan: {ko: "남빛 실무복", en: "Indigo work coat"},
    hemp: {ko: "삼베 저고리", en: "Hemp jeogori"}, performer: {ko: "재주꾼 색동옷", en: "Performer's patchwork"},
};
export const SHOE_NAMES: Record<Shoes, Label> = {
    jipsin: {ko: "짚신", en: "Straw sandals"}, namaksin: {ko: "나막신", en: "Wooden clogs"},
    taesahye: {ko: "태사혜", en: "Scholar's shoes"}, heukhwa: {ko: "흑화", en: "Official's boots"}, beoseon: {ko: "버선", en: "Cloth socks"},
};
export const WARDROBE_GROUPS: Record<WardrobeGroup, Label> = {
    royal: {ko: "왕실", en: "Royal"}, yangban: {ko: "양반", en: "Yangban"}, jungin: {ko: "중인", en: "Jungin"},
    sangmin: {ko: "상민", en: "Sangmin"}, cheonin: {ko: "천인", en: "Cheonin"},
};
export const WARDROBE_PRESETS: readonly {id: string; group: WardrobeGroup; name: Label; clothes: Wardrobe}[] = [
    {id: "king", group: "royal", name: {ko: "임금님", en: "King"}, clothes: {hat: "ikseongwan", outfit: "gonryongpo", shoes: "heukhwa"}},
    {id: "minister", group: "yangban", name: {ko: "영의정", en: "Chief minister"}, clothes: {hat: "samo", outfit: "minister", shoes: "heukhwa"}},
    {id: "official", group: "yangban", name: {ko: "문관", en: "Civil official"}, clothes: {hat: "samo", outfit: "official", shoes: "heukhwa"}},
    {id: "military", group: "yangban", name: {ko: "무관", en: "Military officer"}, clothes: {hat: "jeonrip", outfit: "military", shoes: "heukhwa"}},
    {id: "scholar", group: "yangban", name: {ko: "선비", en: "Scholar"}, clothes: {hat: "gat", outfit: "scholar", shoes: "taesahye"}},
    {id: "physician", group: "jungin", name: {ko: "의원", en: "Physician"}, clothes: {hat: "topknot", outfit: "artisan", shoes: "beoseon"}},
    {id: "merchant", group: "sangmin", name: {ko: "장터꾼", en: "Market trader"}, clothes: {hat: "paeraengi", outfit: "hemp", shoes: "jipsin"}},
    {id: "traveler", group: "sangmin", name: {ko: "나그네", en: "Wanderer"}, clothes: {hat: "satgat", outfit: "hemp", shoes: "namaksin"}},
    {id: "worker", group: "cheonin", name: {ko: "일꾼", en: "Worker"}, clothes: {hat: "none", outfit: "hemp", shoes: "jipsin"}},
    {id: "performer", group: "cheonin", name: {ko: "재주꾼", en: "Performer"}, clothes: {hat: "headwrap", outfit: "performer", shoes: "taesahye"}},
];
export const wardrobeAsset = (kind: "head" | "hat" | "outfit" | "shoes", item: string) => `/arcade/wardrobe/${kind}-${item}.webp`;
export function validWardrobe(value: unknown): value is Wardrobe {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const w = value as Record<string, unknown>;
    return HATS.some(x => x === w.hat) && OUTFITS.some(x => x === w.outfit) && SHOES.some(x => x === w.shoes);
}
export function projectWardrobe(w: Wardrobe): Wardrobe {return {hat: w.hat, outfit: w.outfit, shoes: w.shoes};}
export function wardrobeName(w: Wardrobe | undefined, locale: "ko" | "en"): string {
    if (!w) return locale === "ko" ? "마패 전령" : "Mapae courier";
    const preset = WARDROBE_PRESETS.find(p => p.clothes.hat === w.hat && p.clothes.outfit === w.outfit && p.clothes.shoes === w.shoes);
    return preset?.name[locale] ?? (locale === "ko" ? "내 멋대로 차림" : "Your own mix");
}
