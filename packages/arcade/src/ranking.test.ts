import {describe, expect, test} from "bun:test";
import {dailyChallenge} from "./challenge";
import {ARCADE_RULESET_VERSION} from "./contracts";
import {
    addDays, fnv1a, guardianStreak, kstDay, kstWeek, nextReset, parseRankingIds, rankedSeed, titlePlace,
    validRankedAttempt, validRankingBoard,
} from "./ranking";

describe("KST windows", () => {
    test("the day turns at 00:00 KST, which is 15:00 UTC", () => {
        expect(kstDay(Date.parse("2026-10-04T14:59:59.999Z"))).toBe("2026-10-04");
        expect(kstDay(Date.parse("2026-10-04T15:00:00Z"))).toBe("2026-10-05");
        expect(() => kstDay(NaN)).toThrow();
    });
    test("the week starts Monday 00:00 KST", () => {
        // 2026-10-11 is a Sunday; 2026-10-12 a Monday.
        const sundayLate = Date.parse("2026-10-11T14:59:00Z"), mondayStart = Date.parse("2026-10-11T15:00:00Z");
        expect(kstWeek(kstDay(sundayLate))).toBe("2026-10-05");
        expect(kstWeek(kstDay(mondayStart))).toBe("2026-10-12");
        expect(kstWeek("2026-10-12")).toBe("2026-10-12");
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
        expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
        expect(() => addDays("2026-02-30", 1)).toThrow();
    });
    test("next reset is the next KST midnight, or the next KST Monday", () => {
        const at = Date.parse("2026-10-08T03:00:00Z"); // Thursday 12:00 KST
        expect(nextReset(at, "day")).toBe(Date.parse("2026-10-08T15:00:00Z"));
        expect(nextReset(at, "week")).toBe(Date.parse("2026-10-11T15:00:00Z"));
        expect(nextReset(Date.parse("2026-10-11T15:00:00Z"), "week")).toBe(Date.parse("2026-10-18T15:00:00Z"));
    });
});

describe("ranked seeds", () => {
    test("deterministic uint32, distinct by attempt, token, game, day and ruleset, and not the shared daily course", () => {
        const base = rankedSeed("race", "2026-10-10", 1, "7");
        expect(rankedSeed("race", "2026-10-10", 1, "7")).toBe(base);
        expect(Number.isInteger(base) && base >= 0 && base <= 0xffff_ffff).toBe(true);
        const variants = [rankedSeed("race", "2026-10-10", 2, "7"), rankedSeed("race", "2026-10-10", 1, "8"), rankedSeed("shop", "2026-10-10", 1, "7"),
            rankedSeed("race", "2026-10-11", 1, "7"), fnv1a(`${ARCADE_RULESET_VERSION + 1}:ranked:2026-10-10:race:1:7`)];
        expect(new Set([base, ...variants]).size).toBe(6);
        expect(base).toBe(fnv1a(`${ARCADE_RULESET_VERSION}:ranked:2026-10-10:race:1:7`));
        expect(base).not.toBe(dailyChallenge("race", Date.parse("2026-10-10T03:00:00Z")).seed);
    });
    test("rejects attempts outside the daily three and malformed inputs", () => {
        for (const args of [["race", "2026-10-10", 0, "1"], ["race", "2026-10-10", 4, "1"], ["race", "2026-13-01", 1, "1"], ["race", "2026-10-10", 1, "01"], ["race", "2026-10-10", 1, "10001"], ["golf", "2026-10-10", 1, "1"]] as const) {
            expect(() => rankedSeed(...(args as unknown as Parameters<typeof rankedSeed>))).toThrow();
        }
        expect(validRankedAttempt({day: "2026-10-10", attempt: 3})).toBe(true);
        for (const v of [{day: "2026-10-10", attempt: 4}, {day: "2026-10-10"}, {day: "x", attempt: 1}, {day: "2026-10-10", attempt: 1, extra: 1}, null]) expect(validRankedAttempt(v)).toBe(false);
    });
});

describe("request shapes", () => {
    test("boards pair games with day/week windows and devotion with 28 days", () => {
        expect(validRankingBoard("stamp", "today")).toBe(true);
        expect(validRankingBoard("shop", "lastweek")).toBe(true);
        expect(validRankingBoard("devotion", "28d")).toBe(true);
        expect(validRankingBoard("devotion", "today")).toBe(false);
        expect(validRankingBoard("race", "28d")).toBe(false);
        expect(validRankingBoard("xp", "today")).toBe(false);
    });
    test("standing ids are one to three ascending unique guardians", () => {
        expect(parseRankingIds("1,20,300")).toEqual(["1", "20", "300"]);
        for (const v of ["", "0", "01", "2,1", "1,1", "1,2,3,4", "10001", "1,,2", "1 ,2"]) expect(parseRankingIds(v)).toBeNull();
    });
});

describe("guardian streak", () => {
    const today = "2026-10-20";
    const run = (from: string, length: number) => Array.from({length}, (_, i) => addDays(from, i));
    test("no ranked day yet is an empty book", () => {
        expect(guardianStreak([], today)).toEqual({current: 0, best: 0, freezes: 0, playedToday: false});
    });
    test("consecutive days count, and an unplayed today does not break the run", () => {
        expect(guardianStreak(run("2026-10-17", 4), today)).toEqual({current: 4, best: 4, freezes: 0, playedToday: true});
        expect(guardianStreak(run("2026-10-17", 3), today)).toEqual({current: 3, best: 3, freezes: 0, playedToday: false});
    });
    test("a missed day without a rest day ends the run, but best remembers it", () => {
        expect(guardianStreak([...run("2026-10-10", 5), "2026-10-19", "2026-10-20"], today)).toEqual({current: 2, best: 5, freezes: 0, playedToday: true});
        expect(guardianStreak(run("2026-10-10", 5), today)).toEqual({current: 0, best: 5, freezes: 0, playedToday: false});
    });
    test("seven played days earn a rest day that covers a miss without adding to the run", () => {
        const days = [...run("2026-10-10", 7), ...run("2026-10-18", 3)]; // 10-17 missed
        expect(guardianStreak(days, today)).toEqual({current: 10, best: 10, freezes: 0, playedToday: true});
    });
    test("rest days cap at two", () => {
        expect(guardianStreak(run("2026-09-01", 28), "2026-09-28").freezes).toBe(2);
        // Two misses after 21 days: both covered, a third ends the run.
        const days = [...run("2026-09-01", 21), "2026-09-24"];
        expect(guardianStreak(days, "2026-09-24")).toMatchObject({current: 22, freezes: 0});
        expect(guardianStreak([...run("2026-09-01", 21), "2026-09-25"], "2026-09-25")).toMatchObject({current: 1, best: 21});
    });
    test("days after today are ignored", () => {
        expect(guardianStreak(["2026-10-21"], today)).toEqual({current: 0, best: 0, freezes: 0, playedToday: false});
    });
});

test("weekly titles: champion, podium, top ten", () => {
    expect([1, 2, 3, 4, 10, 11, 0].map(titlePlace)).toEqual(["champion", "podium", "podium", "top10", "top10", null, null]);
});
