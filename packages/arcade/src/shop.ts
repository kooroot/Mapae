import {ARCADE_RULESET_VERSION, type ActivityOutcome, type JsonValue} from "./contracts";

export type ProductId = "water" | "snack" | "charm";
export type Basket = Record<ProductId, number>;
export type ShopRole = "seller" | "buyer";
export type ShopMemory = {npc: "twins" | "courier"; visits: 1 | 2; service: "complete" | "partial" | "missed"; value: number};
export const SHOP_REGULARS = {
    twins: {name: {ko: "두리", en: "Duri"}, goal: "gift"},
    courier: {name: {ko: "솔이", en: "Sol"}, goal: "delivery"},
} as const;
export const SHOP_AD_COST = {none: 0, poster: 1, parade: 2} as const;
export type ShopForecast = {npc: ShopMemory["npc"]; goal: ShopGoal; target: Basket; visit: 1 | 2; trusted: boolean; previous: ShopMemory | null};
export const SHOP_TEMPERAMENTS = ["thrifty", "hurried", "particular"] as const;
export type BuyerTemperament = typeof SHOP_TEMPERAMENTS[number];
export const SHOP_TEMPERAMENT_COPY = {
    thrifty: {ko: "알뜰한 손님", en: "Bargain hunter", hint: {ko: "제값보다 싸야 마음이 움직여요.", en: "Looks for a price below retail."}},
    hurried: {ko: "바쁜 손님", en: "In a hurry", hint: {ko: "제안은 두 번만. 필요한 걸 한 번에 주세요.", en: "Only two offers. Wants everything in one trip."}},
    particular: {ko: "꼼꼼한 손님", en: "Careful shopper", hint: {ko: "필요 없는 물건이 끼면 안 사요.", en: "Rejects bundles padded with unwanted goods."}},
} as const;
const priceTolerance = {thrifty: .85, hurried: 1.15, particular: 1} as const;
export type ShopGoal = "picnic" | "study" | "journey" | "festival" | "gift" | "delivery";
export type ShopConfig = {
    role: ShopRole; name: string; focus: "balanced" | "everyday" | "gifts";
    pricing: 80 | 100 | 125; advertising: "none" | "poster" | "parade";
    negotiation: "profit" | "loyalty"; buyerGoal: ShopGoal; buyerCap: number;
};
export const SHOP_PRODUCTS = [
    {id: "water", name: {ko: "구름 물병", en: "Cloud water"}, cost: 2, retail: 4, icon: "◒"},
    {id: "snack", name: {ko: "달빛 주먹밥", en: "Moon rice ball"}, cost: 3, retail: 6, icon: "◭"},
    {id: "charm", name: {ko: "행운 말부적", en: "Lucky horse charm"}, cost: 4, retail: 8, icon: "✦"},
] as const;
export const SHOP_INITIAL_CAPITAL = 100;
export const SHOP_BUYER_BALANCE = 30;
export const DEFAULT_SHOP_CONFIG: ShopConfig = {
    role: "seller", name: "말랑 잡화점", focus: "balanced", pricing: 100,
    advertising: "none", negotiation: "loyalty", buyerGoal: "picnic", buyerCap: 18,
};
const emptyBasket = (): Basket => ({water: 0, snack: 0, charm: 0});
const objectives: Record<ShopGoal, Basket> = {
    picnic: {water: 1, snack: 2, charm: 0}, study: {water: 1, snack: 0, charm: 1},
    journey: {water: 2, snack: 1, charm: 0},
    festival: {water: 0, snack: 2, charm: 1}, gift: {water: 0, snack: 0, charm: 2}, delivery: {water: 1, snack: 1, charm: 1},
};
export const SHOP_GOALS: Record<ShopGoal, {ko: string; en: string}> = {
    picnic: {ko: "소풍 준비 · 물병 1 + 주먹밥 2", en: "Picnic · 1 water + 2 rice balls"},
    study: {ko: "시험 응원 · 물병 1 + 부적 1", en: "Exam support · 1 water + 1 charm"},
    journey: {ko: "긴 여행 · 물병 2 + 주먹밥 1", en: "Long journey · 2 water + 1 rice ball"},
    festival: {ko: "달맞이 잔치 · 주먹밥 2 + 부적 1", en: "Moon festival · 2 rice balls + 1 charm"},
    gift: {ko: "쌍둥이 선물 · 부적 2", en: "Gifts for twins · 2 charms"},
    delivery: {ko: "배달부 보따리 · 물병 1 + 주먹밥 1 + 부적 1", en: "Courier pack · 1 water + 1 rice ball + 1 charm"},
};
export const SHOP_STORIES = {
    picnic: {title: {ko: "소풍 모임의 총무", en: "The picnic organizer"},
        line: {ko: "친구와 주먹밥 하나씩 나눠 먹으려 해요. 물도 함께 챙겨 주세요.", en: "One rice ball each for my friend and me, and some water to share."},
        hint: {ko: "적게 팔면 이익은 남아도 친구 한 명은 배고파요.", en: "A small pack may leave one friend hungry."}, wholeOrder: false},
    study: {title: {ko: "과거를 앞둔 선비", en: "The exam scholar"},
        line: {ko: "시험장에 물과 응원 부적을 가져가려 해요. 다른 물건은 짐이에요.", en: "Water and a lucky charm for the exam. Anything else is extra baggage."},
        hint: {ko: "필요한 두 가지를 깔끔하게. 덤이어도 엉뚱한 물건은 싫어요.", en: "The two requested goods only, even if an extra is free."}, wholeOrder: false},
    journey: {title: {ko: "고개 넘는 나그네", en: "The mountain traveler"},
        line: {ko: "고개 두 개를 넘어야 해요. 물 두 병과 주먹밥 하나, 세 개까지만 들게요.", en: "Two mountain passes ahead. Two waters and a rice ball; I can carry only three things."},
        hint: {ko: "물 한 병을 아끼면 손님의 여행 준비가 덜 끝나요.", en: "Saving one bottle leaves part of the journey unprepared."}, wholeOrder: false},
    festival: {title: {ko: "달맞이 재주꾼", en: "The moon-festival performer"},
        line: {ko: "공연 전후로 먹을 주먹밥 두 개와 행운 부적을 찾소!", en: "Two rice balls, before and after my show, and a lucky charm!"},
        hint: {ko: "주먹밥 하나를 더 챙길지, 다음 손님을 위해 남길지 골라요.", en: "Include the second meal, or save that stock for the next guest."}, wholeOrder: false},
    gift: {title: {ko: "쌍둥이 선물 고르는 부모", en: "The twins' gift shopper"},
        line: {ko: "쌍둥이가 다투면 안 되니 같은 부적 두 개로 주세요. 하나만은 안 돼요.", en: "Two matching charms for my twins, please. One would start an argument."},
        hint: {ko: "선물은 반드시 한 쌍. 부적 재고가 두 개 필요해요.", en: "Gifts must come as a pair. Keep two charms in stock."}, wholeOrder: true},
    delivery: {title: {ko: "출발 앞둔 파발꾼", en: "The departing courier"},
        line: {ko: "출발 종이 곧 울려요. 물, 주먹밥, 부적을 한 번에 챙겨야 해요.", en: "The departure bell is about to ring. Water, a rice ball, and a charm in one stop."},
        hint: {ko: "빠진 물건이 있으면 떠나요. 한 번에 주문을 채워요.", en: "Missing goods mean no deal. Fill the whole order at once."}, wholeOrder: true},
} as const;
export const SHOP_TACTICS = ["essentials", "generous", "settle"] as const;
export type ShopTactic = typeof SHOP_TACTICS[number];
export type SellerAction = {type: "ask" | "close"; message: string} |
    {type: "serve"; tactic: ShopTactic; message: string} |
    {type: "offer"; message: string; items: {id: ProductId; quantity: number}[]; price: number};
export type BuyerAction = {type: "request" | "buy" | "decline"; wants?: ProductId[]; reason: "need" | "price" | "fit" | "done"};
type Buyer = {
    id: string; name: string; goal: ShopGoal; story: ShopGoal; temperament: BuyerTemperament; balance: number; cap: number;
    spent: number; acquired: Basket; disclosed: ProductId[]; requested: Partial<Basket>;
};
export type ShopLine = {speaker: "seller" | "buyer" | "system"; text: {ko: string; en: string}};
export type ShopReceipt = {
    customer: string; items: {id: ProductId; quantity: number}[]; price: number;
    cost: number; saving: number; value: number; goalAchievement: number; revisit: boolean;
    tactic: ShopTactic | null; customerIndex: number;
};
export type ShopState = {
    seed: number; config: ShopConfig; buyers: Buyer[]; customer: number;
    startingMemory: ShopMemory | null; forecast: ShopForecast | null;
    phase: "buyer" | "seller" | "transition" | "finished"; rounds: number;
    inventory: Basket; cash: number; advertisingCost: number; revenue: number; costOfSales: number;
    offer: Extract<SellerAction, {type: "offer"}> | null; receipts: ShopReceipt[];
    lastOffer: Extract<SellerAction, {type: "offer"}> | null;
    counterOffer: {items: {id: ProductId; quantity: number}[]; price: number} | null;
    conversation: ShopLine[]; transcript: ShopLine[]; rejected: string | null; capBlocks: number;
    tactic: ShopTactic | null; finalOffer: boolean; referral: {from: string; value: number} | null;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function product(value: unknown): value is ProductId { return value === "water" || value === "snack" || value === "charm"; }
function integer(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && typeof value === "number" && value >= min && value <= max; }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

/** Memory stores only the last authored service, never a customer's purchasing power. */
export function parseShopMemory(value: unknown): ShopMemory | null {
    if (!record(value) || !onlyKeys(value, ["npc", "visits", "service", "value"])
        || !["npc", "visits", "service", "value"].every(key => Object.hasOwn(value, key))
        || (value.npc !== "twins" && value.npc !== "courier") || (value.visits !== 1 && value.visits !== 2)
        || (value.service !== "complete" && value.service !== "partial" && value.service !== "missed")
        || !integer(value.value, 0, 100) || (value.service === "missed" && value.value !== 0)
        || (value.service === "complete" && value.value < 85)) return null;
    return {npc: value.npc, visits: value.visits, service: value.service, value: value.value};
}

export function shopForecast(seed: number, memory?: ShopMemory): ShopForecast {
    const previous = parseShopMemory(memory);
    const returning = previous?.visits === 1;
    const npc = returning ? previous.npc : (Math.abs(seed % 2) === 0 ? "twins" : "courier");
    return {npc, goal: SHOP_REGULARS[npc].goal, target: {...objectives[SHOP_REGULARS[npc].goal]}, visit: returning ? 2 : 1,
        trusted: returning && previous.service === "complete", previous: returning ? previous : null};
}

export function shopCampaign(config: ShopConfig) {
    return {goal: config.focus === "gifts" ? "gift" as const : config.focus === "everyday" ? "picnic" as const : "study" as const,
        matches: config.advertising === "parade" ? 2 : config.advertising === "poster" ? 1 : 0,
        cost: SHOP_AD_COST[config.advertising]};
}

export function shopReturnLine(forecast: ShopForecast): {ko: string; en: string} {
    const name = SHOP_REGULARS[forecast.npc].name;
    if (forecast.visit === 1) return {ko: `${name.ko}의 첫 방문 · 마지막 손님을 위해 주문 재고를 남겨 주세요.`, en: `${name.en}'s first visit · Save the requested stock for your final guest.`};
    if (forecast.trusted) return forecast.npc === "twins"
        ? {ko: "지난번 같은 선물을 받아 쌍둥이가 함께 웃었어요. 이번에도 부탁해요! 정가도 괜찮고, 제안도 한 번 더 들어볼게요.", en: "The twins loved their matching gifts! I'll pay a fair retail price and hear one extra offer today."}
        : {ko: "지난번 빠짐없이 챙겨 주셔서 배달을 마쳤어요. 이번엔 정가도 괜찮아요. 제안도 한 번 더 들어볼게요.", en: "Your complete pack got me through my deliveries. I'll pay fair retail and hear one extra offer today."};
    return forecast.npc === "twins"
        ? {ko: "지난번 선물 준비는 아쉬웠어요. 오늘은 부적 두 개를 좋은 가격에 부탁해요.", en: "Last time's gifts weren't quite right. Two charms at a good price today, please."}
        : {ko: "지난번 보따리는 아쉬웠어요. 오늘은 빠짐없이, 좋은 가격에 부탁해요.", en: "Last time's pack wasn't quite right. All three supplies at a good price today, please."};
}

export function parseShopConfig(value: unknown): ShopConfig | null {
    const keys = ["role", "name", "focus", "pricing", "advertising", "negotiation", "buyerGoal", "buyerCap"];
    if (!record(value) || !onlyKeys(value, keys) || !keys.every(key => Object.hasOwn(value, key))
        || typeof value.role !== "string" || !["seller", "buyer"].includes(value.role) || typeof value.focus !== "string" || !["balanced", "everyday", "gifts"].includes(value.focus)
        || typeof value.pricing !== "number" || ![80, 100, 125].includes(value.pricing)
        || typeof value.advertising !== "string" || !["none", "poster", "parade"].includes(value.advertising) || typeof value.negotiation !== "string" || !["profit", "loyalty"].includes(value.negotiation)
        || typeof value.buyerGoal !== "string" || !Object.hasOwn(SHOP_GOALS, value.buyerGoal)
        || !integer(value.buyerCap, 6, SHOP_BUYER_BALANCE) || typeof value.name !== "string" || !value.name.trim() || [...value.name.trim()].length > 18) return null;
    return {role: value.role as ShopRole, name: value.name.trim(), focus: value.focus as ShopConfig["focus"],
        pricing: value.pricing as ShopConfig["pricing"], advertising: value.advertising as ShopConfig["advertising"],
        negotiation: value.negotiation as ShopConfig["negotiation"], buyerGoal: value.buyerGoal as ShopGoal, buyerCap: value.buyerCap};
}

export function parseSellerAction(value: unknown): SellerAction {
    if (!record(value) || typeof value.message !== "string" || value.message.length > 180 || !value.message.trim()) throw new Error("INVALID_SELLER_ACTION");
    if ((value.type === "ask" || value.type === "close") && onlyKeys(value, ["type", "message"])) return {type: value.type, message: value.message.trim()};
    if (value.type === "serve" && onlyKeys(value, ["type", "tactic", "message"]) && SHOP_TACTICS.some(tactic => tactic === value.tactic)) return {type: "serve", tactic: value.tactic as ShopTactic, message: value.message.trim()};
    if (value.type !== "offer" || !onlyKeys(value, ["type", "message", "items", "price"]) || !integer(value.price, 1, 99) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 3) throw new Error("INVALID_SELLER_OFFER");
    const seen = new Set<ProductId>();
    const items = value.items.map(item => {
        if (!record(item) || !onlyKeys(item, ["id", "quantity"]) || !product(item.id) || !integer(item.quantity, 1, 3) || seen.has(item.id)) throw new Error("INVALID_SELLER_ITEMS");
        seen.add(item.id); return {id: item.id, quantity: item.quantity};
    });
    return {type: "offer", message: value.message.trim(), items, price: value.price};
}

export function parseBuyerAction(value: unknown): BuyerAction {
    if (!record(value) || !onlyKeys(value, ["type", "wants", "reason"]) || !["request", "buy", "decline"].includes(String(value.type)) || !["need", "price", "fit", "done"].includes(String(value.reason))) throw new Error("INVALID_BUYER_ACTION");
    if (value.wants !== undefined && (!Array.isArray(value.wants) || value.wants.length > 3 || !value.wants.every(product) || new Set(value.wants).size !== value.wants.length)) throw new Error("INVALID_BUYER_WANTS");
    return {type: value.type as BuyerAction["type"], reason: value.reason as BuyerAction["reason"], ...(value.wants !== undefined ? {wants: value.wants as ProductId[]} : {})};
}

function random(seed: number): () => number {
    let value = seed >>> 0;
    return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
function stock(config: ShopConfig): Basket {
    return config.focus === "everyday" ? {water: 6, snack: 5, charm: 1} : config.focus === "gifts" ? {water: 3, snack: 2, charm: 6} : {water: 4, snack: 4, charm: 4};
}
function cost(basket: Basket): number { return SHOP_PRODUCTS.reduce((sum, item) => sum + item.cost * basket[item.id], 0); }
export function createShop(seed: number, config: ShopConfig = DEFAULT_SHOP_CONFIG, memory?: ShopMemory): ShopState {
    const parsed = parseShopConfig(config);
    if (!Number.isSafeInteger(seed) || !parsed) throw new Error("INVALID_SHOP_CONFIG");
    if (memory !== undefined && !parseShopMemory(memory)) throw new Error("INVALID_SHOP_MEMORY");
    config = parsed;
    const rng = random(seed);
    const goals = Object.keys(SHOP_GOALS) as ShopGoal[];
    // Sample without replacement: one market visit always has three distinct errands.
    const startingMemory = config.role === "seller" ? parseShopMemory(memory) : null;
    const forecast = config.role === "seller" ? shopForecast(seed, startingMemory ?? undefined) : null;
    const errands = goals.filter(goal => goal !== forecast?.goal);
    const buyers = Array.from({length: 3}, (_, index): Buyer => {
        const sampled = config.role === "buyer" ? config.buyerGoal : errands.splice(Math.floor(rng() * errands.length), 1)[0]!;
        const goal = index === 2 && forecast ? forecast.goal : sampled;
        const cap = config.role === "buyer" ? config.buyerCap : 10 + Math.floor(rng() * 13);
        return {id: `system-${index}`, temperament: config.role === "buyer" ? "particular" : SHOP_TEMPERAMENTS[(Math.abs(seed % 3) + index) % 3]!, name: ["두리", "솔이", "밤이"][index]!, goal, story: goal,
            cap, balance: config.role === "buyer" ? SHOP_BUYER_BALANCE : cap + 3 + Math.floor(rng() * 8), spent: 0, acquired: emptyBasket(), disclosed: [], requested: {}};
    });
    if (forecast) {
        const thrifty = buyers.find(buyer => buyer.temperament === "thrifty")!;
        thrifty.temperament = buyers[2]!.temperament;
        buyers[2]!.temperament = "thrifty";
        buyers[0]!.name = "나그네"; buyers[1]!.name = "장터 손님";
        buyers[2]!.name = SHOP_REGULARS[forecast.npc].name.ko;
    }
    const inventory = stock(config);
    const campaign = shopCampaign(config);
    const advertisingCost = config.role === "buyer" ? 0 : campaign.cost;
    // A targeted campaign changes demand, not a buyer's private purchasing power.
    if (config.role === "seller" && config.advertising !== "none") {
        const matches = campaign.matches;
        for (let i = 0; i < matches; i++) buyers[i]!.goal = buyers[i]!.story = campaign.goal;
    }
    return {seed, config: {...config}, startingMemory, forecast, buyers, customer: 0, phase: "buyer", rounds: 0, inventory,
        cash: SHOP_INITIAL_CAPITAL - cost(inventory) - advertisingCost, advertisingCost,
        revenue: 0, costOfSales: 0, offer: null, lastOffer: null, counterOffer: null, receipts: [], conversation: [], transcript: [], rejected: null, capBlocks: 0,
        tactic: null, finalOffer: false, referral: null};
}

export function shopCustomerName(state: ShopState, index: number, locale: "ko" | "en"): string {
    if (state.config.role !== "seller" || locale === "ko") return state.buyers[index]!.name;
    return index === 2 && state.forecast ? SHOP_REGULARS[state.forecast.npc].name.en : index === 0 ? "Traveler" : "Market guest";
}

export function shopPatience(state: ShopState): number {
    const base = state.config.role === "seller" && state.buyers[state.customer]!.temperament === "hurried" ? 2 : 3;
    return base + (state.config.role === "seller" && state.customer === 2 ? (state.referral ? 1 : 0) + (state.forecast?.trusted ? 1 : 0) : 0);
}
export function shopOffersRemaining(state: ShopState): number {
    return state.finalOffer || state.phase === "transition" || state.phase === "finished" ? 0 : Math.max(0, shopPatience(state) - state.rounds);
}

function line(state: ShopState, entry: ShopLine): ShopState {
    return {...state, conversation: [...state.conversation, entry], transcript: [...state.transcript, entry]};
}
function retail(items: {id: ProductId; quantity: number}[]): number {
    return items.reduce((sum, item) => sum + SHOP_PRODUCTS.find(p => p.id === item.id)!.retail * item.quantity, 0);
}
function needs(buyer: Buyer): ProductId[] { return SHOP_PRODUCTS.filter(p => buyer.acquired[p.id] < objectives[buyer.goal][p.id]).map(p => p.id); }
function achievement(buyer: Buyer): number {
    const target = objectives[buyer.goal];
    return Math.round(SHOP_PRODUCTS.reduce((sum, p) => sum + Math.min(target[p.id], buyer.acquired[p.id]), 0) / Object.values(target).reduce((a, b) => a + b, 0) * 100);
}

export type ShopOfferChoice = {
    tactic: ShopTactic; items: {id: ProductId; quantity: number}[]; price: number; cost: number;
    label: string; hint: string; available: boolean; completesOrder: boolean; reserveShortfall: Basket;
};

/** Contextual offers are calculated from the same disclosed facts for people and agents. */
export function shopOfferChoices(observation: Record<string, JsonValue>, locale: "ko" | "en"): ShopOfferChoice[] {
    const inventory = observation.inventory as Basket;
    const requested = observation.requestedQuantities as Partial<Basket>;
    const wanted = Array.isArray(observation.requestedItems) ? observation.requestedItems.filter(product).filter(id => (requested[id] ?? 0) > 0) : [];
    if (!wanted.length) return [];
    const wholeOrder = observation.wholeOrder === true || observation.temperament === "hurried";
    const full = wanted.map(id => ({id, quantity: Math.min(3, requested[id]!)}));
    const small = full.map(item => ({...item, quantity: wholeOrder ? item.quantity : 1}));
    const counter = observation.counterOffer as {items: {id: ProductId; quantity: number}[]; price: number} | null;
    const settled = counter?.items ?? full;
    const stockCost = (items: typeof full) => items.reduce((sum, item) => sum + SHOP_PRODUCTS.find(p => p.id === item.id)!.cost * item.quantity, 0);
    const priceFactor = Number(observation.pricing) / 100;
    const trustedRetail = observation.returnTrust === true && observation.previousResponse !== "price" && observation.previousResponse !== "CAP_BLOCKED";
    const recipes = [
        {tactic: "essentials" as const, items: small, price: Math.max(1, Math.round(retail(small) * priceFactor)),
            label: locale === "ko" ? wholeOrder ? "주문대로 챙기기" : "가볍게 추천" : wholeOrder ? "Fill the order" : "A small pack",
            hint: locale === "ko" ? wholeOrder ? "표시가 기준 · 재흥정 가능" : "종류별 하나씩 · 재고를 아껴요" : wholeOrder ? "Sticker price · room to bargain" : "One of each kind · save your stock"},
        {tactic: "generous" as const, items: full, price: trustedRetail ? retail(full) : Math.max(stockCost(full), Math.min(Math.floor(retail(full) * .85), retail(small))),
            label: trustedRetail ? locale === "ko" ? "다시 믿고 찾은 보따리" : "Your trusted pack" : locale === "ko" ? full.some((item, i) => item.quantity > small[i]!.quantity) ? "넉넉하게 챙기기" : "정 나누기" : "A generous pack",
            hint: trustedRetail ? locale === "ko" ? "지난 서비스의 신뢰 · 전부 정가로 준비" : "Earned trust · a complete pack at retail" : locale === "ko" ? "필요한 수량 전부 · 이익을 양보해요" : "Every requested unit · give up some margin"},
        {tactic: "settle" as const, items: settled.map(item => ({...item})), price: counter?.price ?? Math.max(stockCost(full), Math.floor(retail(full) * .95 * priceFactor)),
            label: locale === "ko" ? counter ? "그 가격에 성사" : "마지막 제안" : counter ? "Take their bid" : "One final offer",
            hint: locale === "ko" ? "수락하면 거래, 거절하면 만남 종료" : "A deal if accepted; otherwise the meeting ends"},
    ];
    const reserve = observation.finalGuestReserve as Basket | null;
    return recipes.map(recipe => ({...recipe, reserveShortfall: Object.fromEntries(SHOP_PRODUCTS.map(p => [p.id, reserve ? Math.max(0, reserve[p.id] - (inventory[p.id] - (recipe.items.find(i => i.id === p.id)?.quantity ?? 0))) : 0])) as Basket, cost: stockCost(recipe.items),
        available: recipe.items.every(item => item.quantity <= inventory[item.id]),
        completesOrder: full.every(item => (recipe.items.find(i => i.id === item.id)?.quantity ?? 0) >= item.quantity)}));
}

/** Only this projection may cross the seller decision boundary. Buyer messages are engine-rendered to prevent accidental budget disclosure. */
export function shopSellerObservation(state: ShopState): Record<string, JsonValue> {
    const buyer = state.buyers[state.customer]!;
    const observation: Record<string, JsonValue> = {shop: state.config.name, focus: state.config.focus, pricing: state.config.pricing, negotiation: state.config.negotiation,
        initialCapital: SHOP_INITIAL_CAPITAL, cash: state.cash, inventory: {...state.inventory}, customer: shopCustomerName(state, state.customer, "en"),
        finalGuest: state.forecast ? {name: SHOP_REGULARS[state.forecast.npc].name.en, goal: SHOP_GOALS[state.forecast.goal].en, visit: state.forecast.visit, trusted: state.forecast.trusted} : null,
        finalGuestReserve: state.forecast && state.customer < 2 ? {...objectives[state.forecast.goal]} : null,
        returnTrust: state.customer === 2 && state.forecast?.trusted === true,
        requestedItems: [...buyer.disclosed], roundsLeft: shopOffersRemaining(state), previousResponse: state.rejected,
        temperament: buyer.temperament, counterOffer: state.counterOffer ? {price: state.counterOffer.price, items: state.counterOffer.items.map(i => ({...i}))} : null,
        requestedQuantities: {...buyer.requested},
        situation: buyer.disclosed.length ? SHOP_STORIES[buyer.story].title.en : null,
        needHint: buyer.disclosed.length ? SHOP_STORIES[buyer.story].hint.en : null,
        wholeOrder: buyer.disclosed.length > 0 && SHOP_STORIES[buyer.story].wholeOrder,
        referral: state.referral ? {from: state.referral.from, extraPatience: 1} : null,
        lastOffer: state.lastOffer ? {items: state.lastOffer.items.map(i => ({...i})), price: state.lastOffer.price} : null,
        products: SHOP_PRODUCTS.map(p => ({id: p.id, cost: p.cost, retail: p.retail})),
        conversation: state.conversation.map(e => ({speaker: e.speaker, text: e.text.en}))};
    observation.legalTactics = shopOfferChoices(observation, "en").filter(option => option.available).map(option => ({
        tactic: option.tactic, items: option.items, price: option.price, margin: option.price - option.cost,
        completesOrder: option.completesOrder, reserveShortfall: {...option.reserveShortfall}, endsMeetingIfRejected: option.tactic === "settle", description: option.hint,
    }));
    return observation;
}
export function shopBuyerObservation(state: ShopState): Record<string, JsonValue> {
    const buyer = state.buyers[state.customer]!;
    return {temperament: buyer.temperament, priceTolerance: state.customer === 2 && state.forecast?.trusted ? 1 : priceTolerance[buyer.temperament], objective: SHOP_GOALS[buyer.goal].en, target: {...objectives[buyer.goal]}, acquired: {...buyer.acquired},
        wholeOrder: state.config.role === "seller" && SHOP_STORIES[buyer.story].wholeOrder,
        rejectsExtras: state.config.role === "seller" && buyer.story === "study",
        maxGoods: state.config.role === "seller" && buyer.story === "journey" ? 3 : null,
        remainingBalance: buyer.balance - buyer.spent, spendingRemaining: buyer.cap - buyer.spent,
        roundsLeft: shopOffersRemaining(state), products: SHOP_PRODUCTS.map(p => ({id: p.id, retail: p.retail})),
        offer: state.offer ? {items: state.offer.items.map(i => ({...i})), price: state.offer.price, message: state.offer.message} : null,
        previousResponse: state.rejected, conversation: state.conversation.map(e => ({speaker: e.speaker, text: e.text.en}))};
}

export function applySellerAction(state: ShopState, raw: unknown): ShopState {
    if (state.phase !== "seller") throw new Error("NOT_SELLER_TURN");
    const requestedAction = parseSellerAction(raw);
    let action: Exclude<SellerAction, {type: "serve"}>;
    if (requestedAction.type === "serve") {
        const choice = shopOfferChoices(shopSellerObservation(state), "en").find(option => option.tactic === requestedAction.tactic && option.available);
        if (!choice) throw new Error("TACTIC_UNAVAILABLE");
        action = {type: "offer", items: choice.items, price: choice.price, message: requestedAction.message};
    } else action = requestedAction;
    if (action.type === "offer" && action.items.some(i => i.quantity > state.inventory[i.id])) throw new Error("INSUFFICIENT_INVENTORY");
    const rounds = state.rounds + 1;
    const next = {...state, rounds, offer: action.type === "offer" ? action : null, lastOffer: action.type === "offer" ? action : state.lastOffer, counterOffer: null, rejected: null,
        phase: action.type === "close" ? "transition" as const : "buyer" as const,
        tactic: requestedAction.type === "serve" ? requestedAction.tactic : null, finalOffer: requestedAction.type === "serve" && requestedAction.tactic === "settle"};
    return line(next, {speaker: "seller", text: {ko: action.message, en: action.message}});
}

export function applyBuyerAction(state: ShopState, raw: unknown): ShopState {
    if (state.phase !== "buyer") throw new Error("NOT_BUYER_TURN");
    const action = parseBuyerAction(raw);
    const buyer = state.buyers[state.customer]!;
    const wants = action.wants ?? needs(buyer);
    const buyers = state.buyers.map((b, i) => i === state.customer ? {...b, disclosed: [...wants], requested:
        Object.fromEntries(wants.map(id => [id, Math.max(0, objectives[buyer.goal][id] - buyer.acquired[id])]))} : b);
    let next: ShopState = {...state, buyers, rejected: null, counterOffer: null};
    if (action.type === "buy") {
        if (!state.offer) throw new Error("NO_ACTIVE_OFFER");
        const offer = state.offer;
        // No model response can change the owner-authorized cap, balance, quantity, or price.
        if (offer.price > buyer.cap - buyer.spent || offer.price > buyer.balance - buyer.spent) {
            next = {...next, capBlocks: state.capBlocks + 1, rejected: "CAP_BLOCKED", offer: null,
                phase: state.finalOffer || state.rounds >= shopPatience(state) ? "transition" : "seller"};
            return line(next, {speaker: "system", text: {ko: "구매가 허용 범위를 넘어서 차단됐어요. 정확한 한도는 상대에게 보이지 않아요.", en: "Purchase blocked by the owner's spending limit. The exact limit stays private."}});
        }
        if (offer.items.some(i => state.inventory[i.id] < i.quantity)) throw new Error("INSUFFICIENT_INVENTORY");
        const acquired = {...buyer.acquired};
        const inventory = {...state.inventory};
        let useful = 0, count = 0, itemCost = 0;
        for (const item of offer.items) {
            useful += Math.min(item.quantity, Math.max(0, objectives[buyer.goal][item.id] - acquired[item.id]));
            count += item.quantity; acquired[item.id] += item.quantity; inventory[item.id] -= item.quantity;
            itemCost += SHOP_PRODUCTS.find(p => p.id === item.id)!.cost * item.quantity;
        }
        const updatedBuyer = {...buyers[state.customer]!, acquired, spent: buyer.spent + offer.price};
        buyers[state.customer] = updatedBuyer;
        const fair = retail(offer.items);
        // Value rates only the purchased goods; completing the errand is a separate condition.
        const value = Math.round(100 * useful / count * Math.min(1, .85 * fair / offer.price));
        const receipt: ShopReceipt = {customer: buyer.name, items: offer.items.map(i => ({...i})), price: offer.price, cost: itemCost,
            saving: fair - offer.price, value, goalAchievement: achievement(updatedBuyer), revisit: value >= 85 && useful === count && achievement(updatedBuyer) === 100,
            tactic: state.tactic, customerIndex: state.customer};
        next = {...next, inventory, cash: state.cash + offer.price, revenue: state.revenue + offer.price,
            costOfSales: state.costOfSales + itemCost, receipts: [...state.receipts, receipt], offer: null, phase: "transition"};
        const bought = line(next, {speaker: "buyer", text: {ko: `좋아요! ${offer.price}냥에 살게요.`, en: `Deal! I'll take it for ${offer.price} coins.`}});
        return line(bought, {speaker: "system", text: {
            ko: `영수증 · ${offer.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.ko} ×${item.quantity}`).join(" + ")} · ${offer.price}냥 · 구매 가치 ${value}% · 준비 완료 ${achievement(updatedBuyer)}%`,
            en: `Receipt · ${offer.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.en} ×${item.quantity}`).join(" + ")} · ${offer.price} coins · purchase value ${value}% · errand ${achievement(updatedBuyer)}%`,
        }});
    }
    // A public bid expresses willingness to pay, not the hidden balance or cap.
    const tolerance = state.customer === 2 && state.forecast?.trusted ? 1 : priceTolerance[buyer.temperament];
    const bid = state.offer ? Math.max(1, Math.floor(retail(state.offer.items) * tolerance)) : 0;
    if (state.config.role === "seller" && action.reason === "price" && state.offer && bid < state.offer.price
        && bid <= buyer.cap - buyer.spent && bid <= buyer.balance - buyer.spent && !state.finalOffer && state.rounds < shopPatience(state)) {
        next.counterOffer = {items: state.offer.items.map(i => ({...i})), price: bid};
    }
    const labels = wants.map(id => SHOP_PRODUCTS.find(p => p.id === id)!.name);
    const response = next.counterOffer ? {ko: `그 구성 그대로 ${bid}냥이면 살게요. 어떠세요?`, en: `I can offer ${bid} coins for that exact bundle. Deal?`} : action.reason === "price" ? {ko: "가격이 부담돼요. 더 작거나 저렴한 묶음은 없나요?", en: "That's too expensive. Can you offer a smaller or cheaper bundle?"} :
        action.reason === "fit" ? {ko: "필요한 물건과 조금 달라요. 다른 조합을 보여 주세요.", en: "That doesn't fit my needs. Please show another combination."} :
        action.reason === "done" ? {ko: "오늘 필요한 건 다 샀어요. 다음에 올게요!", en: "I have what I need. See you next time!"} :
        {ko: `${SHOP_STORIES[buyer.story].line.ko} ${wants.map(id => `${SHOP_PRODUCTS.find(p => p.id === id)!.name.ko} ${Math.max(0, objectives[buyer.goal][id] - buyer.acquired[id])}개`).join(", ") || "필요한 물건"}, 이렇게 찾고 있어요.`, en: `${SHOP_STORIES[buyer.story].line.en} I need ${wants.map((id, i) => `${Math.max(0, objectives[buyer.goal][id] - buyer.acquired[id])} ${labels[i]!.en}`).join(", ") || "useful supplies"}.`};
    next = {...next, offer: null, rejected: action.reason,
        phase: action.reason === "done" || state.finalOffer || state.rounds >= shopPatience(state) ? "transition" : "seller"};
    const farewell = state.finalOffer ? {ko: "마지막 제안도 맞지 않네요. 오늘은 여기까지 할게요.", en: "That final offer still doesn't fit. I'll leave it for today."}
        : state.rounds >= shopPatience(state) ? {ko: `${response.ko} ${buyer.temperament === "hurried" ? "서둘러 가 봐야겠어요!" : "이번엔 다음에 올게요."}`, en: `${response.en} ${buyer.temperament === "hurried" ? "I have to run!" : "I'll try again another day."}`} : response;
    return line(next, {speaker: "buyer", text: farewell});
}

export function nextShopCustomer(state: ShopState): ShopState {
    if (state.phase !== "transition") throw new Error("CUSTOMER_NOT_FINISHED");
    if (state.customer === 2) return {...state, phase: "finished"};
    const customer = state.customer + 1;
    const buyers = state.buyers.map(b => ({...b, acquired: {...b.acquired}, disclosed: [...b.disclosed], requested: {...b.requested}}));
    if (state.config.role === "buyer") {
        // One owner, one immutable allowance across all three shops; advancing cannot refill it.
        buyers[customer] = {...buyers[customer]!, ...buyers[state.customer]!, id: buyers[customer]!.id, name: buyers[customer]!.name, disclosed: [], requested: {}};
    }
    // Referrals buy attention, never purchasing power. No cap or balance is changed.
    const recommendation = customer === 2 && state.config.role === "seller" ? state.receipts
        .filter(receipt => receipt.customerIndex < 2 && receipt.revisit)
        .sort((a, b) => b.value - a.value)[0] : undefined;
    const referral = recommendation ? {from: recommendation.customer, value: recommendation.value} : null;
    const next: ShopState = {...state, buyers, customer, phase: "buyer", rounds: 0, offer: null, lastOffer: null, counterOffer: null, conversation: [], rejected: null,
        tactic: null, finalOffer: false, referral,
        ...(state.config.role === "buyer" ? {inventory: stock(state.config)} : {})};
    const announced = customer === 2 && next.forecast?.visit === 2 ? line(next, {speaker: "buyer", text: shopReturnLine(next.forecast)}) : next;
    return referral ? line(announced, {speaker: "buyer", text: {ko: `${referral.from}에게 소개받고 왔어요. 주문을 잘 챙겨 준다면서요? 제안도 한 번 더 들어볼게요!`, en: `${referral.from} recommended your shop. They said you filled their whole order! I'll hear one extra offer.`}}) : announced;
}

export function ruleSellerAction(observation: Record<string, JsonValue>, locale: "ko" | "en"): SellerAction {
    const inventory = observation.inventory as Basket;
    const wanted = Array.isArray(observation.requestedItems) ? observation.requestedItems.filter(product) : [];
    if (wanted.length === 0) return {type: "ask", message: locale === "ko" ? "어떤 물건이 필요한가요? 필요한 것부터 골라 드릴게요." : "What do you need? Let's start with what is useful to you."};
    const counter = observation.counterOffer as {items: {id: ProductId; quantity: number}[]; price: number} | null;
    if (counter && counter.items.every(i => inventory[i.id] >= i.quantity)
        && counter.price >= counter.items.reduce((sum, i) => sum + SHOP_PRODUCTS.find(p => p.id === i.id)!.cost * i.quantity, 0)) {
        return {type: "serve", tactic: "settle", message: locale === "ko" ? `좋아요. 말씀하신 ${counter.price}냥에 드릴게요!` : `Agreed. ${counter.price} coins for that bundle!`};
    }
    const previous = observation.previousResponse;
    const loyalty = observation.negotiation === "loyalty";
    const choices = shopOfferChoices(observation, locale).filter(option => option.available);
    const tactic = loyalty || previous === "price" || previous === "CAP_BLOCKED" || previous === "fit" ? "generous" : "essentials";
    const chosen = choices.find(option => option.tactic === tactic);
    if (chosen && ((previous !== "price" && previous !== "CAP_BLOCKED") || observation.returnTrust === true)) return {type: "serve", tactic: chosen.tactic, message: locale === "ko"
        ? `${chosen.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.ko} ×${item.quantity}`).join(" + ")}, ${chosen.price}냥에 챙겨 드릴게요.`
        : `${chosen.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.en} ×${item.quantity}`).join(" + ")} for ${chosen.price} coins.`};
    const requested = observation.requestedQuantities as Partial<Basket>;
    const items = wanted.filter(id => inventory[id] > 0 && (requested[id] ?? 1) > 0).map(id => ({id, quantity: Math.min(3, inventory[id], requested[id] ?? 1)}));
    if (items.length === 0) return {type: "close", message: locale === "ko" ? "필요한 상품이 모두 품절이에요. 다음에 만나요!" : "Your items are sold out. See you next time!"};
    if ((previous === "price" || previous === "CAP_BLOCKED") && items.length > 1) items.pop();
    const markdown = previous === "price" || previous === "CAP_BLOCKED" ? 0.7 : loyalty && items.length > 1 ? 0.85 : 1;
    const price = Math.max(1, Math.round(retail(items) * Number(observation.pricing) / 100 * markdown));
    const names = items.map(i => SHOP_PRODUCTS.find(p => p.id === i.id)!.name[locale]).join(" + ");
    return {type: "offer", items, price, message: locale === "ko" ? `${names}, ${price}냥 어때요? ${markdown < 1 ? "필요에 맞춰 할인했어요!" : "하나씩 알차게 골랐어요."}` : `${names} for ${price} coins. ${markdown < 1 ? "A discount tailored to you!" : "A useful selection for your trip."}`};
}
export function ruleBuyerAction(observation: Record<string, JsonValue>): BuyerAction {
    const target = observation.target as Basket;
    const acquired = observation.acquired as Basket;
    const wants = SHOP_PRODUCTS.filter(p => acquired[p.id] < target[p.id]).map(p => p.id);
    if (wants.length === 0) return {type: "decline", reason: "done", wants};
    const offer = observation.offer as {items: {id: ProductId; quantity: number}[]; price: number} | null;
    if (!offer) return {type: "request", wants, reason: "need"};
    const useful = offer.items.reduce((sum, item) => sum + Math.min(item.quantity, Math.max(0, target[item.id] - acquired[item.id])), 0);
    const count = offer.items.reduce((sum, item) => sum + item.quantity, 0);
    const temperament = observation.temperament as BuyerTemperament;
    if (typeof observation.maxGoods === "number" && count > observation.maxGoods) return {type: "decline", wants, reason: "fit"};
    if (useful / count < (temperament === "particular" || observation.rejectsExtras === true ? 1 : .75)) return {type: "decline", wants, reason: "fit"};
    if ((temperament === "hurried" || observation.wholeOrder === true) && wants.some(id => (offer.items.find(i => i.id === id)?.quantity ?? 0) < target[id] - acquired[id])) return {type: "decline", wants, reason: "fit"};
    if (offer.price > Number(observation.spendingRemaining) || offer.price > Number(observation.remainingBalance)
        || offer.price > Math.floor(retail(offer.items) * Number(observation.priceTolerance))) return {type: "decline", wants, reason: "price"};
    return {type: "buy", reason: "need"};
}

export function simulateShop(seed: number, config: ShopConfig, buyerStyle: "careful" | "impulsive" = "careful", memory?: ShopMemory): ShopState {
    let state = createShop(seed, config, memory);
    for (let step = 0; step < 40 && state.phase !== "finished"; step++) {
        state = state.phase === "transition" ? nextShopCustomer(state) : state.phase === "seller" ?
            applySellerAction(state, ruleSellerAction(shopSellerObservation(state), "en")) :
            applyBuyerAction(state, buyerStyle === "impulsive" && state.offer ? {type: "buy", reason: "need"} : ruleBuyerAction(shopBuyerObservation(state)));
    }
    if (state.phase !== "finished") throw new Error("SHOP_DID_NOT_FINISH");
    return state;
}

export function shopMetrics(state: ShopState) {
    const buyer = state.buyers[state.customer]!;
    const profit = state.revenue - state.costOfSales - state.advertisingCost;
    const value = state.receipts.length ? Math.round(state.receipts.reduce((sum, r) => sum + r.value, 0) / state.receipts.length) : 0;
    const goal = state.config.role === "buyer" ? achievement(buyer) : Math.round(state.buyers.reduce((sum, b) => sum + achievement(b), 0) / 3);
    const savings = state.receipts.reduce((sum, r) => sum + r.saving, 0);
    return {profit, value, goal, savings, revisit: state.receipts.filter(r => r.revisit).length, spent: buyer.spent,
        score: state.config.role === "seller" ? Math.max(0, profit * 10 + goal) : Math.max(0, goal * 10 + savings * 10 + value)};
}

export function shopOutcome(state: ShopState, name: string, locale: "ko" | "en"): ActivityOutcome {
    if (state.phase !== "finished") throw new Error("SHOP_NOT_FINISHED");
    const stats = shopMetrics(state);
    const seller = state.config.role === "seller";
    const baseline = simulateShop(state.seed, seller ? {...state.config, pricing: 100, advertising: "none", negotiation: "loyalty"} : state.config, "careful", state.startingMemory ?? undefined);
    const comparison = seller ? simulateShop(state.seed, {...state.config, pricing: 125, advertising: "parade", negotiation: "profit"}, "careful", state.startingMemory ?? undefined) : simulateShop(state.seed, state.config, "impulsive");
    const highlights: {ko: string; en: string}[] = [];
    if (state.referral) highlights.push({ko: `${state.referral.from}의 소개로 마지막 손님에게 제안할 기회를 한 번 더 얻었어요.`, en: `${state.referral.from}'s recommendation earned one extra offer with the final customer.`});
    const generous = state.receipts.find(receipt => receipt.tactic === "generous" && receipt.goalAchievement === 100);
    const counterDeal = state.receipts.find(receipt => receipt.tactic === "settle");
    const bestReceipt = generous ?? counterDeal ?? state.receipts.at(-1);
    if (bestReceipt) highlights.push({ko: seller
        ? `${bestReceipt.customer}에게 ${bestReceipt.items.reduce((sum, item) => sum + item.quantity, 0)}개를 팔아 ${bestReceipt.price - bestReceipt.cost}냥 이익 · 주문 ${bestReceipt.goalAchievement}%를 채웠어요.`
        : `마지막 구매까지 목표 ${stats.goal}% 달성 · 한도 안에서 ${stats.spent}냥을 썼어요.`,
        en: seller ? `Sold ${bestReceipt.items.reduce((sum, item) => sum + item.quantity, 0)} goods to ${shopCustomerName(state, bestReceipt.customerIndex, "en")}: ${bestReceipt.price - bestReceipt.cost} coins profit, ${bestReceipt.goalAchievement}% of their errand filled.`
            : `Reached ${stats.goal}% of your goal, spending ${stats.spent} coins within your cap.`});
    if (!highlights.length) highlights.push({ko: "세 번의 만남에서 거래가 성사되지 않았어요. 같은 장날에 다른 제안을 해 보세요.", en: "No deal across three meetings. Try a different offer on the same market day."});
    const finalReceipt = state.receipts.find(receipt => receipt.customerIndex === 2);
    const shopMemory: ShopMemory | undefined = seller && state.forecast ? {npc: state.forecast.npc, visits: state.forecast.visit,
        service: finalReceipt?.revisit ? "complete" : finalReceipt ? "partial" : "missed", value: finalReceipt?.value ?? 0} : undefined;
    if (seller && state.forecast?.visit === 2) highlights.splice(0, 1, {ko: `${SHOP_REGULARS[state.forecast.npc].name.ko}의 두 번째 방문 · ${state.forecast.trusted ? "지난 완수의 신뢰로 정가 제안 가능" : "지난 서비스 뒤 다시 도전"} · 오늘 ${finalReceipt ? `${finalReceipt.price - finalReceipt.cost}냥 이익` : "거래 없음"}.`, en: `${SHOP_REGULARS[state.forecast.npc].name.en}'s second visit: ${state.forecast.trusted ? "past service earned trust at retail" : "a second chance after last time"}; ${finalReceipt ? `${finalReceipt.price - finalReceipt.cost} coins profit today` : "no deal today"}.`});
    return {game: "shop", ...(shopMemory ? {shopMemory} : {}),
        replay: {version: ARCADE_RULESET_VERSION, seed: state.seed, shop: {...state.config}, ...(state.startingMemory ? {shopMemory: {...state.startingMemory}} : {})}, score: stats.score, highlights,
        summary: {ko: seller ? `손님 3명 · 순이익 ${stats.profit}냥 · 주문 완수 ${stats.goal}%` : `가게 3곳 · 구매 목표 ${stats.goal}% · ${stats.savings}냥 절약`,
            en: seller ? `3 customers · ${stats.profit} coins profit · ${stats.goal}% of errands filled` : `3 shops · ${stats.goal}% of goal · ${stats.savings} coins saved`},
        metrics: [
            {label: {ko: "초기 자본", en: "Starting capital"}, value: seller ? SHOP_INITIAL_CAPITAL : SHOP_BUYER_BALANCE, unit: "coin"},
            seller ? {label: {ko: "순이익", en: "Net profit"}, value: stats.profit, unit: "coin"} :
                {label: {ko: "구매 지출", en: "Purchase spend"}, value: stats.spent, unit: "coin"},
            {label: {ko: "구매 가치", en: "Purchase value"}, value: stats.value, unit: "%"},
            {label: {ko: "완수한 좋은 거래", en: "Useful complete service"}, value: stats.revisit},
            {label: {ko: "구매 목표", en: "Goal achieved"}, value: stats.goal, unit: "%"},
            {label: {ko: "절약액", en: "Savings"}, value: stats.savings, unit: "coin"},
            {label: {ko: "한도 차단", en: "Limit blocks"}, value: state.capBlocks},
        ], transcript: state.transcript.map(e => ({speaker: e.speaker, text: e.text[locale]})),
        ranking: [{name, score: stats.score}, {name: locale === "ko" ? "기준 운영 · 규칙 봇" : "Baseline · rules", score: shopMetrics(baseline).score},
            {name: seller ? (locale === "ko" ? "프리미엄 운영 · 규칙 봇" : "Premium · rules") : (locale === "ko" ? "충동 구매 · 규칙 봇" : "Impulse buyer · rules"), score: shopMetrics(comparison).score}].sort((a, b) => b.score - a.score)};
}
