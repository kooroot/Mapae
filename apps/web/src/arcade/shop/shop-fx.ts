import type {ShopEvent, ShopState} from "@mapae/arcade/shop";
import {countUp, flash, play} from "../juice";
import type {MotionTier} from "../motion";
import type {ArcadeSound, SoundKind} from "../sound";

/** The engine's pace at 1×: a turn, and the pause between customers. Playback speed divides both. */
export const SHOP_TURN_MS = 1050;
export const SHOP_TRANSITION_MS = 1700;
/** An agent's customer walks out in the transition's last beat; a player's leaves before the next state, quick enough not to feel like a wait. */
export const SHOP_LEAVE_MS = 380;
const HUMAN_LEAVE_MS = 300;
/** juice's light ceiling: a watched agent's next beat comes 1050ms later at 1×, 525ms at 2×, so no gesture may run past this. */
const LIGHT_MS = 300;
const LIMIT_RED = "#b8402f";
/** One red pulse over the counter edge when the owner's cap stops a purchase. */
const LIMIT_FLASH_MS = 320;
export const SHOP_COIN_SPRITE = "/arcade/coin-yeopjeon-512.webp";
export const SHOP_COIN_SLOTS = 5;
const GOLD = "#f2c45a";
const GOLD_FLASH_MS = 360;
/** The deal at 1×, in ms from the buyer's yes. The heart (80), seal (140) and counter edge (200) are CSS delays scaled by `--shop-beat`. */
const DEAL = {hop: 520, sealSound: 320, coinStart: 260, coinGap: 50, coinFlight: 520, count: 450};
/** A watched agent's seal has no delay: its sound lands with the stamp's 40% impact on the 240ms base token. */
const LIGHT_SEAL_SOUND = 100;
/** Two hops on the wrapper, squashing on each landing; added onto any gesture transform. */
const DEAL_HOP: Keyframe[] = [{transform: "translateY(0) scale(1)"}, {transform: "translateY(-10px) scale(.98, 1.02)", offset: .2}, {transform: "translateY(0) scale(1.03, .97)", offset: .42},
    {transform: "translateY(-6px) scale(.99, 1.01)", offset: .62}, {transform: "translateY(0) scale(1.03, .97)", offset: .84}, {transform: "translateY(0) scale(1)"}];
const LEAVE: Keyframe[] = [{opacity: 1, transform: "translateX(0)"}, {opacity: 0, transform: "translateX(-48px)"}];
/** An offer at 1×: goods set down on the counter one by one, the price tag swings in after them, a final offer is underlined in ink. */
const OFFER = {gap: 70, item: 300, tagAfter: 120, tag: 200, lineAfter: 160, line: 240};
/** A watched agent's offer lands at once: everything on the quick token, no stagger. */
const LIGHT_OFFER_MS = 160;
const SET_DOWN: Keyframe[] = [{opacity: 0, transform: "translateY(14px) scale(.9)"}, {opacity: 1, transform: "translateY(0) scale(1)"}];
const TAG_SWING: Keyframe[] = [{opacity: 0, transform: "translateY(-6px) rotate(-8deg)"}, {opacity: 1, transform: "translateY(0) rotate(0deg)"}];
const INK_LINE: Keyframe[] = [{transform: "scaleX(0)"}, {transform: "scaleX(1)"}];

/** What the customer's face says about the meeting so far. Only price, fit and a cap block read as a refusal. */
export type ShopReaction = "happy" | "price" | "fit" | "blocked" | "farewell";
export type ShopGesture = "price" | "fit" | "farewell";

/** Body language, moved by `transform` on the `.shop-guest` wrapper (its CSS entrance owns `translate`, so the two add up). */
export const SHOP_GESTURES: Record<ShopGesture, {keyframes: Keyframe[]; ms: number; easing: "shake" | "out"}> = {
    price: {keyframes: [0, -6, 5, -3, 0].map(x => ({transform: `translateX(${x}px)`})), ms: 380, easing: "shake"},
    fit: {keyframes: [0, 4, -2, 0].map(deg => ({transform: `rotate(${deg}deg)`})), ms: 460, easing: "out"},
    farewell: {keyframes: [{transform: "translateY(0)"}, {transform: "translateY(4px)", offset: .45}, {transform: "translateY(0)"}], ms: 420, easing: "out"},
};

export function shopReaction(state: ShopState): ShopReaction | null {
    const settled = state.phase === "transition" || state.phase === "finished";
    if (settled && state.receipts.some(receipt => receipt.customerIndex === state.customer)) return "happy";
    if (state.rejected === "CAP_BLOCKED") return "blocked";
    if (state.rejected === "price" || state.rejected === "fit") return state.rejected;
    // Restating a need is not a refusal; leaving satisfied, or being shown out, is a goodbye.
    return settled && (state.rejected === "done" || state.rejected === null) ? "farewell" : null;
}

export function shopRefusal(reaction: ShopReaction | null): boolean {
    return reaction === "price" || reaction === "fit" || reaction === "blocked";
}

/** The `data-cue` the stage carries after an event, so styles and browser checks can read the latest beat. */
export function shopCue(event: ShopEvent): string {
    return event.type === "reject" ? `reject-${event.reason}` : event.type;
}

export function shopSound(event: ShopEvent): SoundKind | null {
    switch (event.type) {
        case "arrive": return event.referral || event.returning ? "golden" : "start";
        case "ask": case "offer": return "tick";
        case "counter": return "hit";
        case "reject": return event.reason === "price" || event.reason === "fit" ? "wrong" : null;
        case "capBlocked": return "break";
        case "deal": return "seal";
        case "close": return "guard";
        case "finished": return "end";
    }
}

/** A bid is still a price objection, so it shakes its head too; a cap block keeps the customer still and marks the counter instead. */
export function shopGesture(event: ShopEvent): ShopGesture | null {
    if (event.type === "counter") return "price";
    if (event.type === "close") return "farewell";
    if (event.type !== "reject" || event.reason === "need") return null;
    return event.reason === "done" ? "farewell" : event.reason;
}

/** A duration as the tier may spend it: unchanged for a player, clipped to the light ceiling for a watched agent. */
export function tierMs(ms: number, tier: MotionTier): number {
    return tier === "light" ? Math.min(ms, LIGHT_MS) : ms;
}

/** The auto leave, shortened with the speed like the transition it ends. */
export function shopLeaveMs(speed: number): number {
    return SHOP_LEAVE_MS / speed;
}

/** How far the cash cell moves on a deal: the seller banks the takings, the buyer's remaining cap drops by the price. */
export function shopCashSwing(event: Extract<ShopEvent, {type: "deal"}>, seller: boolean): number {
    return seller ? event.cashDelta : -event.receipt.price;
}

/** Bigger sales throw more coins, three to five. */
export function shopCoinCount(price: number): number {
    return Math.min(SHOP_COIN_SLOTS, Math.max(3, Math.ceil(price / 4)));
}

/** The deal's timeline in ms, or null under reduced motion (the seal and the total are simply there). A watched agent gets the seal and the count only. */
export type ShopDealPlan = {hop: number; sealSound: number; coins: number; coinStart: number; coinGap: number; coinFlight: number; count: number};
export function shopDealPlan(tier: MotionTier, speed: number, price: number): ShopDealPlan | null {
    if (tier === "still") return null;
    if (tier === "light") return {hop: 0, sealSound: LIGHT_SEAL_SOUND, coins: 0, coinStart: 0, coinGap: 0, coinFlight: 0, count: LIGHT_MS};
    return {hop: DEAL.hop / speed, sealSound: DEAL.sealSound / speed, coins: shopCoinCount(price), coinStart: DEAL.coinStart / speed, coinGap: DEAL.coinGap / speed, coinFlight: DEAL.coinFlight / speed, count: DEAL.count / speed};
}

/** When the deal's last motion settles: the count starts as the first coin lands (at once without coins). */
export function shopDealEnd(plan: ShopDealPlan): number {
    const landed = plan.coins ? plan.coinStart + plan.coinFlight : 0;
    return Math.max(plan.hop, plan.sealSound, plan.coins ? plan.coinStart + (plan.coins - 1) * plan.coinGap + plan.coinFlight : 0, landed + plan.count);
}

/** The offer's timeline in ms for this many goods, or null under reduced motion (the goods are simply there). */
export type ShopOfferPlan = {gap: number; item: number; tag: number; tagMs: number; line: number; lineMs: number};
export function shopOfferPlan(tier: MotionTier, speed: number, goods: number): ShopOfferPlan | null {
    if (tier === "still") return null;
    if (tier === "light") return {gap: 0, item: LIGHT_OFFER_MS, tag: 0, tagMs: LIGHT_OFFER_MS, line: 0, lineMs: LIGHT_OFFER_MS};
    const tag = (Math.max(goods - 1, 0) * OFFER.gap + OFFER.tagAfter) / speed;
    return {gap: OFFER.gap / speed, item: OFFER.item / speed, tag, tagMs: OFFER.tag / speed, line: tag + OFFER.lineAfter / speed, lineMs: OFFER.line / speed};
}

/** When the offer has fully landed: the last good, the tag, and the underline when it is final. */
export function shopOfferEnd(plan: ShopOfferPlan, goods: number, final: boolean): number {
    return Math.max(goods ? (goods - 1) * plan.gap + plan.item : 0, plan.tag + plan.tagMs, final ? plan.line + plan.lineMs : 0);
}

const round = (n: number) => +n.toFixed(1);
/** A spinning coin's arc from one point to another, sampled so linear steps between frames trace the parabola. Points are the sprite's top-left corner. */
export function coinPath(from: {x: number; y: number}, to: {x: number; y: number}, steps = 12): Keyframe[] {
    const lift = Math.max(48, Math.hypot(to.x - from.x, to.y - from.y) * .35);
    return Array.from({length: steps + 1}, (_, i) => {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t - lift * 4 * t * (1 - t);
        return {transform: `translate(${round(x)}px, ${round(y)}px) rotate(${round(540 * t)}deg) scale(${round(1 - .25 * t)})`, opacity: i === 0 || i === steps ? 0 : 1};
    });
}

/** The parts of the scene a beat may move, found once per render by ShopGame. */
export type ShopScene = {stage: HTMLElement; guest: HTMLElement | null; edge: HTMLElement | null; coins: HTMLElement | null; cash: HTMLElement | null; table: HTMLElement | null; shown: number; seller: boolean; speed: number};

/** An end's centre, held inside the viewport: a player's scroll parks the scoreboard just above it, so coins fly off (or drop in) at its edge, toward it. */
const centre = (rect: DOMRect, y = .5) => ({x: rect.left + rect.width / 2, y: Math.min(Math.max(rect.top + rect.height * y, 0), window.innerHeight)});
/** Throws the coins on the fixed layer, measuring each end once per deal. */
function throwCoins(layer: HTMLElement, from: Element, to: Element, plan: ShopDealPlan, tier: MotionTier): Animation[] {
    const sprites = Array.from(layer.children).slice(0, plan.coins) as HTMLElement[];
    if (!sprites.length) return [];
    const box = layer.getBoundingClientRect(), start = from.getBoundingClientRect(), end = to.getBoundingClientRect();
    const half = sprites[0]!.offsetWidth / 2;
    const a = centre(start, .45), b = centre(end);
    return sprites.flatMap((coin, i) => {
        const spread = i - (sprites.length - 1) / 2;
        const path = coinPath({x: a.x - box.left - half + spread * 12, y: a.y - box.top - half}, {x: b.x - box.left - half + spread * 3, y: b.y - box.top - half});
        return play(coin, path, {id: "shop-coin", duration: plan.coinFlight, delay: plan.coinStart + i * plan.coinGap}, {tier}) ?? [];
    });
}

/** Rolling cash counters, so pause can hold them: their clocks have no element for `getAnimations` to find. */
const clocks = new Set<Animation>();
const rolls = new WeakMap<Node, object>();
/**
 * The deal: hop, seal sound, coins from the customer to the cash cell (from the purse to the counter when buying), then the count and a gold flash.
 * The number node is `aria-hidden` and React has already written the final total; it shows the old total until the count begins.
 */
function playDeal(event: Extract<ShopEvent, {type: "deal"}>, scene: ShopScene, tier: MotionTier, sound: ArcadeSound) {
    const plan = shopDealPlan(tier, scene.speed, event.receipt.price);
    sound.play("seal", 0, plan?.sealSound ?? 0);
    if (!plan) return;
    if (plan.hop && scene.guest) play(scene.guest, DEAL_HOP, {id: "shop-gesture", duration: plan.hop, easing: "out", composite: "add"}, {tier});
    const cell = scene.cash, count = cell?.querySelector<HTMLElement>("[data-roll]");
    if (!cell || !count) return;
    const to = scene.shown, from = to - shopCashSwing(event, scene.seller), token = {};
    rolls.set(count, token);
    count.textContent = String(from);
    const roll = () => {
        const clock = countUp(count, to, {tier}, {from, ms: plan.count, format: n => String(Math.round(n))});
        if (clock) {
            clocks.add(clock);
            clock.finished.finally(() => clocks.delete(clock)).catch(() => {});
        }
        if (tier === "full") flash(cell, GOLD, {tier}, GOLD_FLASH_MS);
    };
    const [origin, target] = scene.seller ? [scene.guest, count] : [count, scene.edge?.querySelector("b") ?? scene.edge];
    const [first] = plan.coins && scene.coins && origin && target ? throwCoins(scene.coins, origin, target, plan, tier) : [];
    if (!first) return roll();
    first.finished.then(() => {
        if (rolls.get(count) !== token) return;
        sound.play("coin");
        roll();
    }, () => { if (rolls.get(count) === token) count.textContent = String(to); });
}

/**
 * An offer handed across the counter. The goods and tag are already rendered at rest; `fill: backwards` hides each until its turn.
 * Only the table that shows the offer moves: a player who answers it sees it in their own controls, which enter on mount.
 */
function playOffer(event: Extract<ShopEvent, {type: "offer"}>, table: HTMLElement, tier: MotionTier, speed: number) {
    const goods = Array.from(table.querySelectorAll<HTMLElement>(".shop-offered-goods>div")), tag = table.querySelector<HTMLElement>(".shop-price-tag");
    const plan = shopOfferPlan(tier, speed, goods.length);
    if (!plan) return;
    goods.forEach((good, i) => play(good, SET_DOWN, {id: "shop-offer", duration: plan.item, delay: i * plan.gap, easing: "back", fill: "backwards"}, {tier}));
    if (!tag) return;
    play(tag, TAG_SWING, {id: "shop-offer", duration: plan.tagMs, delay: plan.tag, easing: "out", fill: "backwards"}, {tier});
    if (!event.final) return;
    play(tag, INK_LINE, {id: "shop-offer-line", duration: plan.lineMs, delay: plan.line, easing: "ink", fill: "backwards", pseudoElement: "::after"}, {tier});
    const note = table.querySelector(".shop-final-note");
    if (note) play(note, [{opacity: 0}, {opacity: 1}], {id: "shop-offer", duration: plan.lineMs, delay: plan.line, easing: "out", fill: "backwards"}, {tier});
}

/** Marks the stage with the beat, then plays its sound and body language. A hidden tab gets the mark only. */
export function playShopEvent(event: ShopEvent, scene: ShopScene, tier: MotionTier, sound: ArcadeSound) {
    const {stage, guest, edge} = scene;
    stage.dataset.cue = shopCue(event);
    stage.dataset.cueSeq = String(Number(stage.dataset.cueSeq ?? 0) + 1);
    if (document.hidden) return;
    if (event.type === "deal") return playDeal(event, scene, tier, sound);
    if (event.type === "offer" && scene.table) playOffer(event, scene.table, tier, scene.speed);
    const kind = shopSound(event);
    if (kind) sound.play(kind);
    const gesture = shopGesture(event);
    if (gesture && guest) play(guest, SHOP_GESTURES[gesture].keyframes, {id: "shop-gesture", duration: tierMs(SHOP_GESTURES[gesture].ms, tier), easing: SHOP_GESTURES[gesture].easing, composite: "add"}, {tier});
    if (event.type === "capBlocked" && edge) flash(edge, LIMIT_RED, {tier}, tierMs(LIMIT_FLASH_MS, tier));
}

/** A player's customer steps out before the next one comes in. Resolves at once under reduced motion or when nothing could play. */
export function leaveShopGuest(guest: HTMLElement | null, tier: MotionTier): Promise<void> {
    if (!guest || tier === "still") return Promise.resolve();
    const animation = play(guest, LEAVE, {id: "shop-leave", duration: tierMs(HUMAN_LEAVE_MS, tier), easing: "in", fill: "forwards"}, {tier});
    return animation ? animation.finished.then(() => {}, () => {}) : Promise.resolve();
}

/** Pause holds scripted effects mid-gesture and resumes them in place; CSS animations follow `[data-halted]` on their own. */
export function haltShopFx(root: Element, halted: boolean) {
    for (const animation of [...root.getAnimations({subtree: true}), ...clocks]) {
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        if (halted && animation.playState === "running") animation.pause();
        else if (!halted && animation.playState === "paused") animation.play();
    }
}
