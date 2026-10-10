import {afterEach, describe, expect, test} from "bun:test";
import {createElement} from "react";
import {renderToString} from "react-dom/server";
import {motionTier, swapScreen, useArcadeMotion} from "./motion";

describe("motionTier", () => {
    test("reduced motion wins over watching an agent", () => {
        expect(motionTier({still: true, watched: true})).toBe("still");
        expect(motionTier({still: true, watched: false})).toBe("still");
    });
    test("a watched agent run keeps feedback but drops ceremony", () => expect(motionTier({still: false, watched: true})).toBe("light"));
    test("a human round gets the full motion", () => expect(motionTier({still: false, watched: false})).toBe("full"));
});

describe("useArcadeMotion", () => {
    // The arcade route is server-rendered, where there is no matchMedia and no OS preference to read.
    function Shell({setting}: {setting: boolean}) { return createElement("p", null, String(useArcadeMotion(setting))); }
    test("server rendering assumes motion and still honours the player's setting", () => {
        expect(renderToString(createElement(Shell, {setting: false}))).toBe("<p>false</p>");
        expect(renderToString(createElement(Shell, {setting: true}))).toBe("<p>true</p>");
    });
});

describe("swapScreen", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    afterEach(() => {
        if (original) Object.defineProperty(globalThis, "document", original);
        else delete (globalThis as {document?: unknown}).document;
    });
    // A browser stand-in: records the transition and runs its update when the test says the old screen is captured.
    function browser({hidden = false, api = true}: {hidden?: boolean; api?: boolean} = {}) {
        const pending: (() => void)[] = [];
        const doc: Record<string, unknown> = {hidden};
        if (api) doc.startViewTransition = (update: () => void) => {
            pending.push(update);
            return {ready: Promise.reject(new Error("skipped"))};
        };
        Object.defineProperty(globalThis, "document", {value: doc, configurable: true, writable: true});
        return pending;
    }
    test("a moving screen changes inside the view transition, once the old screen is captured", () => {
        const pending = browser();
        let screen = "play";
        swapScreen(false, () => {screen = "result";});
        expect(screen).toBe("play");
        expect(pending).toHaveLength(1);
        pending[0]!();
        expect(screen).toBe("result");
    });
    test("reduced motion, a hidden tab or a browser without the API swap at once", () => {
        for (const [still, setup] of [[true, {}], [false, {hidden: true}], [false, {api: false}]] as const) {
            const pending = browser(setup);
            let screen = "play";
            swapScreen(still, () => {screen = "result";});
            expect(screen).toBe("result");
            expect(pending).toHaveLength(0);
        }
    });
});
