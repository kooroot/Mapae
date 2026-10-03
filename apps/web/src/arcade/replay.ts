import {ARCADE_RULESET_VERSION, type ActivityOutcome} from "@mapae/arcade";

export const ARCADE_REPLAY_VERSION = ARCADE_RULESET_VERSION;
export const validReplaySeed = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** New visits use their UUID; free retries can explicitly select a previous scenario. */
export function gameSeed(visit: {id: string; replaySeed?: number}): number {
    return visit.replaySeed ?? (parseInt(visit.id.slice(0, 8), 16) >>> 0);
}

export function replaySeed(outcome: ActivityOutcome | null): number | undefined {
    return outcome?.replay?.version === ARCADE_REPLAY_VERSION && validReplaySeed(outcome.replay.seed)
        ? outcome.replay.seed : undefined;
}

export function withReplay(outcome: ActivityOutcome, seed: number): ActivityOutcome {
    if (!validReplaySeed(seed)) throw new Error("Invalid practice scenario");
    return {...outcome, replay: {...outcome.replay, seed, version: ARCADE_REPLAY_VERSION}};
}
