import {isAddress, type Address} from "viem";
import {GUARDIAN_MAX_SUPPLY,guardianName,guardianTokenId,guardianTraits,type GuardianSnapshot} from "@mapae/arcade/guardians";
import {validGuardianSnapshot} from "./guardians";
import type {AgentProfile, GameId} from "@mapae/arcade";
import {MAX_OUTING_ADMISSIONS, type OutingResult, type OutingStart, type OutingStatus, type OutingView} from "@mapae/arcade/outings";
import {rankedSeed, validRankedAttempt} from "@mapae/arcade/ranking";
import {isOutcome, projectActivity} from "../activity";
import {validReplaySeed} from "../replay";

const UPSTREAM = "https://seller.mapae.io/arcade/outing";
// Twenty-four retained jobs can contain 864 completed rounds (~3.3 MiB measured for shop).
// Keep every unsynced result; the API and each outcome have independent hard bounds.
const MAX_RESPONSE_BYTES = 16 * 1_048_576;
const JOB_ID = /^[A-Za-z0-9_-]{8,80}$/;
const CHARACTER_ID = /^nft-[1-9][0-9]{0,77}$/;
const RESULT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
const JOB_ERRORS = new Set(["permission_expired", "key_changed", "payment_unresolved", "simulation_failed", "owner_changed", "guardian_unavailable", "ruleset_changed"]);
const ROUTE_ERRORS: Record<string, number> = {disabled: 503, unauthorized: 503, invalid_request: 400, invalid_permission: 400, conflict: 409, not_found: 404, busy: 409, storage_unavailable: 503, owner_changed: 409, guardian_unavailable: 503, result_unavailable: 503};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const game = (v: unknown): v is GameId => v === "race" || v === "shop" || v === "stamp";
const choice = (v: unknown): v is GameId | "auto" => game(v) || v === "auto";
const time = (v: unknown): v is number => natural(v) && v <= 8_640_000_000_000_000;
const json = (v: unknown, status = 200) => Response.json(v, {status, headers: {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer"}});
const error = (code: string, status: number) => json({error: {code}}, status);
function agentProfile(v: unknown): AgentProfile | null {
    if (!object(v) || typeof v.name !== "string" || !v.name.trim() || Array.from(v.name).length > 12 ||
        (v.color !== "red" && v.color !== "jade" && v.color !== "ink") ||
        (v.temperament !== "curious" && v.temperament !== "bold" && v.temperament !== "calm") ||
        (v.goal !== "score" && v.goal !== "save" && v.goal !== "explore")) return null;
    return {name: v.name, color: v.color, temperament: v.temperament, goal: v.goal};
}
/** Validate the entire response before importing anything. Projection drops all bearer material. */
export function parseOutingStatus(v: unknown): OutingStatus | null {
    if (!object(v) || typeof v.enabled !== "boolean" || !(v.agent === null || typeof v.agent === "string" && isAddress(v.agent)) ||
        (v.enabled && (v.agent === null || /^0x0{40}$/i.test(v.agent as string))) || !Array.isArray(v.jobs) || v.jobs.length > 24) return null;
    const jobs: OutingView[] = [], ids = new Set<string>(), resultIds = new Set<string>(), transactions = new Set<string>();
    for (const j of v.jobs) {
        if (!object(j) || typeof j.id !== "string" || !JOB_ID.test(j.id) || ids.has(j.id) ||
            typeof j.characterId !== "string" || !CHARACTER_ID.test(j.characterId) || !choice(j.choice) ||
            (j.locale !== "ko" && j.locale !== "en") || !["queued", "running", "paused", "stopped", "complete"].includes(String(j.status)) ||
            !natural(j.admissions) || j.admissions < 1 || j.admissions > MAX_OUTING_ADMISSIONS || !natural(j.spent) || j.spent > j.admissions ||
            !natural(j.reservedAdmissions) || j.reservedAdmissions > j.admissions - j.spent || ((j.status === 'complete' || j.status === 'stopped') && j.reservedAdmissions !== 0) ||
            !time(j.createdAt) || !time(j.updatedAt) || !time(j.expiresAt) || j.updatedAt < j.createdAt || j.expiresAt < j.createdAt ||
            !(j.error === null || typeof j.error === "string" && JOB_ERRORS.has(j.error)) ||
            !Array.isArray(j.results) || j.results.length > j.spent) return null;
        if (!validGuardianSnapshot(j.guardian)) return null;
        const guardian = j.guardian as GuardianSnapshot;
        if (j.characterId !== `nft-${guardian.tokenId}` || BigInt(guardian.tokenId) > BigInt(GUARDIAN_MAX_SUPPLY)) return null;
        const profile = agentProfile(j.profile); if (!profile) return null;
        const traits = guardianTraits(guardian.seed);
        if (profile.color !== traits.color || profile.temperament !== traits.temperament || profile.name !== guardianName(guardian.tokenId, "ko")) return null;
        profile.aptitudes = traits.aptitudes;
        const results: OutingResult[] = [];
        for (const r of j.results) {
            if (!object(r) || typeof r.id !== "string" || !RESULT_ID.test(r.id) || resultIds.has(r.id) || !game(r.game) ||
                (j.choice !== "auto" && j.choice !== r.game) || !validReplaySeed(r.seed) || !time(r.at) || r.at < j.createdAt || r.at > j.updatedAt ||
                typeof r.transaction !== "string" || !TRANSACTION.test(r.transaction) || transactions.has(r.transaction.toLowerCase()) ||
                !isOutcome(r.outcome) || new TextEncoder().encode(JSON.stringify(r.outcome)).byteLength > 16_384 || !Number.isSafeInteger(r.outcome.score) || r.outcome.game !== r.game || r.outcome.replay?.seed !== r.seed || r.outcome.replay.version !== guardian.ruleset || typeof r.outcome.achievement?.victory !== 'boolean' ||
                // A ranked round must be the guardian's fixed course for that day and attempt; absent, the round was unranked.
                (r.ranked !== undefined && (!validRankedAttempt(r.ranked) || r.seed !== rankedSeed(r.game, r.ranked.day, r.ranked.attempt, guardian.tokenId, guardian.ruleset)))) return null;
            // Reuse the existing exhaustive outcome projection rather than retaining unknown nested fields.
            const projected = projectActivity({id: r.id, characterId: j.characterId, color: profile.color, name: profile.name, game: r.game, at: r.at,
                reason: "", source: "mapae-giwa", mode: "rules", ticketId: r.transaction, model: null, giwa: {balanceAfter: null, allowanceAfter: null}, status: "complete", outcome: r.outcome});
            results.push({id: r.id, game: r.game, seed: r.seed, at: r.at, transaction: r.transaction as `0x${string}`, outcome: projected.outcome!,
                ...(r.ranked ? {ranked: {day: r.ranked.day, attempt: r.ranked.attempt}} : {})});
            resultIds.add(r.id); transactions.add(r.transaction.toLowerCase());
        }
        jobs.push({id: j.id, characterId: j.characterId, guardian: {chainId: guardian.chainId, collection: guardian.collection, tokenId: guardian.tokenId, owner: guardian.owner, ownershipEpoch: guardian.ownershipEpoch, seed: guardian.seed, traitsHash: guardian.traitsHash, ruleset: guardian.ruleset}, profile, locale: j.locale, choice: j.choice, status: j.status as OutingView["status"],
            admissions: j.admissions, spent: j.spent, reservedAdmissions: j.reservedAdmissions, createdAt: j.createdAt, updatedAt: j.updatedAt, expiresAt: j.expiresAt, error: j.error as string | null, results});
        ids.add(j.id);
    }
    return {enabled: v.enabled, agent: v.agent as Address | null, jobs};
}

async function boundedJson(response: Response): Promise<unknown> {
    const advertised = response.headers.get("Content-Length");
    if (advertised && Number(advertised) > MAX_RESPONSE_BYTES) {await response.body?.cancel(); throw new Error("response_too_large");}
    const reader = response.body?.getReader(); if (!reader) throw new Error("empty_response");
    const decoder = new TextDecoder(); let size = 0, text = "";
    for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {await reader.cancel(); throw new Error("response_too_large");}
        text += decoder.decode(next.value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
}
export type OutingFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type OutingDependencies = {receiptToken?: string; fetcher?: OutingFetcher; now?: number};
/** Only profileApi may call this: identity, Origin, cookies and per-wallet limits have already been checked. */
export async function outingsApi(request: Request, owner: Address, input: unknown, deps: OutingDependencies): Promise<Response> {
    const path = new URL(request.url).pathname;
    const base = path === "/api/arcade/profile/outings", action = /^\/api\/arcade\/profile\/outings\/([A-Za-z0-9_-]{8,80})\/(stop|resume)$/.exec(path);
    if (!base && !action) return error("not_found", 404);
    if (request.method !== "POST" && !(base && request.method === "GET")) return error("method_not_allowed", 405);
    if (!deps.receiptToken || deps.receiptToken.length < 32) return json({enabled: false, agent: null, jobs: []}, request.method === "GET" ? 200 : 503);
    let payload: OutingStart | Record<string, never> | undefined;
    if (request.method === "POST") {
        if (!object(input)) return error("invalid_request", 400);
        if (base) {
            const {id, tokenId, goal, admissions, permissionContext, locale} = input;
            if (Object.keys(input).some(k => !['id','tokenId','goal','choice','admissions','permissionContext','locale'].includes(k)) ||
                typeof id !== "string" || !JOB_ID.test(id) || !guardianTokenId(tokenId) ||
                (goal !== 'score' && goal !== 'save' && goal !== 'explore') ||
                !choice(input.choice) || !natural(admissions) || admissions < 1 || admissions > MAX_OUTING_ADMISSIONS ||
                typeof permissionContext !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,30000}$/.test(permissionContext) ||
                (locale !== "ko" && locale !== "en")) return error("invalid_request", 400);
            payload = {id, tokenId, goal, admissions, permissionContext: permissionContext as `0x${string}`, choice: input.choice, locale};
        } else payload = {};
    }
    try {
        const response = await (deps.fetcher ?? fetch)(UPSTREAM + (action ? `/${action[1]}/${action[2]}` : ""), {
            method: request.method, headers: {Authorization: `Bearer ${deps.receiptToken}`, "X-Mapae-Owner": owner.toLowerCase(), Accept: "application/json", ...(payload ? {"Content-Type": "application/json"} : {})},
            ...(payload ? {body: JSON.stringify(payload)} : {}), redirect: "manual", signal: AbortSignal.timeout(20_000),
        });
        if (response.status >= 300 && response.status < 400) {await response.body?.cancel(); return error("outings_unavailable", 503);}
        const value = await boundedJson(response);
        if (!response.ok) {
            const code = object(value) && object(value.error) && typeof value.error.code === "string" ? value.error.code : "";
            const codeStatus = Object.hasOwn(ROUTE_ERRORS, code) ? ROUTE_ERRORS[code] : undefined;
            return codeStatus === undefined ? error("outings_unavailable", 503) : error(code === "unauthorized" ? "outings_unavailable" : code, codeStatus);
        }
        const status = parseOutingStatus(value); if (!status) return error("invalid_outing_response", 502);
        return json(status);
    } catch {return error("outings_unavailable", 503);}
}
