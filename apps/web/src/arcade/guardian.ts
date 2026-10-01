import type {Companion, Color, Temperament} from "./state";
import type {AgentGoal} from "@mapae/arcade";
import {HATS, OUTFITS, SHOES, WARDROBE_PRESETS, validWardrobe, projectWardrobe, type Wardrobe} from "./wardrobe";

export const ZODIACS = ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"] as const;
export const BACKDROPS = ["dawn", "moon", "jade", "ember"] as const;
export const CHARMS = ["mapae", "scroll", "pouch", "none"] as const;
export type Zodiac = typeof ZODIACS[number];
export type Backdrop = typeof BACKDROPS[number];
export type Charm = typeof CHARMS[number];
export type Guardian = {version: 1; seed: string; zodiac: Zodiac; backdrop: Backdrop; charm: Charm; wardrobe?: Wardrobe};
export const ROLL_FIELDS = ["zodiac", "hat", "outfit", "shoes", "backdrop", "charm", "color", "temperament", "goal"] as const;
export type RollLock = typeof ROLL_FIELDS[number];
export const GUARDIAN_NAMES = {
    ko: {rat: "쥐", ox: "소", tiger: "호랑이", rabbit: "토끼", dragon: "용", snake: "뱀", horse: "말", goat: "양", monkey: "원숭이", rooster: "닭", dog: "개", pig: "돼지"},
    en: {rat: "Rat", ox: "Ox", tiger: "Tiger", rabbit: "Rabbit", dragon: "Dragon", snake: "Snake", horse: "Horse", goat: "Goat", monkey: "Monkey", rooster: "Rooster", dog: "Dog", pig: "Pig"},
};
export const GUARDIAN_STORIES: Record<Zodiac, {ko: string; en: string}> = {
    rat: {ko: "작은 틈에서 기회를 찾는 골목길 전령", en: "A nimble messenger with an eye for opportunity"},
    ox: {ko: "맡은 일을 끝까지 해내는 든든한 길잡이", en: "A steady guide who always finishes the journey"},
    tiger: {ko: "기세 좋게 앞장서는 산골 수호대장", en: "A spirited guardian of the mountain paths"},
    rabbit: {ko: "사뿐한 발걸음으로 소식을 전하는 달빛 사신", en: "A moonlit courier with the lightest footsteps"},
    dragon: {ko: "구름 너머 새 길을 꿈꾸는 꼬마 용", en: "A little dragon dreaming beyond the clouds"},
    snake: {ko: "한 번 더 살펴보고 움직이는 조용한 책사", en: "A quiet strategist who looks before leaping"},
    horse: {ko: "마패를 품고 먼 길도 달려가는 역참 전령", en: "The Mapae courier who goes the extra mile"},
    goat: {ko: "친구의 보폭에 맞춰 걷는 다정한 동행", en: "A gentle companion who matches your stride"},
    monkey: {ko: "어려운 일도 놀이로 푸는 재주꾼", en: "A clever tinkerer who makes a game of everything"},
    rooster: {ko: "새벽부터 장터를 깨우는 부지런한 파수꾼", en: "The early lookout who wakes the marketplace"},
    dog: {ko: "약속한 자리를 지키는 믿음직한 벗", en: "A loyal friend who always keeps a promise"},
    pig: {ko: "작은 즐거움을 모으는 복스러운 장터 친구", en: "A cheerful friend collecting life's little joys"},
};
export const BACKDROP_COLORS: Record<Backdrop, [string, string]> = {dawn: ["#ead3a5", "#bd785a"], moon: ["#a9abc8", "#43465f"], jade: ["#bbd7b7", "#416c60"], ember: ["#e3a18a", "#733b3d"]};
export const SEAL_COLORS: Record<Color, string> = {red: "#c7483d", jade: "#347c6e", ink: "#303445"};
export const guardianAsset = (zodiac: Zodiac, size: 256 | 768 = 768) => `/arcade/guardians/${zodiac}-${size}.webp`;
export const charmAsset = (charm: Exclude<Charm, "none">) => `/arcade/guardians/charm-${charm}.webp`;

export function validGuardian(v: unknown): v is Guardian {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const g = v as Record<string, unknown>;
    return g.version === 1 && typeof g.seed === "string" && /^[a-f0-9]{16}$/.test(g.seed) &&
        ZODIACS.some(x => x === g.zodiac) && BACKDROPS.some(x => x === g.backdrop) && CHARMS.some(x => x === g.charm) &&
        (g.wardrobe === undefined || validWardrobe(g.wardrobe));
}
export function projectGuardian(g: Guardian | undefined): Guardian | undefined {
    return g && {version: 1, seed: g.seed, zodiac: g.zodiac, backdrop: g.backdrop, charm: g.charm, ...(g.wardrobe ? {wardrobe: projectWardrobe(g.wardrobe)} : {})};
}
/** Public art seed only. Never used to derive a wallet, session key or spending authority. */
export function guardianSeed(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
}
function hash(value: string): number {
    let h = 2166136261;
    for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    // Mix high bits into low bits so power-of-two trait lists can vary independently.
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}
export function rollGuardian(member: Companion, seed: string, locked: ReadonlySet<RollLock> = new Set(), style: "matched" | "mix" = "matched"): Companion {
    if (!/^[a-f0-9]{16}$/.test(seed)) throw new Error("Invalid guardian seed");
    const pick = <T,>(key: string, values: readonly T[]): T => values[hash(`${seed}:${key}`) % values.length]!;
    const old = member.appearance;
    const selected = style === "matched" ? pick("wardrobe", WARDROBE_PRESETS).clothes : {hat: pick("hat", HATS), outfit: pick("outfit", OUTFITS), shoes: pick("shoes", SHOES)};
    const wardrobe: Wardrobe = {
        hat: old?.wardrobe && locked.has("hat") ? old.wardrobe.hat : selected.hat,
        outfit: old?.wardrobe && locked.has("outfit") ? old.wardrobe.outfit : selected.outfit,
        shoes: old?.wardrobe && locked.has("shoes") ? old.wardrobe.shoes : selected.shoes,
    };
    return {...member,
        appearance: {version: 1, seed,
            zodiac: old && locked.has("zodiac") ? old.zodiac : pick("zodiac", ZODIACS),
            backdrop: old && locked.has("backdrop") ? old.backdrop : pick("backdrop", BACKDROPS),
            charm: old && locked.has("charm") ? old.charm : pick("charm", CHARMS), wardrobe},
        color: locked.has("color") ? member.color : pick<Color>("color", ["red", "jade", "ink"]),
        temperament: locked.has("temperament") ? member.temperament : pick<Temperament>("temperament", ["curious", "bold", "calm"]),
        agent: {...member.agent, goal: locked.has("goal") ? member.agent.goal : pick<AgentGoal>("goal", ["explore", "score", "save"])},
    };
}
export function guardianCode(g: Guardian, color: Color): string {
    return `MP-${hash([g.version, g.zodiac, g.backdrop, g.charm, color, g.wardrobe?.hat, g.wardrobe?.outfit, g.wardrobe?.shoes].join(":" )).toString(16).padStart(8, "0").toUpperCase()}`;
}
export function guardianMetadata(member: Companion) {
    const g = member.appearance;
    if (!g || !validGuardian(g)) throw new Error("Choose a guardian first");
    return {
        schema: "mapae-guardian/1", name: member.name,
        description: "Mapae twelve guardians — a locally customized arcade character. Not a minted NFT.",
        image: `mapae-guardian-${member.id}.png`,
        attributes: [
            {trait_type: "Zodiac", value: g.zodiac}, {trait_type: "Backdrop", value: g.backdrop},
            {trait_type: "Charm", value: g.charm}, {trait_type: "Seal", value: member.color},
            {trait_type: "Temperament", value: member.temperament}, {trait_type: "Goal", value: member.agent.goal},
            ...(g.wardrobe ? [{trait_type: "Headwear", value: g.wardrobe.hat}, {trait_type: "Clothing", value: g.wardrobe.outfit}, {trait_type: "Footwear", value: g.wardrobe.shoes}] : []),
        ],
        properties: {characterId: member.id, artVersion: g.version, generationSeed: g.seed, appearance: projectGuardian(g), status: "local-character"},
    };
}
