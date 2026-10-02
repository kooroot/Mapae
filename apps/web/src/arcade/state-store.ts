import {isAddress, type Address} from "viem";
import {parseArcadeState, type ArcadeState} from "./state";
import {projectGuardian} from "./guardian";
import {projectActivity} from "./activity";

/** Explicit projection, like the Studio grant store: new fields never persist by accident. */
export function serializeArcadeState(demo: ArcadeState): string {
    return JSON.stringify({
        characters: demo.characters.map(c => ({id: c.id, name: c.name, color: c.color, appearance: projectGuardian(c.appearance), temperament: c.temperament, configured: c.configured,
            agent: {mode: c.agent.mode, goal: c.agent.goal, rounds: c.agent.rounds}, best: c.best, bests: {stamp: c.bests.stamp, race: c.bests.race, shop: c.bests.shop}})),
        selectedCharacterId: demo.selectedCharacterId, sound: demo.sound, reducedMotion: demo.reducedMotion,
        activities: demo.activities.map(projectActivity),
        runs: demo.runs.slice(0, 40).map(run => ({
            id: run.id, characterId: run.characterId, name: run.name, color: run.color, appearance: projectGuardian(run.appearance), at: run.at,
            score: run.score, bestCombo: run.bestCombo, hits: run.hits,
            mistakes: run.mistakes, missed: run.missed, status: run.status,
        })),
    });
}

export function arcadeStorageKey(owner: Address): string {
    if (!isAddress(owner)) throw new Error("A connected wallet is required for arcade records.");
    return `mapae.arcade.wallet.v1.${owner.toLowerCase()}`;
}
export function readArcadeState(owner: Address, reducedMotion = false): ArcadeState {
    return parseArcadeState(localStorage.getItem(arcadeStorageKey(owner)), reducedMotion);
}
