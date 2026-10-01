import type {AgentGoal, AgentMode} from "@mapae/arcade";
import {validGuardian, projectGuardian, type Guardian} from "./guardian";
import {parseActivities, type Activity} from "./activity";

export const COLORS = ["red", "jade", "ink"] as const;
export const TEMPERAMENTS = ["curious", "bold", "calm"] as const;
export const MAX_CHARACTERS = 12;
export type Color = typeof COLORS[number];
export type Temperament = typeof TEMPERAMENTS[number];
export type Character = {name: string; color: Color; temperament: Temperament; appearance?: Guardian};
export type Companion = Character & {
    id: string; configured: boolean;
    agent: {mode: AgentMode; goal: AgentGoal; rounds: number};
    best: number; bests: Record<"stamp" | "race" | "shop", number>;
};
export type Run = {
    id: string; characterId: string; name: string; color: Color; appearance?: Guardian; at: number;
    score: number; bestCombo: number;
    hits: number; mistakes: number; missed: number; status: "unfinished" | "complete";
};
export type ArcadeState = {
    characters: Companion[]; selectedCharacterId: string | null;
    runs: Run[];
    sound: boolean; reducedMotion: boolean; activities: Activity[];
};
export function newCompanion(id: string, character: Character): Companion {
    return {...character, id, configured: true, agent: {mode: "rules", goal: "explore", rounds: 1}, best: 0, bests: {stamp: 0, race: 0, shop: 0}};
}
export function newArcadeState(reducedMotion = false): ArcadeState {
    return {characters: [], selectedCharacterId: null, runs: [], sound: false, reducedMotion, activities: []};
}
export function selectedCharacter(state: ArcadeState): Companion | undefined {
    return state.characters.find(c => c.id === state.selectedCharacterId);
}
export function selectCharacter(demo: ArcadeState, id: string): ArcadeState {
    return demo.characters.some(c => c.id === id) ? {...demo, selectedCharacterId: id} : demo;
}
export function updateCharacter(demo: ArcadeState, id: string, patch: Partial<Pick<Companion, "name" | "color" | "temperament" | "appearance" | "agent" | "configured">>): ArcadeState {
    const member = demo.characters.find(c => c.id === id);
    if (!member || !validCompanion({...member, ...patch})) return demo;
    return {...demo, characters: demo.characters.map(c => c.id === id ? {...c, ...patch} : c)};
}
export function addCharacter(demo: ArcadeState, member: Companion): ArcadeState {
    if (demo.characters.length >= MAX_CHARACTERS || !validCompanion(member) || demo.characters.some(c => c.id === member.id)) return demo;
    return {...demo, characters: [...demo.characters, member], selectedCharacterId: member.id};
}
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const color = (v: unknown): v is Color => COLORS.some(c => c === v);
function validCompanion(v: unknown): v is Companion {
    return object(v) && typeof v.id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(v.id) &&
        typeof v.name === "string" && !!v.name.trim() && Array.from(v.name).length <= 12 && color(v.color) && TEMPERAMENTS.some(t => t === v.temperament) &&
        (v.appearance === undefined || validGuardian(v.appearance)) && typeof v.configured === "boolean" && integer(v.best) && object(v.bests) && [v.bests.stamp, v.bests.race, v.bests.shop].every(integer) &&
        object(v.agent) && (v.agent.mode === "rules" || v.agent.mode === "llm") && (v.agent.goal === "score" || v.agent.goal === "save" || v.agent.goal === "explore") &&
        integer(v.agent.rounds) && v.agent.rounds >= 1 && v.agent.rounds <= 3;
}
/** Local game records only. Balances and spending authority come from GIWA. */
export function parseArcadeState(raw: string | null, reducedMotion = false): ArcadeState {
    const clean = newArcadeState(reducedMotion);
    if (!raw) return clean;
    try {
        const v: unknown = JSON.parse(raw);
        if (!object(v) || !Array.isArray(v.characters) || v.characters.length > MAX_CHARACTERS || !v.characters.every(validCompanion)) return clean;
        const ids = new Set(v.characters.map(c => c.id));
        if (ids.size !== v.characters.length || (v.characters.length === 0 ? v.selectedCharacterId !== null : typeof v.selectedCharacterId !== "string" || !ids.has(v.selectedCharacterId)) ||
            typeof v.sound !== "boolean" || typeof v.reducedMotion !== "boolean" || !Array.isArray(v.runs) || v.runs.length > 40) return clean;
        const activities = parseActivities(v.activities);
        if (!activities || activities.some(a => !ids.has(a.characterId))) return clean;
        for (const run of v.runs) {
            if (!object(run) || typeof run.id !== "string" || !run.id || typeof run.characterId !== "string" || !ids.has(run.characterId) || typeof run.name !== "string" ||
                Array.from(run.name).length > 12 || (run.appearance !== undefined && !validGuardian(run.appearance)) || !color(run.color) || ![run.at, run.score, run.bestCombo, run.hits, run.mistakes, run.missed].every(integer) ||
                (run.status !== "unfinished" && run.status !== "complete")) return clean;
        }
        return v as ArcadeState;
    } catch {return clean;}
}
export type Admission = {ok: true; demo: ArcadeState; ticket: Run} | {ok: false; reason: "character" | "duplicate"};
/** Human practice never spends or creates tokens. Paid agent outings use GIWA tickets. */
export function admitPracticeRun(demo: ArcadeState, id: string, at: number): Admission {
    if (demo.runs.some(run => run.id === id)) return {ok: false, reason: "duplicate"};
    const character = selectedCharacter(demo);
    if (!character) return {ok: false, reason: "character"};
    const ticket: Run = {id, characterId: character.id, at, name: character.name, color: character.color, appearance: projectGuardian(character.appearance),
        score: 0, bestCombo: 0, hits: 0, mistakes: 0, missed: 0, status: "unfinished"};
    return {ok: true, ticket, demo: {...demo, runs: [ticket, ...demo.runs].slice(0, 40)}};
}
export function finishPracticeRun(demo: ArcadeState, id: string, result: Pick<Run, "score" | "bestCombo" | "hits" | "mistakes" | "missed">): ArcadeState {
    const ticket = demo.runs.find(run => run.id === id);
    if (!ticket || ticket.status === "complete") return demo;
    return {...demo, characters: demo.characters.map(c => c.id === ticket.characterId ? {...c, best: Math.max(c.best, result.score)} : c),
        runs: demo.runs.map(run => run.id === id ? {...run, ...result, status: "complete"} : run)};
}
