import {describe, expect, test} from "bun:test";
import {addDays, streakProgress} from "./ranking";
import {
    SEASON, SEASON_MAX_DAY_POINTS, seasonClosesAt, seasonCountdown, seasonDayPoints, seasonDaysLeft, seasonPeriod, seasonPhase, seasonStatus, seasonStreak, seasonWindow,
    validSeason, type Season,
} from "./season";

const season: Season = {id: 1, start: "2026-11-02", end: "2026-11-29"};
const run = (from: string, length: number) => Array.from({length}, (_, i) => addDays(from, i));

describe("season phases", () => {
    test("the shipped season is valid and, without dates, pending", () => {
        expect(validSeason(SEASON)).toBe(true); expect(seasonPeriod(SEASON)).toBe("s1");
        expect(seasonPhase(SEASON, "2026-11-10")).toBe("pending");
        expect(seasonWindow(SEASON, "2026-11-10")).toBeNull(); expect(seasonClosesAt(SEASON, "2026-11-10")).toBeNull();
        expect(seasonDaysLeft(SEASON, "2026-11-10")).toBe(0); expect(seasonCountdown(SEASON, "2026-11-10")).toBe(0);
    });
    test("announced before the start, open from the first day through the last, closed the day after", () => {
        expect(seasonPhase(season, "2026-11-01")).toBe("announced");
        expect(seasonPhase(season, "2026-11-02")).toBe("open");
        expect(seasonPhase(season, "2026-11-29")).toBe("open");
        expect(seasonPhase(season, "2026-11-30")).toBe("closed");
        expect(seasonStatus(season, Date.parse("2026-11-01T15:00:00Z"))).toEqual({id: 1, start: "2026-11-02", end: "2026-11-29", today: "2026-11-02", phase: "open"});
        expect(seasonStatus(season, Date.parse("2026-11-01T14:59:59Z")).phase).toBe("announced");
    });
    test("the window grows with the days and stops at the end; the close is 00:00 KST after the last day", () => {
        expect(seasonWindow(season, "2026-11-01")).toBeNull();
        expect(seasonWindow(season, "2026-11-02")).toEqual({from: "2026-11-02", to: "2026-11-02"});
        expect(seasonWindow(season, "2026-11-10")).toEqual({from: "2026-11-02", to: "2026-11-10"});
        expect(seasonWindow(season, "2026-12-25")).toEqual({from: "2026-11-02", to: "2026-11-29"});
        expect(seasonClosesAt(season, "2026-11-10")).toBe(Date.parse("2026-11-29T15:00:00Z"));
        expect(seasonClosesAt(season, "2026-11-30")).toBeNull(); expect(seasonClosesAt(season, "2026-11-01")).toBeNull();
    });
    test("days left count today; the countdown counts to the first day", () => {
        expect(seasonDaysLeft(season, "2026-11-02")).toBe(28); expect(seasonDaysLeft(season, "2026-11-29")).toBe(1); expect(seasonDaysLeft(season, "2026-11-30")).toBe(0);
        expect(seasonCountdown(season, "2026-11-01")).toBe(1); expect(seasonCountdown(season, "2026-10-20")).toBe(13); expect(seasonCountdown(season, "2026-11-02")).toBe(0);
    });
    test("a season needs a positive id and either no dates or two ranking days in order", () => {
        expect(validSeason(season)).toBe(true);
        for (const bad of [{id: 0, start: null, end: null}, {id: 1.5, start: null, end: null}, {id: 1, start: "2026-11-02", end: null}, {id: 1, start: null, end: "2026-11-29"},
            {id: 1, start: "2026-11-30", end: "2026-11-29"}, {id: 1, start: "2026-11-31", end: "2026-12-01"}, {id: 1, start: "2026-11-2", end: "2026-11-29"}]) expect(validSeason(bad)).toBe(false);
        expect(validSeason({id: 2, start: "2026-11-02", end: "2026-11-02"})).toBe(true);
    });
});

describe("season points", () => {
    test("places 1–3, the rest of the top ten, and everyone else; three wins make the daily maximum", () => {
        expect([1, 2, 3, 4, 7, 10, 11, 400].map(seasonDayPoints)).toEqual([10, 7, 5, 3, 3, 3, 1, 1]);
        expect(SEASON_MAX_DAY_POINTS).toBe(30);
    });
    test("every seventh day of a run completes one; a rest day keeps the run and a reset keeps the count", () => {
        expect(streakProgress([], "2026-11-10")).toMatchObject({current: 0, completed: 0});
        expect(streakProgress(run("2026-11-02", 7), "2026-11-08")).toMatchObject({current: 7, freezes: 1, completed: 1});
        expect(streakProgress(run("2026-11-02", 6), "2026-11-08")).toMatchObject({current: 6, completed: 0});
        // 2026-11-09 missed: the rest day earned on the seventh covers it, and the run reaches 14 on the 16th.
        expect(streakProgress([...run("2026-11-02", 7), ...run("2026-11-10", 7)], "2026-11-16")).toMatchObject({current: 14, completed: 2});
        // Two misses after seven days end the run; the completed count stays.
        expect(streakProgress([...run("2026-11-02", 7), ...run("2026-11-11", 3)], "2026-11-13")).toMatchObject({current: 3, completed: 1});
    });
    test("the season run counts only the season's days, so a run begun before the start is not carried in", () => {
        expect(seasonStreak(run("2026-11-02", 7), "2026-11-08")).toEqual({current: 7, completed: 1, bonus: 10});
        expect(seasonStreak([...run("2026-11-02", 7), ...run("2026-11-10", 7)], "2026-11-16")).toEqual({current: 14, completed: 2, bonus: 20});
        expect(seasonStreak(run("2026-11-02", 3), "2026-11-04")).toEqual({current: 3, completed: 0, bonus: 0});
        // The caller passes the season's own days: five days before the start plus two inside make a two-day run, not seven.
        const inside = run("2026-10-28", 7).filter(day => day >= season.start!);
        expect(seasonStreak(inside, "2026-11-03")).toEqual({current: 2, completed: 0, bonus: 0});
    });
});
