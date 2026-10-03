import {expect, test} from "bun:test";
import {applyRaceRound, createRaceSeason, raceHighlights, RACE_ROUNDS, RACE_STRATEGIES} from "@mapae/arcade/race";
import {admitActivity, admitHumanActivity, completeActivity, isOutcome, parseActivities} from "../activity";
import {addCharacter, newArcadeState, newCompanion} from "../state";
import {withReplay} from "../replay";
import {raceOutcome} from "./RaceGame";

function finishedSeason(enter: boolean, source: "human" | "rules") {
    let season = createRaceSeason(0, "Coach", "en");
    const notes: Parameters<typeof raceOutcome>[1] = [];
    for (let round = 0; round < RACE_ROUNDS; round++) {
        const action = {enter, strategy: RACE_STRATEGIES[round]!};
        season = applyRaceRound(season, action);
        notes.push({round, ...action, decision: {source, action, explanation: enter ? "Race with this strategy." : "Watch this race."}});
    }
    return {season, notes};
}

function save(outcome: ReturnType<typeof raceOutcome>, human: boolean) {
    const state = addCharacter(newArcadeState(), newCompanion("coach", {name: "Coach", color: "jade", temperament: "curious"}));
    const entered = human ? admitHumanActivity(state, "race-result", "coach", "race", 1, 0)
        : admitActivity(state, {id: "race-result", characterId: "coach", game: "race", mode: "rules", source: "mapae-giwa", ticketId: `0x${"ab".repeat(32)}`, model: null, reason: "Race", giwa: {balanceAfter: "2.00", allowanceAfter: "1.00"}}, 1);
    if (!entered.ok) throw new Error("Test admission failed");
    const recorded = withReplay(outcome, 0);
    expect(isOutcome(recorded)).toBe(true);
    const completed = completeActivity(entered.demo, entered.activity.id, recorded);
    expect(completed).not.toBe(entered.demo);
    expect(completed.activities[0]).toMatchObject({status: "complete", outcome: recorded});
    expect(completed.activities.some(activity => activity.status === "active")).toBe(false);
    expect(parseActivities(completed.activities)?.[0]?.outcome).toEqual(recorded);
    return completed;
}

test("a full three-race result with multiple observed events saves and releases the active activity", () => {
    for (const source of ["human", "rules"] as const) {
        const {season, notes} = finishedSeason(true, source);
        // This is the boundary case: several engine events plus rivalry used to emit three highlights.
        const events = season.rounds.flatMap(round => raceHighlights(round.simulation));
        expect(events.length).toBeGreaterThanOrEqual(2);
        for (const locale of ["ko", "en"] as const) {
            const outcome = raceOutcome(season, notes, locale);
            expect(outcome.highlights).toHaveLength(2);
            expect(outcome.highlights![0]).toEqual(events.at(-1)!);
            expect(outcome.highlights![1]!.en).toContain("Season rival");
            expect(outcome.score).toBeGreaterThan(0);
            save(outcome, source === "human");
        }
    }
});

test("an all-watched season saves its zero score without invented race or rivalry highlights", () => {
    const {season, notes} = finishedSeason(false, "rules");
    for (const locale of ["ko", "en"] as const) {
        const outcome = raceOutcome(season, notes, locale);
        expect(outcome.highlights).toEqual([]);
        expect(outcome.score).toBe(0);
        save(outcome, false);
    }
});

test("an empty event history produces a valid empty highlight list", () => {
    const outcome = raceOutcome(createRaceSeason(0, "Coach", "en"), [], "en");
    expect(outcome.highlights).toEqual([]);
    expect(outcome.transcript).toEqual([]);
    expect(outcome.score).toBe(0);
    expect(isOutcome(withReplay(outcome, 0))).toBe(true);
});
