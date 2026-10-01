import type {AgentDecision, AgentMode, AgentProfile, Decide} from "@mapae/arcade";
import {chooseRaceAction, makeRaceCourse, parseRaceAction, raceObservation, type RaceAction, type RaceSeason} from "@mapae/arcade/race";

/** A failed remote decision stays a failed remote decision; entry is applied separately by the engine. */
export async function requestRaceDecision({profile, locale, mode, season, decide, signal}: {
    profile: AgentProfile; locale: "ko" | "en"; mode: AgentMode; season: RaceSeason; decide: Decide; signal: AbortSignal;
}): Promise<{decision: AgentDecision; action: RaceAction}> {
    signal.throwIfAborted();
    const policy = chooseRaceAction(profile, makeRaceCourse(season.seed, season.round), season.runners.find(runner => runner.id === "owner")!.tokens);
    const decision: AgentDecision = mode === "rules"
        ? {source: "rules", action: policy.action, explanation: policy.explanation[locale]}
        : await decide({kind: "race", profile, locale, observation: raceObservation(season, profile)}, signal);
    signal.throwIfAborted();
    const action = parseRaceAction(decision.action);
    if (decision.source !== mode || !action || typeof decision.explanation !== "string" || !decision.explanation.trim()
        || decision.explanation.length > 1_000 || (mode === "llm" && (typeof decision.model !== "string" || !decision.model.trim() || decision.model.length > 200))) {
        throw new Error("Invalid race decision");
    }
    return {decision, action};
}
