import {describe, expect, test} from "bun:test";
import {applyBuyerAction, applySellerAction, createShop, nextShopCustomer, type ShopEvent} from "@mapae/arcade/shop";
import {SHOP_GESTURES, shopCue, shopGesture, shopReaction, shopRefusal, shopSound, tierMs} from "./shop-fx";

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
        expect(all.map(shopSound)).toEqual(["start", "golden", "tick", "tick", "hit", "wrong", "wrong", null, null, "break", "seal", "guard", "end"]);
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
            expect(tierMs(ms, "light")).toBeLessThanOrEqual(300);
            expect(tierMs(ms, "light")).toBeLessThan(twoTimesBeat);
            expect(tierMs(ms, "full")).toBe(ms);
            expect(tierMs(ms, "still")).toBe(ms);
        }
    });
});
