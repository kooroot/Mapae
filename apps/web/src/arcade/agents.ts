import type {AgentDecision, AgentDecisionRequest, Decide, GameId} from "@mapae/arcade";
import {ARCADE_TICKET_PRICE} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";

/** These are transparent finite policies. Never label them as a language model. */
export function ruleDecision(request: AgentDecisionRequest): AgentDecision {
    const ko = request.locale === "ko";
    if (request.kind === "stamp") return {source: "rules", action: {tempo: request.profile.temperament === "bold" ? "quick" : "careful"},
        explanation: ko ? "도깨비만 확인하고 찍어요. 성향에 따라 반응 속도를 정했어요." : "I check for goblins before stamping; temperament sets my reaction speed."};
    if (request.kind !== "outing") throw new Error("This rule belongs to its game engine.");
    const {allowance, balance, free, requested, visited} = request.observation;
    const canEnter = free === true || (typeof allowance === "number" && allowance > 0 && typeof balance === "number" && balance > 0);
    const games: GameId[] = ["race", "shop", "stamp"];
    const game = games.includes(requested as GameId) ? requested as GameId :
        request.profile.goal === "score" ? "race" : request.profile.goal === "save" ? "shop" :
            games.find(g => !Array.isArray(visited) || !visited.includes(g)) ?? "race";
    return {source: "rules", action: {enter: canEnter, game, rounds: 1}, explanation: !canEnter
        ? ko ? "허용된 용돈이 없어 외출을 멈췄어요." : "I stopped because my allowance is exhausted."
        : ko ? `${request.profile.goal === "explore" ? "아직 안 해 본 놀이를 골랐어요" : request.profile.goal === "save" ? "가격과 구매 목표를 따지는 가게로 갈게요" : "시즌 점수를 겨루러 경주에 나가요"}. 한 번 입장한 뒤 남은 한도를 다시 확인할게요.`
        : "I chose an activity for your goal. I'll check the remaining allowance again after this admission."};
}

export type ServiceStatus = {
    model: {configured: boolean; provider: string; model: string | null; remainingCalls: number; maxCalls: number};
    payments: {mode: "disabled" | "simulation" | "fork"; unit: string; ticketPrice: string; broadcastEnabled: boolean};
};
export class ArcadeServiceError extends Error {
    constructor(readonly code: string, message: string) {super(message);}
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
async function json(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`/api/arcade${path}`, {method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : {"Content-Type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body), signal});
    let value: unknown;
    try {value = await response.json();} catch {throw new Error("Arcade service is not running. Start bun run dev:arcade.");}
    if (!response.ok) {
        const error = object(value) && object(value.error) ? value.error : {};
        throw new ArcadeServiceError(typeof error.code === "string" ? error.code : "unknown", typeof error.message === "string" ? error.message : `Arcade service: ${response.status}`);
    }
    return value;
}
export const readServiceStatus = async (signal?: AbortSignal): Promise<ServiceStatus> => {
    const v = await json("/status", undefined, signal);
    if (!object(v) || !object(v.model) || !object(v.payments) || typeof v.model.configured !== "boolean" ||
        typeof v.model.provider !== "string" || !(v.model.model === null || typeof v.model.model === "string") ||
        typeof v.model.remainingCalls !== "number" || !Number.isSafeInteger(v.model.remainingCalls) || v.model.remainingCalls < 0 ||
        typeof v.model.maxCalls !== "number" || !Number.isSafeInteger(v.model.maxCalls) || v.model.maxCalls < v.model.remainingCalls ||
        !["disabled", "simulation", "fork"].includes(String(v.payments.mode)) || v.payments.broadcastEnabled !== false ||
        v.payments.unit !== MOCK_USDC.symbol || v.payments.ticketPrice !== ARCADE_TICKET_PRICE) throw new Error("Invalid arcade service status.");
    return v as ServiceStatus;
};
export const modelDecision: Decide = async (request, signal) => {
    const decision = await json("/decide", request, signal);
    if (!object(decision) || decision.source !== "llm" || typeof decision.model !== "string" || !decision.model.trim() || !object(decision.action) || typeof decision.explanation !== "string" || decision.explanation.length > 1000) throw new Error("Invalid LLM decision.");
    return decision as AgentDecision;
};
export type ExternalTicket = {source: "mapae-simulation" | "mapae-fork"; ticket: {id: string; game: GameId; status: "ready" | "consumed"; runId: string | null; amount: typeof ARCADE_TICKET_PRICE; unit: typeof MOCK_USDC.symbol; transaction: string | null; payer: string}};
export function parseTicket(v: unknown): ExternalTicket {
    if (!object(v) || !["mapae-simulation", "mapae-fork"].includes(String(v.source)) || !object(v.ticket)) throw new Error("Invalid admission ticket.");
    const t = v.ticket;
    if (typeof t.id !== "string" || !t.id || !["stamp", "race", "shop"].includes(String(t.game)) ||
        !["ready", "consumed"].includes(String(t.status)) || !(t.runId === null || typeof t.runId === "string") ||
        t.amount !== ARCADE_TICKET_PRICE || t.unit !== MOCK_USDC.symbol || typeof t.payer !== "string" || !/^0x[0-9a-f]{40}$/i.test(t.payer) ||
        !(t.transaction === null || (typeof t.transaction === "string" && /^0x[0-9a-f]{64}$/i.test(t.transaction)))) throw new Error("Invalid admission ticket.");
    return v as ExternalTicket;
}
export const purchaseTicket = async (game: GameId, requestId: string, signal?: AbortSignal) => {
    const value = parseTicket(await json("/tickets", {game, requestId}, signal));
    if (value.ticket.game !== game) throw new Error("Ticket game mismatch.");
    return value;
};
export const consumeTicket = async (ticketId: string, runId: string, signal?: AbortSignal) => {
    const value = parseTicket(await json(`/tickets/${encodeURIComponent(ticketId)}/consume`, {runId}, signal));
    if (value.ticket.id !== ticketId || value.ticket.status !== "consumed" || value.ticket.runId !== runId) throw new Error("Ticket consumption was not confirmed.");
    return value;
};

export function parseOutingDecision(decision: AgentDecision, requested: GameId | "auto"): {enter: boolean; game: GameId} {
    const {enter, game} = decision.action;
    if (typeof enter !== "boolean" || !["stamp", "race", "shop"].includes(String(game)) || (requested !== "auto" && game !== requested)) throw new Error("The agent returned an invalid activity decision.");
    return {enter, game: game as GameId};
}
