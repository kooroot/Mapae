import type {ActivityOutcome, JsonValue} from "./contracts";

export type ProductId = "water" | "snack" | "charm";
export type Basket = Record<ProductId, number>;
export type ShopRole = "seller" | "buyer";
export type ShopGoal = "picnic" | "study" | "journey";
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
};
export const SHOP_GOALS: Record<ShopGoal, {ko: string; en: string}> = {
    picnic: {ko: "소풍 준비 · 물병 1 + 주먹밥 2", en: "Picnic · 1 water + 2 rice balls"},
    study: {ko: "시험 응원 · 물병 1 + 부적 1", en: "Exam support · 1 water + 1 charm"},
    journey: {ko: "긴 여행 · 물병 2 + 주먹밥 1", en: "Long journey · 2 water + 1 rice ball"},
};
export type SellerAction = {type: "ask" | "close"; message: string} |
    {type: "offer"; message: string; items: {id: ProductId; quantity: number}[]; price: number};
export type BuyerAction = {type: "request" | "buy" | "decline"; wants?: ProductId[]; reason: "need" | "price" | "fit" | "done"};
type Buyer = {
    id: string; name: string; goal: ShopGoal; balance: number; cap: number;
    spent: number; acquired: Basket; disclosed: ProductId[];
};
export type ShopLine = {speaker: "seller" | "buyer" | "system"; text: {ko: string; en: string}};
export type ShopReceipt = {
    customer: string; items: {id: ProductId; quantity: number}[]; price: number;
    cost: number; saving: number; satisfaction: number; goalAchievement: number; revisit: boolean;
};
export type ShopState = {
    seed: number; config: ShopConfig; buyers: Buyer[]; customer: number;
    phase: "buyer" | "seller" | "transition" | "finished"; rounds: number;
    inventory: Basket; cash: number; advertisingCost: number; revenue: number; costOfSales: number;
    offer: Extract<SellerAction, {type: "offer"}> | null; receipts: ShopReceipt[];
    conversation: ShopLine[]; transcript: ShopLine[]; rejected: string | null; capBlocks: number;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function product(value: unknown): value is ProductId { return value === "water" || value === "snack" || value === "charm"; }
function integer(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && typeof value === "number" && value >= min && value <= max; }
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

export function parseSellerAction(value: unknown): SellerAction {
    if (!record(value) || typeof value.message !== "string" || value.message.length > 180 || !value.message.trim()) throw new Error("INVALID_SELLER_ACTION");
    if ((value.type === "ask" || value.type === "close") && onlyKeys(value, ["type", "message"])) return {type: value.type, message: value.message.trim()};
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
export function createShop(seed: number, config: ShopConfig = DEFAULT_SHOP_CONFIG): ShopState {
    if (!Number.isFinite(seed) || !["seller", "buyer"].includes(config.role) || !["balanced", "everyday", "gifts"].includes(config.focus) || ![80, 100, 125].includes(config.pricing) || !["none", "poster", "parade"].includes(config.advertising) || !["profit", "loyalty"].includes(config.negotiation) || !["picnic", "study", "journey"].includes(config.buyerGoal) || !integer(config.buyerCap, 6, SHOP_BUYER_BALANCE) || !config.name.trim() || [...config.name].length > 18) throw new Error("INVALID_SHOP_CONFIG");
    const rng = random(seed);
    const goals: ShopGoal[] = ["picnic", "study", "journey"];
    const buyers = Array.from({length: 3}, (_, index): Buyer => {
        const goal = config.role === "buyer" ? config.buyerGoal : goals[Math.floor(rng() * 3)]!;
        const cap = config.role === "buyer" ? config.buyerCap : 10 + Math.floor(rng() * 13);
        return {id: `system-${index}`, name: ["두리", "솔이", "밤이"][index]!, goal,
            cap, balance: config.role === "buyer" ? SHOP_BUYER_BALANCE : cap + 3 + Math.floor(rng() * 8), spent: 0, acquired: emptyBasket(), disclosed: []};
    });
    const inventory = stock(config);
    const advertisingCost = config.role === "buyer" || config.advertising === "none" ? 0 : config.advertising === "poster" ? 4 : 8;
    // A targeted campaign changes demand, not a buyer's private purchasing power.
    if (config.role === "seller" && config.advertising !== "none") {
        const matches = config.advertising === "parade" ? 2 : 1;
        for (let i = 0; i < matches; i++) buyers[i]!.goal = config.focus === "gifts" ? "study" : "picnic";
    }
    return {seed, config: {...config}, buyers, customer: 0, phase: "buyer", rounds: 0, inventory,
        cash: SHOP_INITIAL_CAPITAL - cost(inventory) - advertisingCost, advertisingCost,
        revenue: 0, costOfSales: 0, offer: null, receipts: [], conversation: [], transcript: [], rejected: null, capBlocks: 0};
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

/** Only this projection may cross the seller decision boundary. Buyer messages are engine-rendered to prevent accidental budget disclosure. */
export function shopSellerObservation(state: ShopState): Record<string, JsonValue> {
    const buyer = state.buyers[state.customer]!;
    return {shop: state.config.name, focus: state.config.focus, pricing: state.config.pricing, negotiation: state.config.negotiation,
        initialCapital: SHOP_INITIAL_CAPITAL, cash: state.cash, inventory: {...state.inventory}, customer: buyer.name,
        requestedItems: [...buyer.disclosed], roundsLeft: 3 - state.rounds, previousResponse: state.rejected,
        products: SHOP_PRODUCTS.map(p => ({id: p.id, cost: p.cost, retail: p.retail})),
        conversation: state.conversation.map(e => ({speaker: e.speaker, text: e.text.en}))};
}
export function shopBuyerObservation(state: ShopState): Record<string, JsonValue> {
    const buyer = state.buyers[state.customer]!;
    return {objective: SHOP_GOALS[buyer.goal].en, target: {...objectives[buyer.goal]}, acquired: {...buyer.acquired},
        remainingBalance: buyer.balance - buyer.spent, spendingRemaining: buyer.cap - buyer.spent,
        roundsLeft: 3 - state.rounds, products: SHOP_PRODUCTS.map(p => ({id: p.id, retail: p.retail})),
        offer: state.offer ? {items: state.offer.items.map(i => ({...i})), price: state.offer.price, message: state.offer.message} : null,
        previousResponse: state.rejected, conversation: state.conversation.map(e => ({speaker: e.speaker, text: e.text.en}))};
}

export function applySellerAction(state: ShopState, raw: unknown): ShopState {
    if (state.phase !== "seller") throw new Error("NOT_SELLER_TURN");
    const action = parseSellerAction(raw);
    if (action.type === "offer" && action.items.some(i => i.quantity > state.inventory[i.id])) throw new Error("INSUFFICIENT_INVENTORY");
    const rounds = state.rounds + 1;
    const next = {...state, rounds, offer: action.type === "offer" ? action : null, rejected: null,
        phase: action.type === "close" ? "transition" as const : "buyer" as const};
    return line(next, {speaker: "seller", text: {ko: action.message, en: action.message}});
}

export function applyBuyerAction(state: ShopState, raw: unknown): ShopState {
    if (state.phase !== "buyer") throw new Error("NOT_BUYER_TURN");
    const action = parseBuyerAction(raw);
    const buyer = state.buyers[state.customer]!;
    const wants = action.wants ?? needs(buyer);
    const buyers = state.buyers.map((b, i) => i === state.customer ? {...b, disclosed: [...wants]} : b);
    let next: ShopState = {...state, buyers, rejected: null};
    if (action.type === "buy") {
        if (!state.offer) throw new Error("NO_ACTIVE_OFFER");
        const offer = state.offer;
        // No model response can change the owner-authorized cap, balance, quantity, or price.
        if (offer.price > buyer.cap - buyer.spent || offer.price > buyer.balance - buyer.spent) {
            next = {...next, capBlocks: state.capBlocks + 1, rejected: "CAP_BLOCKED", offer: null,
                phase: state.rounds >= 3 ? "transition" : "seller"};
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
        const satisfaction = Math.round(Math.max(0, Math.min(100, 75 * useful / count + 25 * Math.min(1, fair / offer.price))));
        const receipt: ShopReceipt = {customer: buyer.name, items: offer.items.map(i => ({...i})), price: offer.price, cost: itemCost,
            saving: fair - offer.price, satisfaction, goalAchievement: achievement(updatedBuyer), revisit: satisfaction >= 80};
        next = {...next, inventory, cash: state.cash + offer.price, revenue: state.revenue + offer.price,
            costOfSales: state.costOfSales + itemCost, receipts: [...state.receipts, receipt], offer: null, phase: "transition"};
        const bought = line(next, {speaker: "buyer", text: {ko: `좋아요! ${offer.price}냥에 살게요.`, en: `Deal! I'll take it for ${offer.price} coins.`}});
        return line(bought, {speaker: "system", text: {
            ko: `영수증 · ${offer.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.ko} ×${item.quantity}`).join(" + ")} · ${offer.price}냥 · 만족도 ${satisfaction}%`,
            en: `Receipt · ${offer.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name.en} ×${item.quantity}`).join(" + ")} · ${offer.price} coins · satisfaction ${satisfaction}%`,
        }});
    }
    const labels = wants.map(id => SHOP_PRODUCTS.find(p => p.id === id)!.name);
    const response = action.reason === "price" ? {ko: "가격이 부담돼요. 더 작거나 저렴한 묶음은 없나요?", en: "That's too expensive. Can you offer a smaller or cheaper bundle?"} :
        action.reason === "fit" ? {ko: "필요한 물건과 조금 달라요. 다른 조합을 보여 주세요.", en: "That doesn't fit my needs. Please show another combination."} :
        action.reason === "done" ? {ko: "오늘 필요한 건 다 샀어요. 다음에 올게요!", en: "I have what I need. See you next time!"} :
        {ko: `${labels.map(l => l.ko).join(", ") || "필요한 물건"}을 찾고 있어요. 어떤 구성이 좋을까요?`, en: `I'm looking for ${labels.map(l => l.en).join(", ") || "useful supplies"}. What would you suggest?`};
    next = {...next, offer: null, rejected: action.reason,
        phase: action.reason === "done" || state.rounds >= 3 ? "transition" : "seller"};
    return line(next, {speaker: "buyer", text: response});
}

export function nextShopCustomer(state: ShopState): ShopState {
    if (state.phase !== "transition") throw new Error("CUSTOMER_NOT_FINISHED");
    if (state.customer === 2) return {...state, phase: "finished"};
    const customer = state.customer + 1;
    const buyers = state.buyers.map(b => ({...b, acquired: {...b.acquired}, disclosed: [...b.disclosed]}));
    if (state.config.role === "buyer") {
        // One owner, one immutable allowance across all three shops; advancing cannot refill it.
        buyers[customer] = {...buyers[customer]!, ...buyers[state.customer]!, id: buyers[customer]!.id, name: buyers[customer]!.name, disclosed: []};
    }
    return {...state, buyers, customer, phase: "buyer", rounds: 0, offer: null, conversation: [], rejected: null,
        ...(state.config.role === "buyer" ? {inventory: stock(state.config)} : {})};
}

export function ruleSellerAction(observation: Record<string, JsonValue>, locale: "ko" | "en"): SellerAction {
    const inventory = observation.inventory as Basket;
    const wanted = Array.isArray(observation.requestedItems) ? observation.requestedItems.filter(product) : [];
    if (wanted.length === 0) return {type: "ask", message: locale === "ko" ? "어떤 물건이 필요한가요? 필요한 것부터 골라 드릴게요." : "What do you need? Let's start with what is useful to you."};
    const previous = observation.previousResponse;
    const loyalty = observation.negotiation === "loyalty";
    const items = wanted.filter(id => inventory[id] > 0).map(id => ({id, quantity: 1}));
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
    if (offer.price > Number(observation.spendingRemaining) || offer.price > Number(observation.remainingBalance) || offer.price > retail(offer.items) * 1.1) return {type: "decline", wants, reason: "price"};
    if (!offer.items.some(i => wants.includes(i.id))) return {type: "decline", wants, reason: "fit"};
    return {type: "buy", reason: "need"};
}

export function simulateShop(seed: number, config: ShopConfig, buyerStyle: "careful" | "impulsive" = "careful"): ShopState {
    let state = createShop(seed, config);
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
    const satisfaction = state.receipts.length ? Math.round(state.receipts.reduce((sum, r) => sum + r.satisfaction, 0) / state.receipts.length) : 0;
    const goal = state.config.role === "buyer" ? achievement(buyer) : Math.round(state.buyers.reduce((sum, b) => sum + achievement(b), 0) / 3);
    const savings = state.receipts.reduce((sum, r) => sum + r.saving, 0);
    return {profit, satisfaction, goal, savings, revisit: state.receipts.filter(r => r.revisit).length, spent: buyer.spent,
        score: state.config.role === "seller" ? Math.max(0, profit * 10 + satisfaction) : Math.max(0, goal * 10 + savings * 10 + satisfaction)};
}

export function shopOutcome(state: ShopState, name: string, locale: "ko" | "en"): ActivityOutcome {
    if (state.phase !== "finished") throw new Error("SHOP_NOT_FINISHED");
    const stats = shopMetrics(state);
    const seller = state.config.role === "seller";
    const baseline = simulateShop(state.seed, seller ? {...state.config, pricing: 100, advertising: "none", negotiation: "loyalty"} : state.config);
    const comparison = seller ? simulateShop(state.seed, {...state.config, pricing: 125, advertising: "parade", negotiation: "profit"}) : simulateShop(state.seed, state.config, "impulsive");
    return {game: "shop", score: stats.score,
        summary: {ko: seller ? `손님 3명 · 순이익 ${stats.profit}냥 · 만족도 ${stats.satisfaction}%` : `가게 3곳 · 구매 목표 ${stats.goal}% · ${stats.savings}냥 절약`,
            en: seller ? `3 customers · ${stats.profit} coins profit · ${stats.satisfaction}% satisfaction` : `3 shops · ${stats.goal}% of goal · ${stats.savings} coins saved`},
        metrics: [
            {label: {ko: "초기 자본", en: "Starting capital"}, value: seller ? SHOP_INITIAL_CAPITAL : SHOP_BUYER_BALANCE, unit: "coin"},
            seller ? {label: {ko: "순이익", en: "Net profit"}, value: stats.profit, unit: "coin"} :
                {label: {ko: "구매 지출", en: "Purchase spend"}, value: stats.spent, unit: "coin"},
            {label: {ko: "만족도", en: "Satisfaction"}, value: stats.satisfaction, unit: "%"},
            {label: {ko: "재방문 의사", en: "Would return"}, value: stats.revisit},
            {label: {ko: "구매 목표", en: "Goal achieved"}, value: stats.goal, unit: "%"},
            {label: {ko: "절약액", en: "Savings"}, value: stats.savings, unit: "coin"},
            {label: {ko: "한도 차단", en: "Limit blocks"}, value: state.capBlocks},
        ], transcript: state.transcript.map(e => ({speaker: e.speaker, text: e.text[locale]})),
        ranking: [{name, score: stats.score}, {name: locale === "ko" ? "기준 운영 · 규칙 봇" : "Baseline · rules", score: shopMetrics(baseline).score},
            {name: seller ? (locale === "ko" ? "프리미엄 운영 · 규칙 봇" : "Premium · rules") : (locale === "ko" ? "충동 구매 · 규칙 봇" : "Impulse buyer · rules"), score: shopMetrics(comparison).score}].sort((a, b) => b.score - a.score)};
}
