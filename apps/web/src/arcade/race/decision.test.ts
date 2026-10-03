import {describe, expect, test} from "bun:test";
import type {AgentDecision, AgentProfile, Decide} from "@mapae/arcade";
import {createRaceSeason, RACE_HABITS} from "@mapae/arcade/race";
import {requestRaceDecision} from "./decision";

const profile: AgentProfile = {name: "말랑", color: "jade", temperament: "curious", goal: "score"};
const season = createRaceSeason(2, profile.name, "ko");
const valid: AgentDecision = {source: "llm", model: "test-model", action: {enter: true, strategy: "surge"}, explanation: "Save stamina for the final straight."};
const options = (decide: Decide, signal = new AbortController().signal) => ({profile, locale: "ko" as const, mode: "llm" as const, season, decide, signal});

describe("Auto Race decision boundary", () => {
    test("rules mode names its source and never calls an LLM", async () => {
        let calls = 0;
        const result = await requestRaceDecision({...options(async () => {calls++; return valid;}), mode: "rules"});
        expect(calls).toBe(0);
        expect(result.decision.source).toBe("rules");
        expect(result.decision.model).toBeUndefined();
        expect(result.action.enter).toBe(true);
    });

    test("a remote model gets one pre-race observation and its strategy is preserved", async () => {
        let calls = 0;
        const signal = new AbortController().signal;
        const result = await requestRaceDecision(options(async (request, passedSignal) => {
            calls++;
            expect(request.kind).toBe("race");
            expect(request.observation).toMatchObject({round: 1, seasonTokens: 3});
            expect(request.observation.rivalHabit).toBe(RACE_HABITS[season.runners.find(runner => runner.id === season.rivalId)!.strategy].en);
            expect(String(request.observation.trafficRules)).toContain("within 22m");
            expect(String(request.observation.rules)).toContain("Unused entries expire");
            expect(passedSignal).toBe(signal);
            return valid;
        }, signal));
        expect(calls).toBe(1);
        expect(result.action).toEqual({enter: true, strategy: "surge"});
        expect(result.decision.model).toBe("test-model");
    });

    test("model failure is surfaced without spending or secretly falling back", async () => {
        const before = JSON.stringify(season);
        await expect(requestRaceDecision(options(async () => {throw new Error("Model unavailable");}))).rejects.toThrow("Model unavailable");
        expect(JSON.stringify(season)).toBe(before);
    });

    test("wrong sources, missing model attribution and injected game authority are rejected", async () => {
        const invalid: AgentDecision[] = [
            {...valid, source: "rules"}, {...valid, model: undefined}, {...valid, explanation: ""},
            {...valid, action: {enter: true, strategy: "burst", seasonTokens: 1_000}},
            {...valid, action: {enter: true, strategy: "teleport"}},
        ];
        for (const decision of invalid) await expect(requestRaceDecision(options(async () => decision))).rejects.toThrow("Invalid race decision");
        expect(season.runners[0]!.tokens).toBe(3);
    });

    test("cancelling a pending request prevents even a late successful response from entering", async () => {
        const controller = new AbortController();
        await expect(requestRaceDecision(options(async () => {controller.abort(); return valid;}, controller.signal))).rejects.toThrow();
        expect(season.round).toBe(0);
        let calls = 0;
        await expect(requestRaceDecision(options(async () => {calls++; return valid;}, controller.signal))).rejects.toThrow();
        expect(calls).toBe(0);
    });
});
