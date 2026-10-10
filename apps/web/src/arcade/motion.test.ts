import {describe, expect, test} from "bun:test";
import {createElement} from "react";
import {renderToString} from "react-dom/server";
import {motionTier, useArcadeMotion} from "./motion";

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
