import type {ActivityOutcome, AgentMode, GameId} from "@mapae/arcade";
import {validGuardian, projectGuardian, type Guardian} from "./guardian";
import type {Color, ArcadeState} from "./state";
import {validReplaySeed} from "./replay";
import {parseShopConfig} from "@mapae/arcade/shop";

export type TicketSource = "mapae-giwa";
type ActivityRecord = {
    id: string; characterId: string; color: Color; appearance?: Guardian; game: GameId; name: string; at: number;
    reason: string;
    outcome: ActivityOutcome | null; status: "active" | "complete" | "stopped";
};
export type PaidActivity = ActivityRecord & {
    mode: AgentMode; source: TicketSource; ticketId: string; model: string | null;
    giwa: {balanceAfter: string | null; allowanceAfter: string | null};
};
export type HumanActivity = ActivityRecord & {mode: "human"; source: "practice"; ticketId: null; model: null; giwa: null; replaySeed?: number};
export type Activity = PaidActivity | HumanActivity;
export const GAME_IDS: GameId[] = ["stamp", "race", "shop"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9;
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const bilingual = (v: unknown): boolean => object(v) && text(v.ko) && text(v.en);

export function isOutcome(v: unknown): v is ActivityOutcome {
    return object(v) && GAME_IDS.includes(v.game as GameId) && finite(v.score) && bilingual(v.summary) &&
        (v.highlights === undefined || Array.isArray(v.highlights) && v.highlights.length <= 2 && v.highlights.every(bilingual)) &&
        (v.replay === undefined || object(v.replay) && validReplaySeed(v.replay.seed) && natural(v.replay.version) && v.replay.version > 0 &&
            (v.replay.shop === undefined || v.game === "shop" && parseShopConfig(v.replay.shop) !== null)) &&
        Array.isArray(v.metrics) && v.metrics.length <= 24 && v.metrics.every(m => object(m) && bilingual(m.label) && finite(m.value) && (m.unit === undefined || text(m.unit, 20))) &&
        Array.isArray(v.transcript) && v.transcript.length <= 100 && v.transcript.every(m => object(m) && text(m.speaker, 80) && text(m.text, 1000)) &&
        Array.isArray(v.ranking) && v.ranking.length <= 24 && v.ranking.every(m => object(m) && text(m.name, 80) && finite(m.score));
}
export function parseActivities(v: unknown): Activity[] | null {
    if (!Array.isArray(v) || v.length > 40) return null;
    for (const a of v) {
        if (!object(a) || !text(a.id, 128) || !a.id || !text(a.characterId, 64) || !a.characterId || !["red", "jade", "ink"].includes(String(a.color)) || !GAME_IDS.includes(a.game as GameId) ||
            (a.appearance !== undefined && !validGuardian(a.appearance)) || !text(a.name, 30) || !natural(a.at) ||
            !(a.model === null || text(a.model, 100)) || !text(a.reason, 1000) ||
            !["active", "complete", "stopped"].includes(String(a.status)) ||
            !(a.outcome === null || isOutcome(a.outcome)) ||
            (a.outcome !== null && a.outcome.game !== a.game) ||
            !(a.source === "practice" ? a.mode === "human" && a.ticketId === null && a.model === null && a.giwa === null && (a.replaySeed === undefined || validReplaySeed(a.replaySeed)) :
                a.replaySeed === undefined &&
                a.source === "mapae-giwa" && ["rules", "llm"].includes(String(a.mode)) && typeof a.ticketId === "string" && /^0x[0-9a-f]{64}$/i.test(a.ticketId) &&
                object(a.giwa) && [a.giwa.balanceAfter, a.giwa.allowanceAfter].every(v => v === null || (typeof v === "string" && /^\d{1,78}(\.\d{1,6})?$/.test(v))))) return null;
    }
    return v as Activity[];
}
export function projectActivity(a: Activity): Activity {
    return {
        id: a.id, characterId: a.characterId, color: a.color, appearance: projectGuardian(a.appearance), game: a.game, name: a.name, at: a.at,
        reason: a.reason, status: a.status,
        ...(a.source === "practice" ? {source: "practice" as const, mode: "human" as const, ticketId: null, model: null, giwa: null, ...(a.replaySeed === undefined ? {} : {replaySeed: a.replaySeed})} :
            {source: a.source, mode: a.mode, ticketId: a.ticketId, model: a.model, giwa: {balanceAfter: a.giwa.balanceAfter, allowanceAfter: a.giwa.allowanceAfter}}),
        outcome: a.outcome && {game: a.outcome.game, score: a.outcome.score,
            summary: {ko: a.outcome.summary.ko, en: a.outcome.summary.en},
            ...(a.outcome.highlights === undefined ? {} : {highlights: a.outcome.highlights.map(h => ({ko: h.ko, en: h.en}))}),
            ...(a.outcome.replay === undefined ? {} : {replay: {seed: a.outcome.replay.seed, version: a.outcome.replay.version, ...(a.outcome.replay.shop ? {shop: parseShopConfig(a.outcome.replay.shop)!} : {})}}),
            metrics: a.outcome.metrics.map(m => ({label: {ko: m.label.ko, en: m.label.en}, value: m.value, ...(m.unit === undefined ? {} : {unit: m.unit})})),
            transcript: a.outcome.transcript.map(m => ({speaker: m.speaker, text: m.text})),
            ranking: a.outcome.ranking.map(m => ({name: m.name, score: m.score})),
        },
    };
}

export function admitActivity(demo: ArcadeState, a: Pick<PaidActivity, "id" | "characterId" | "game" | "mode" | "source" | "ticketId" | "model" | "reason" | "giwa">, at: number): {ok: true; demo: ArcadeState; activity: PaidActivity} | {ok: false; reason: string} {
    if (demo.activities.some(p => p.id === a.id || (a.ticketId && p.ticketId === a.ticketId))) return {ok: false, reason: "duplicate"};
    if (a.source !== "mapae-giwa" || !/^0x[0-9a-f]{64}$/i.test(a.ticketId)) return {ok: false, reason: "ticket"};
    const character = demo.characters.find(c => c.id === a.characterId);
    if (!character) return {ok: false, reason: "character"};
    const activity: PaidActivity = {...a, name: character.name, color: character.color, appearance: projectGuardian(character.appearance), at, outcome: null, status: "active"};
    if (!parseActivities([activity])) return {ok: false, reason: "ticket"};
    return {ok: true, activity, demo: {...demo, activities: [activity, ...demo.activities].slice(0, 40)}};
}
export function completeActivity(demo: ArcadeState, id: string, outcome: ActivityOutcome | null): ArcadeState {
    const a = demo.activities.find(a => a.id === id);
    if (!a || a.status !== "active" || (outcome !== null && (!isOutcome(outcome) || a.game !== outcome.game))) return demo;
    return {...demo, characters: outcome && a.source === "mapae-giwa" ? demo.characters.map(c => c.id === a.characterId ? {...c, bests: {...c.bests, [a.game]: Math.max(c.bests[a.game], outcome.score)}} : c) : demo.characters, activities: demo.activities.map(a => a.id === id ? {...a, outcome, status: outcome ? "complete" : "stopped"} : a)};
}

export function admitHumanActivity(demo: ArcadeState, id: string, characterId: string, game: GameId, at: number, replaySeed?: number): {ok: true; demo: ArcadeState; activity: HumanActivity} | {ok: false} {
    const member = demo.characters.find(c => c.id === characterId);
    if (!member || demo.activities.some(a => a.id === id)) return {ok: false};
    const activity: HumanActivity = {id, characterId, game, at, name: member.name, color: member.color, appearance: projectGuardian(member.appearance),
        mode: "human", source: "practice", ticketId: null, model: null, giwa: null, reason: "", outcome: null, status: "active", ...(replaySeed === undefined ? {} : {replaySeed})};
    if (!parseActivities([activity])) return {ok: false};
    return {ok: true, activity, demo: {...demo, activities: [activity, ...demo.activities].slice(0, 40)}};
}
export function practiceBest(demo: ArcadeState, characterId: string, game: GameId): number {
    if (game === "stamp") return demo.characters.find(c => c.id === characterId)?.best ?? 0;
    const scores = demo.activities.filter(a => a.characterId === characterId && a.game === game && a.source === "practice" && a.status === "complete" && a.outcome !== null).map(a => a.outcome!.score);
    return scores.length ? Math.max(...scores) : 0;
}
