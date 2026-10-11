import {encodePacked, isHash, keccak256, type Address, type Hex} from "viem";

export const GUARDIAN_CHAIN_ID = 91342;
export const GUARDIAN_TRAITS_VERSION = 1;
export const GUARDIAN_CAPACITY = 3;
export const GUARDIAN_ENTROPY = "0x0708325268dF9F66270F1401206434524814508b" as const;
export const GUARDIAN_PROVIDER = "0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344" as const;
export const GUARDIAN_ZODIACS = ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"] as const;
export const GUARDIAN_HATS = ["none", "topknot", "gat", "satgat", "samo", "ikseongwan", "jeonrip", "paeraengi", "headwrap"] as const;
export const GUARDIAN_OUTFITS = ["gonryongpo", "minister", "official", "military", "scholar", "artisan", "hemp", "performer"] as const;
export const GUARDIAN_SHOES = ["jipsin", "namaksin", "taesahye", "heukhwa", "beoseon"] as const;
export const GUARDIAN_BACKDROPS = ["dawn", "moon", "jade", "ember"] as const;
export const GUARDIAN_CHARMS = ["mapae", "scroll", "pouch", "none"] as const;
export const GUARDIAN_COLORS = ["red", "jade", "ink"] as const;
export const GUARDIAN_TEMPERAMENTS = ["curious", "bold", "calm"] as const;
export const GUARDIAN_APTITUDES = [[4, 5, 6], [4, 6, 5], [5, 4, 6], [5, 6, 4], [6, 4, 5], [6, 5, 4]] as const;
export type GuardianAptitudes = {stamp: number; race: number; shop: number};
export const GUARDIAN_MAX_SUPPLY = 10_000;
/** MapaeGuardians.MAX_CLAIM_BATCH: the most results one claimResults transaction may carry. */
export const GUARDIAN_CLAIM_BATCH = 32;
export const GUARDIAN_NAME_MODIFIERS: {ko: readonly string[]; en: readonly string[]} = {
    ko: ["졸린", "배고픈", "수줍은", "덤벙대는", "꼼꼼한", "콧노래 부르는", "엽전 세는", "신난", "느긋한", "부지런한", "호기심 많은", "용감한", "씩씩한", "얌전한", "장난스러운", "깜찍한", "꾀 많은", "춤추는", "노래하는", "낮잠 자는", "하품하는", "재채기하는", "딸꾹질하는", "떡 먹는", "엿 파는", "연 날리는", "팽이 돌리는", "제기 차는", "윷 던지는", "그네 타는", "별 세는", "달 보는", "구름 쫓는", "나비 쫓는", "개구리 잡는", "붓 든", "북 치는", "피리 부는", "장구 치는", "꽹과리 치는", "휘파람 부는", "꿈꾸는", "웃음 많은", "상냥한", "똑똑한", "엉뚱한", "명랑한", "의젓한", "발 빠른", "손 큰", "눈치 빠른", "코 고는", "반짝이는", "보송보송한", "말랑말랑한", "뒹구는", "깡충깡충 뛰는", "뒤뚱거리는", "살금살금 걷는", "두리번거리는", "수다스러운", "과묵한", "고집 센", "깜빡깜빡하는", "바쁜", "들뜬", "설레는", "뿌듯한", "꾸벅꾸벅 조는", "이불 덮은", "밥 짓는", "국수 삶는", "감자 굽는", "군밤 까는", "곶감 숨긴", "송편 빚는", "빨래하는", "물 긷는", "장작 패는", "짚신 삼는", "새끼 꼬는", "보따리 멘", "장터 가는", "편지 쓰는", "글 읽는", "수수께끼 내는", "숨바꼭질하는", "술래잡기하는", "도깨비 만난", "호랑이 놀린", "까치 반기는", "무지개 찾는", "눈사람 만드는", "꽃 따는", "도토리 모으는", "꼬리 흔드는", "늠름한", "다정한", "꿋꿋한", "쌩쌩한"],
    en: ["Sleepy", "Hungry", "Shy", "Clumsy", "Meticulous", "Humming", "Coin-Counting", "Excited", "Easygoing", "Diligent", "Curious", "Brave", "Plucky", "Gentle", "Playful", "Adorable", "Clever", "Dancing", "Singing", "Napping", "Yawning", "Sneezing", "Hiccuping", "Rice-Cake-Munching", "Taffy-Selling", "Kite-Flying", "Top-Spinning", "Shuttlecock-Kicking", "Yut-Tossing", "Swinging", "Star-Counting", "Moon-Watching", "Cloud-Chasing", "Butterfly-Chasing", "Frog-Catching", "Brush-Wielding", "Drumming", "Flute-Playing", "Janggu-Playing", "Gong-Ringing", "Whistling", "Dreaming", "Giggly", "Kind", "Bright", "Quirky", "Cheerful", "Poised", "Swift-Footed", "Generous", "Quick-Witted", "Snoring", "Sparkling", "Fluffy", "Squishy", "Tumbling", "Hopping", "Waddling", "Tiptoeing", "Glancing", "Chatty", "Quiet", "Stubborn", "Forgetful", "Busy", "Giddy", "Eager", "Beaming", "Nodding-Off", "Cozy", "Rice-Cooking", "Noodle-Boiling", "Potato-Roasting", "Chestnut-Peeling", "Persimmon-Hiding", "Songpyeon-Making", "Laundry-Doing", "Water-Fetching", "Wood-Chopping", "Sandal-Weaving", "Rope-Twisting", "Bundle-Carrying", "Market-Bound", "Letter-Writing", "Book-Reading", "Riddling", "Hide-and-Seeking", "Tag-Playing", "Dokkaebi-Spotting", "Tiger-Teasing", "Magpie-Greeting", "Rainbow-Seeking", "Snowman-Building", "Flower-Picking", "Acorn-Gathering", "Tail-Wagging", "Gallant", "Affectionate", "Steadfast", "Lively"],
};
export const GUARDIAN_GIVEN_NAMES: {ko: readonly string[]; en: readonly string[]} = {
    ko: ["돌쇠", "마당쇠", "꽃분이", "복실이", "개똥이", "삼월이", "덕구", "칠복이", "막동이", "억쇠", "바우", "똘이", "점순이", "쇠돌이", "갑돌이", "갑순이", "복동이", "복순이", "순돌이", "삼돌이", "칠득이", "만복이", "만석이", "천석이", "금동이", "은동이", "옥분이", "옥동이", "봉순이", "봉구", "달래", "달님이", "별님이", "초롱이", "방울이", "꽃님이", "순이", "영이", "철이", "삽살이", "누렁이", "바둑이", "춘삼이", "마돌이", "장쇠", "먹쇠", "판쇠", "꽃돌이", "보리", "콩이", "팥쇠", "감돌이", "밤톨이", "도토리", "대길이", "수동이", "귀동이", "귀남이", "귀분이", "옥이", "연이", "아롱이", "다롱이", "몽실이", "봉실이", "복돌이", "오복이", "칠성이", "팔봉이", "구슬이", "백돌이", "천둥이", "번개", "우뚝이", "막쇠", "삼순이", "봄이", "여름이", "가을이", "겨울이", "꽃순이", "매화", "솔이", "차돌이", "뭉치", "똘똘이", "알밤이", "꼬물이", "복댕이", "복남이", "쌀분이", "금순이", "은순이", "덕순이", "덕배", "만득이", "상돌이", "얼쑤", "덩실이", "까꿍이"],
    en: ["Dolsoe", "Madangsoe", "Kkotbuni", "Boksiri", "Gaettongi", "Samwori", "Deokgu", "Chilbogi", "Makdongi", "Eoksoe", "Bau", "Ttori", "Jeomsuni", "Soedori", "Gapdori", "Gapsuni", "Bokdongi", "Boksuni", "Sundori", "Samdori", "Childeugi", "Manbogi", "Manseogi", "Cheonseogi", "Geumdongi", "Eundongi", "Okbuni", "Okdongi", "Bongsuni", "Bonggu", "Dallae", "Dallimi", "Byeollimi", "Chorongi", "Banguri", "Kkonnimi", "Suni", "Yeongi", "Cheori", "Sapsari", "Nureongi", "Badugi", "Chunsami", "Madori", "Jangsoe", "Meoksoe", "Pansoe", "Kkotdori", "Bori", "Kongi", "Patsoe", "Gamdori", "Bamtori", "Dotori", "Daegiri", "Sudongi", "Gwidongi", "Gwinami", "Gwibuni", "Ogi", "Yeoni", "Arongi", "Darongi", "Mongsiri", "Bongsiri", "Bokdori", "Obogi", "Chilseongi", "Palbongi", "Guseuri", "Baekdori", "Cheondungi", "Beongae", "Uttugi", "Maksoe", "Samsuni", "Bomi", "Yeoreumi", "Gaeuri", "Gyeouri", "Kkotsuni", "Maehwa", "Sori", "Chadori", "Mungchi", "Ttolttori", "Albami", "Kkomuri", "Bokdaengi", "Bongnami", "Ssalbuni", "Geumsuni", "Eunsuni", "Deoksuni", "Deokbae", "Mandeugi", "Sangdori", "Eolssu", "Deongsiri", "Kkakkungi"],
};
/** Display name for a minted guardian: a 7919-step walk over the 100x100 modifier/given grid, so every token ID 1..10000 gets a distinct name. */
export function guardianName(tokenId: string | bigint | number, locale: "ko" | "en"): string {
    const id = typeof tokenId === "string" ? (/^[1-9][0-9]{0,4}$/.test(tokenId) ? Number(tokenId) : 0) : typeof tokenId === "bigint" ? (tokenId <= BigInt(GUARDIAN_MAX_SUPPLY) ? Number(tokenId) : 0) : Number.isSafeInteger(tokenId) ? tokenId : 0;
    if (id < 1 || id > GUARDIAN_MAX_SUPPLY) throw new Error("Invalid guardian token ID");
    const index = ((id - 1) * 7919) % GUARDIAN_MAX_SUPPLY;
    return `${GUARDIAN_NAME_MODIFIERS[locale][index % 100]} ${GUARDIAN_GIVEN_NAMES[locale][Math.floor(index / 100)]}`;
}

/** Birth-word decoder shared with GuardianTraits.sol. No clocks, wallet keys or rerolls. */
export function guardianTraits(seed: Hex) {
    if (!isHash(seed)) throw new Error("Invalid guardian birth seed");
    const pick = <T,>(index: number, values: readonly T[]): T => values[Number(BigInt(keccak256(encodePacked(["bytes32", "uint8"], [seed, index]))) % BigInt(values.length))]!;
    const [stamp, race, shop] = pick(8, GUARDIAN_APTITUDES);
    return {
        version: GUARDIAN_TRAITS_VERSION, seed,
        zodiac: pick(0, GUARDIAN_ZODIACS), hat: pick(1, GUARDIAN_HATS), outfit: pick(2, GUARDIAN_OUTFITS), shoes: pick(3, GUARDIAN_SHOES),
        backdrop: pick(4, GUARDIAN_BACKDROPS), charm: pick(5, GUARDIAN_CHARMS), color: pick(6, GUARDIAN_COLORS),
        temperament: pick(7, GUARDIAN_TEMPERAMENTS), aptitudes: {stamp, race, shop} as GuardianAptitudes,
    };
}
export type GuardianTraits = ReturnType<typeof guardianTraits>;
export type GuardianSnapshot = {
    chainId: 91342; collection: Address; tokenId: string; owner: Address; ownershipEpoch: string;
    seed: Hex; traitsHash: Hex; ruleset: number;
};
export function guardianTraitsHash(seed: Hex): Hex {
    if (!isHash(seed)) throw new Error("Invalid guardian birth seed");
    // abi.encode(bytes32) is exactly its 32 bytes.
    return keccak256(seed);
}
export function validGuardianAptitudes(value: unknown): value is GuardianAptitudes {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 3 && GUARDIAN_APTITUDES.some(([stamp, race, shop]) => v.stamp === stamp && v.race === race && v.shop === shop);
}
export function guardianTokenId(value: unknown): value is string {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) return false;
    return BigInt(value) < 1n << 256n;
}
export const GUARDIAN_RESULT_TYPES = {Result: [
    {name: "resultId", type: "bytes32"}, {name: "tokenId", type: "uint256"}, {name: "actor", type: "address"},
    {name: "ownershipEpoch", type: "uint64"}, {name: "paymentTx", type: "bytes32"}, {name: "traitsHash", type: "bytes32"},
    {name: "inputsHash", type: "bytes32"}, {name: "ruleset", type: "uint32"}, {name: "seed", type: "uint32"},
    {name: "game", type: "uint8"}, {name: "score", type: "uint32"}, {name: "victory", type: "bool"},
]} as const;
export type GuardianResult = {
    resultId: Hex; tokenId: bigint; actor: Address; ownershipEpoch: bigint; paymentTx: Hex;
    traitsHash: Hex; inputsHash: Hex; ruleset: number; seed: number; game: number; score: number; victory: boolean;
};
export type GuardianResultJson = Omit<GuardianResult, "tokenId" | "ownershipEpoch"> & {tokenId: string; ownershipEpoch: string};
export const guardianResultDomain = (collection: Address) => ({name: "Mapae Guardians", version: "1", chainId: GUARDIAN_CHAIN_ID, verifyingContract: collection}) as const;
export function guardianResultFromJson(value: GuardianResultJson): GuardianResult {
    if (!guardianTokenId(value.tokenId) || !guardianTokenId(value.ownershipEpoch) || BigInt(value.ownershipEpoch) >= 1n << 64n) throw new Error("Invalid guardian result identity");
    return {...value, tokenId: BigInt(value.tokenId), ownershipEpoch: BigInt(value.ownershipEpoch)};
}
