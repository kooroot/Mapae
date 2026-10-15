import type {ShopConfig, ShopMemory} from "./shop";
import type {GuardianAptitudes} from "./guardians";

export const ARCADE_RULESET_VERSION = 3;

export type GameId = "stamp" | "race" | "shop";
/** The three games' display names, one source for the web, the share page and the seller's share card. */
export const GAME_NAMES: Record<"ko" | "en", Record<GameId, string>> = {
    ko: {race: "달려라 마패", shop: "흥정상회", stamp: "도깨비 도장찍기"},
    en: {race: "Auto Race", shop: "Tiny Shop", stamp: "Dokkaebi Stamp"},
};
export type AgentMode = "rules" | "llm";
export type AgentGoal = "score" | "save" | "explore";
export type AgentProfile = {name: string; color: "red" | "jade" | "ink"; temperament: "curious" | "bold" | "calm"; goal: AgentGoal; aptitudes?: GuardianAptitudes};
export type DecisionKind = "outing" | "stamp" | "race" | "shop-seller" | "shop-buyer";
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
/** Observations must be constructed for the receiving role, never copied from full game state. */
export type AgentDecisionRequest = {kind: DecisionKind; profile: AgentProfile; locale: "ko" | "en"; observation: Record<string, JsonValue>};
export type AgentDecision = {source: AgentMode; model?: string; action: Record<string, JsonValue>; explanation: string};
export type Decide = (request: AgentDecisionRequest, signal?: AbortSignal) => Promise<AgentDecision>;
export type ActivityMetric = {label: {ko: string; en: string}; value: number; unit?: string};
export type ActivityOutcome = {
    game: GameId; score: number; summary: {ko: string; en: string};
    /** Engine-derived achievement; the server refuses progression when absent. */
    achievement?: {victory: boolean};
    /** Engine-observed turning points, never model-generated claims about the result. */
    highlights?: {ko: string; en: string}[];
    /** A versioned starting scenario for free practice, not a payment or replay authorization. */
    replay?: {seed: number; version: number; shop?: ShopConfig; shopMemory?: ShopMemory; aptitudes?: GuardianAptitudes};
    /** Authored customer follow-up only; never a balance or spending authorization. */
    shopMemory?: ShopMemory;
    metrics: ActivityMetric[]; transcript: {speaker: string; text: string}[];
    /** Engine-computed comparison under equal initial conditions, never a global leaderboard. */
    ranking: {name: string; score: number}[];
};
