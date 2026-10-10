import {describe, expect, test} from "bun:test";
import {applyBuyerAction, applySellerAction, createShop, DEFAULT_SHOP_CONFIG, nextShopCustomer, ruleBuyerAction, ruleSellerAction, shopBuyerObservation, shopEvents,
    shopSellerObservation, type ShopConfig, type ShopEvent, type ShopState} from "@mapae/arcade/shop";
import {coinPath, SHOP_COIN_SLOTS, SHOP_GESTURES, SHOP_LEAVE_MS, SHOP_TRANSITION_MS, SHOP_TURN_MS, shopCashSwing, shopCoinCount, shopCue, shopDealEnd, shopDealPlan, shopGesture, shopLeaveMs,
    shopOfferEnd, shopOfferPlan, shopReaction, shopRefusal, shopSound} from "./shop-fx";
import {ceremonyMs} from "../juice";

const heard = () => applyBuyerAction(createShop(32), {type: "request", wants: ["water"], reason: "need"});
const offered = (price = 3) => applySellerAction(heard(), {type: "offer", items: [{id: "water", quantity: 1}], price, message: "For you"});
const reasons = ["price", "fit", "need", "done"] as const;

describe("shop reactions", () => {
    test("only price, fit and a cap block wear the refusal face", () => {
        const faces = Object.fromEntries(reasons.map(reason => [reason, shopReaction(applyBuyerAction(offered(), {type: "decline", reason}))]));
        expect(faces).toEqual({price: "price", fit: "fit", need: null, done: "farewell"});
        expect(reasons.filter(reason => shopRefusal(faces[reason]!))).toEqual(["price", "fit"]);
        const capped = offered(99);
        expect(shopReaction(applyBuyerAction(capped, {type: "buy", reason: "need"}))).toBe("blocked");
        expect(shopRefusal("blocked")).toBe(true);
    });

    test("a customer restating a need after an offer is not declining", () => {
        const restated = applyBuyerAction(offered(), {type: "request", reason: "need"});
        expect(restated.lastOffer).not.toBeNull();
        expect(shopReaction(restated)).toBeNull();
    });

    test("a sale is happy, a seller's close is a goodbye, and a fresh customer shows nothing", () => {
        expect(shopReaction(applyBuyerAction(offered(), {type: "buy", reason: "need"}))).toBe("happy");
        const closed = applySellerAction(heard(), {type: "close", message: "Sold out"});
        expect(shopReaction(closed)).toBe("farewell");
        expect(shopReaction(nextShopCustomer(closed))).toBeNull();
        expect(shopReaction(createShop(32))).toBeNull();
    });
});

describe("shop event cues", () => {
    const receipt = applyBuyerAction(offered(), {type: "buy", reason: "need"}).receipts[0]!;
    const all: ShopEvent[] = [{type: "arrive", referral: false, returning: false}, {type: "arrive", referral: true, returning: false}, {type: "ask"},
        {type: "offer", tactic: null, final: false}, {type: "counter", price: 3}, ...reasons.map(reason => ({type: "reject" as const, reason})),
        {type: "capBlocked"}, {type: "deal", receipt, cashDelta: 3}, {type: "close"}, {type: "finished"}];

    test("each beat has a distinct readable cue, rejects named by reason", () => {
        expect(all.map(shopCue)).toEqual(["arrive", "arrive", "ask", "offer", "counter", "reject-price", "reject-fit", "reject-need", "reject-done", "capBlocked", "deal", "close", "finished"]);
    });

    test("sounds mark refusals, the stamp and the close of market; a restated need stays quiet", () => {
        expect(all.map(shopSound)).toEqual(["start", "golden", "tick", "tick", "hit", "wrong", "wrong", null, null, "break", "seal", "guard", null]);
    });

    test("gestures follow the reason table and a cap block leaves the customer still", () => {
        expect(all.map(shopGesture)).toEqual([null, null, null, null, "price", "price", "fit", null, "farewell", null, null, "farewell", null]);
    });
});

describe("shop gesture timing", () => {
    test("gestures match the motion plan and land back at rest", () => {
        expect(SHOP_GESTURES.price.keyframes.map(frame => frame.transform)).toEqual(["translateX(0px)", "translateX(-6px)", "translateX(5px)", "translateX(-3px)", "translateX(0px)"]);
        expect(SHOP_GESTURES.fit.keyframes.map(frame => frame.transform)).toEqual(["rotate(0deg)", "rotate(4deg)", "rotate(-2deg)", "rotate(0deg)"]);
        for (const gesture of Object.values(SHOP_GESTURES)) expect(gesture.keyframes.at(-1)).toEqual(gesture.keyframes[0]!);
        expect([SHOP_GESTURES.price.ms, SHOP_GESTURES.fit.ms]).toEqual([380, 460]);
    });

    test("a watched agent's gestures fit inside its 2× beat; players and still keep the authored length", () => {
        const twoTimesBeat = 1050 / 2;
        for (const {ms} of Object.values(SHOP_GESTURES)) {
            expect(ceremonyMs("light", ms)).toBeLessThanOrEqual(300);
            expect(ceremonyMs("light", ms)).toBeLessThan(twoTimesBeat);
            expect(ceremonyMs("full", ms)).toBe(ms);
            expect(ceremonyMs("still", ms)).toBe(ms);
        }
    });
});

/** Plays a whole market by the rules and returns every deal with the cash cell's value either side of it. */
function deals(seed: number, role: ShopConfig["role"]) {
    const shown = (state: ShopState) => role === "seller" ? state.cash : state.buyers[state.customer]!.cap - state.buyers[state.customer]!.spent;
    const found: {event: Extract<ShopEvent, {type: "deal"}>; before: number; after: number}[] = [];
    let state = createShop(seed, {...DEFAULT_SHOP_CONFIG, role});
    while (state.phase !== "finished") {
        const next = state.phase === "transition" ? nextShopCustomer(state) : state.phase === "seller" ? applySellerAction(state, ruleSellerAction(shopSellerObservation(state), "en"))
            : applyBuyerAction(state, ruleBuyerAction(shopBuyerObservation(state)));
        for (const event of shopEvents(state, next)) if (event.type === "deal") found.push({event, before: shown(state), after: shown(next)});
        state = next;
    }
    return found;
}

describe("shop deal timeline", () => {
    test("the cash cell rolls from the old total to the new one in both roles", () => {
        for (const role of ["seller", "buyer"] as const) {
            const all = Array.from({length: 30}, (_, seed) => deals(seed + 1, role)).flat();
            expect(all.length).toBeGreaterThan(0);
            for (const {event, before, after} of all) expect(after - shopCashSwing(event, role === "seller")).toBe(before);
        }
    });

    test("a player's deal settles before the walk-out at either speed", () => {
        for (const speed of [1, 2]) for (const price of [1, 6, 14, 40]) {
            const plan = shopDealPlan("full", speed, price)!;
            expect(plan.coins).toBe(shopCoinCount(price));
            expect(shopDealEnd(plan)).toBeLessThanOrEqual((SHOP_TRANSITION_MS - SHOP_LEAVE_MS) / speed);
        }
    });

    test("three to five coins, never more than the layer holds", () => {
        expect([1, 12, 13, 16, 17, 20, 99].map(shopCoinCount)).toEqual([3, 3, 4, 4, 5, 5, 5]);
        expect(shopCoinCount(99)).toBe(SHOP_COIN_SLOTS);
    });

    test("a watched agent's deal is the seal and the count, within the light ceiling; reduced motion plans nothing", () => {
        const plan = shopDealPlan("light", 2, 14)!;
        expect([plan.coins, plan.hop]).toEqual([0, 0]);
        expect(shopDealEnd(plan)).toBeLessThanOrEqual(300);
        expect(shopDealPlan("still", 1, 14)).toBeNull();
    });

    test("the auto walk-out shrinks with speed and fits its transition", () => {
        expect([shopLeaveMs(1), shopLeaveMs(2)]).toEqual([380, 190]);
        for (const speed of [1, 2]) expect(shopLeaveMs(speed)).toBeLessThan(SHOP_TRANSITION_MS / speed);
    });
});

describe("offer hand-over", () => {
    test("goods land one by one, then the tag, then a final offer's underline", () => {
        const plan = shopOfferPlan("full", 1, 3)!;
        expect(plan.gap).toBe(70);
        expect(plan.item).toBe(300);
        expect(plan.tag).toBeGreaterThan(2 * plan.gap);
        expect(plan.line).toBeGreaterThan(plan.tag);
        expect(shopOfferEnd(plan, 3, true)).toBe(plan.line + plan.lineMs);
    });
    test("the whole hand-over fits 350ms at 2× and the turn at either speed", () => {
        for (const goods of [0, 1, 2, 3]) for (const final of [false, true]) {
            expect(shopOfferEnd(shopOfferPlan("full", 2, goods)!, goods, final)).toBeLessThanOrEqual(350);
            for (const speed of [1, 2]) expect(shopOfferEnd(shopOfferPlan("full", speed, goods)!, goods, final)).toBeLessThan(SHOP_TURN_MS / speed);
        }
    });
    test("a watched agent's offer lands at once within the light ceiling; reduced motion plans nothing", () => {
        for (const speed of [1, 2]) {
            const plan = shopOfferPlan("light", speed, 3)!;
            expect(plan.gap).toBe(0);
            expect(shopOfferEnd(plan, 3, true)).toBeLessThanOrEqual(300);
        }
        expect(shopOfferPlan("still", 1, 3)).toBeNull();
    });
});

describe("coin flight", () => {
    const from = {x: 40, y: 300}, to = {x: 260, y: 20};
    const path = coinPath(from, to);
    const points = path.map(frame => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(frame.transform))!.slice(1).map(Number));

    test("leaves and lands on the given points, fading in and out", () => {
        expect(points[0]).toEqual([from.x, from.y]);
        expect(points.at(-1)).toEqual([to.x, to.y]);
        expect([path[0]!.opacity, path[1]!.opacity, path.at(-1)!.opacity]).toEqual([0, 1, 0]);
    });

    test("arcs above the straight line and spins one and a half turns", () => {
        const middle = points[6]!;
        expect(middle[1]).toBeLessThan((from.y + to.y) / 2);
        expect(String(path.at(-1)!.transform)).toContain("rotate(540deg)");
    });
});
