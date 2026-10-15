import {FAUCET_MISSIONS} from "@mapae/delegation/faucet-policy";
import {describe, expect, test} from "bun:test";
import {FAUCET_PAGE_ERRORS} from "./client";
import {ERROR_COPY, FAUCET_COPY, formatAmount, formatWait, MISSION_COPY, TESTNET_TOKEN} from "./copy";

describe("faucet copy", () => {
    test("amounts read as short decimals in each kind's units", () => {
        expect(formatAmount("1000000000", "musdc")).toBe("1000");
        expect(formatAmount(1_500_000n, "musdc")).toBe("1.5");
        expect(formatAmount("5000000000000000", "eth")).toBe("0.005");
        expect(formatAmount(0n, "eth")).toBe("0");
    });

    test("a wait reads to the minute, drops minutes once it spans days, and never says zero", () => {
        expect(formatWait((3 * 60 + 12) * 60_000, "ko")).toBe("3시간 12분");
        expect(formatWait((3 * 60 + 12) * 60_000, "en")).toBe("3 h 12 min");
        expect(formatWait((6 * 1440 + 2 * 60 + 5) * 60_000, "ko")).toBe("6일 2시간");
        expect(formatWait(1_000, "en")).toBe("1 min");
        expect(formatWait(-5_000, "ko")).toBe("1분");
    });

    test("every error the page can hold has a sentence in both languages", () => {
        for (const code of FAUCET_PAGE_ERRORS) {
            expect(ERROR_COPY[code].ko.length).toBeGreaterThan(0);
            expect(ERROR_COPY[code].en.length).toBeGreaterThan(0);
        }
    });

    test("every registered mission has a title and an action in both languages", () => {
        for (const id of Object.keys(FAUCET_MISSIONS) as (keyof typeof FAUCET_MISSIONS)[]) {
            expect(MISSION_COPY[id].ko.action.length).toBeGreaterThan(0);
            expect(MISSION_COPY[id].en.action.length).toBeGreaterThan(0);
        }
    });

    test("the test stablecoin is always named as testnet and not real money where an amount is promised", () => {
        expect(TESTNET_TOKEN.ko).toContain("실제 돈 아님");
        expect(TESTNET_TOKEN.en).toContain("not real money");
        for (const locale of ["ko", "en"] as const) {
            const t = FAUCET_COPY[locale];
            for (const line of [t.claimHint.musdc("1000"), t.successAmount.musdc("1000"), t.alreadyEnough.musdc("1000")]) {
                expect(line).toContain(TESTNET_TOKEN[locale]);
            }
            expect(t.subline).toMatch(/실제 돈이 아니에요|not real money/);
        }
    });

    test("the follow is named as the price in both languages", () => {
        for (const locale of ["ko", "en"] as const) {
            const t = FAUCET_COPY[locale];
            for (const line of [t.title + t.titleEnd, t.steps.missions, t.needMissions, t.followHero, t.price, MISSION_COPY.x_follow_mapae[locale].detail, ERROR_COPY.mission_incomplete[locale]]) {
                expect(line).toMatch(/@mapae_io|the price|값/);
            }
            for (const line of [t.title + t.titleEnd, t.steps.missions, t.needMissions, t.followHero, ERROR_COPY.mission_incomplete[locale]]) expect(line).toContain("@mapae_io");
            expect(t.intro).toMatch(/실제 돈이 아니에요|not real money/);
            expect(t.howTo.items[0]?.id).toBe("follow");
        }
    });
});
