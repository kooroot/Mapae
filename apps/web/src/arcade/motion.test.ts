import {describe, expect, test} from "bun:test";
import {motionTier} from "./motion";

describe("motionTier", () => {
    test("reduced motion wins over watching an agent", () => {
        expect(motionTier({still: true, watched: true})).toBe("still");
        expect(motionTier({still: true, watched: false})).toBe("still");
    });
    test("a watched agent run keeps feedback but drops ceremony", () => expect(motionTier({still: false, watched: true})).toBe("light"));
    test("a human round gets the full motion", () => expect(motionTier({still: false, watched: false})).toBe("full"));
});
