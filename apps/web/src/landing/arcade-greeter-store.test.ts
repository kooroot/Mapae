import {afterEach, describe, expect, test} from "bun:test";
import {ZODIACS} from "../arcade/guardian";
import {pickGuest, welcomeGuest} from "./arcade-greeter-store";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

describe("homepage arcade guests", () => {
    test("every guardian can visit, excluding exactly the previous guest", () => {
        for (const previous of [null, ...ZODIACS]) {
            const candidates = ZODIACS.filter(z => z !== previous);
            const picked = candidates.map((_, roll) => pickGuest(roll, previous));
            expect(new Set(picked)).toEqual(new Set(candidates));
            expect(picked).not.toContain(previous);
            expect(candidates).toContain(pickGuest(0xffffffff, previous));
        }
    });

    test("unknown stored values cannot become an asset name or narrow the catalog", () => {
        for (const previous of ["../../private", '{"privateKey":"secret"}', "", "HORSE"]) {
            expect(ZODIACS.map((_, roll) => pickGuest(roll, previous))).toEqual([...ZODIACS]);
        }
    });

    test("successive visits persist only a zodiac enum and never repeat immediately", () => {
        let previous = "horse";
        const writes: string[][] = [];
        Object.defineProperty(globalThis, "window", {configurable: true, value: {sessionStorage: {
            getItem: () => previous,
            setItem: (key: string, value: string) => {writes.push([key, value]); previous = value;},
        }}});
        for (let i = 0; i < 100; i++) {
            const last = previous;
            const guest = welcomeGuest();
            expect(guest).not.toBe(last);
            expect(ZODIACS).toContain(guest);
            expect(writes.at(-1)).toEqual(["mapae.arcade.last-greeter", guest]);
        }
    });

    test("blocked storage does not prevent a guest or an arcade entry", () => {
        Object.defineProperty(globalThis, "window", {configurable: true, value: {
            get sessionStorage() {throw new Error("Storage denied");},
        }});
        expect(ZODIACS).toContain(welcomeGuest());
    });
});
