import type {ShopEvent, ShopState} from "@mapae/arcade/shop";
import {flash, play} from "../juice";
import type {MotionTier} from "../motion";
import type {ArcadeSound, SoundKind} from "../sound";

/** juice's light ceiling: a watched agent's next beat comes 1050ms later at 1×, 525ms at 2×, so no gesture may run past this. */
const LIGHT_MS = 300;
const LIMIT_RED = "#b8402f";
/** One red pulse over the counter edge when the owner's cap stops a purchase. */
const LIMIT_FLASH_MS = 320;

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

/** Marks the stage with the beat, then plays its sound and body language. A hidden tab gets the mark only. */
export function playShopEvent(event: ShopEvent, {stage, guest, edge}: {stage: HTMLElement; guest: HTMLElement | null; edge: HTMLElement | null}, tier: MotionTier, sound: ArcadeSound) {
    stage.dataset.cue = shopCue(event);
    stage.dataset.cueSeq = String(Number(stage.dataset.cueSeq ?? 0) + 1);
    if (document.hidden) return;
    const kind = shopSound(event);
    if (kind) sound.play(kind);
    const gesture = shopGesture(event);
    if (gesture && guest) play(guest, SHOP_GESTURES[gesture].keyframes, {id: "shop-gesture", duration: tierMs(SHOP_GESTURES[gesture].ms, tier), easing: SHOP_GESTURES[gesture].easing, composite: "add"}, {tier});
    if (event.type === "capBlocked" && edge) flash(edge, LIMIT_RED, {tier}, tierMs(LIMIT_FLASH_MS, tier));
}

/** Pause holds scripted effects mid-gesture and resumes them in place; CSS animations follow `[data-halted]` on their own. */
export function haltShopFx(root: Element, halted: boolean) {
    for (const animation of root.getAnimations({subtree: true})) {
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        if (halted && animation.playState === "running") animation.pause();
        else if (!halted && animation.playState === "paused") animation.play();
    }
}
