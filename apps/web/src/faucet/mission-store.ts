import {isFaucetMissionId, type FaucetMissionId} from "@mapae/delegation/faucet-policy";
import {isAddress, type Address} from "viem";

/**
 * Which faucet missions this browser has seen a wallet complete.
 *
 * Today every mission is `honour`: opening the follow link is the completion, and the
 * claim carries the ids it asserts. Nothing here is a credential — the service decides
 * what a mission is worth, and a `verified` mission is checked there, not trusted from
 * here. So the document is a projection of known mission ids per wallet address and
 * nothing else; an unknown id, a non-address key or any extra field never persists.
 */
export const MISSION_STORAGE_KEY = "mapae-faucet-missions";
/** A browser visits with a handful of wallets; the oldest beyond this are forgotten. */
export const MISSION_OWNER_LIMIT = 32;

type MissionDocument = Record<string, FaucetMissionId[]>;
export type MissionStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): MissionStorage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The allowlisted projection: lowercase addresses to deduplicated known mission ids. */
export function projectMissions(value: unknown): MissionDocument {
    const out: MissionDocument = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [owner, ids] of Object.entries(value)) {
        if (!isAddress(owner, {strict: false}) || owner !== owner.toLowerCase() || !Array.isArray(ids)) continue;
        const known = [...new Set(ids.filter(isFaucetMissionId))];
        if (known.length) out[owner] = known;
    }
    const owners = Object.keys(out);
    for (const owner of owners.slice(0, Math.max(0, owners.length - MISSION_OWNER_LIMIT))) delete out[owner];
    return out;
}

function readDocument(storage: MissionStorage): MissionDocument {
    try {return projectMissions(JSON.parse(storage.getItem(MISSION_STORAGE_KEY) ?? "{}"));}
    catch {return {};}
}

export function readMissions(owner: Address, storage = browserStorage()): FaucetMissionId[] {
    return storage ? readDocument(storage)[owner.toLowerCase()] ?? [] : [];
}

/** Record `ids` as done for `owner`, moving the wallet to the newest end. Returns the wallet's full list. */
export function markMissions(owner: Address, ids: readonly FaucetMissionId[], storage = browserStorage()): FaucetMissionId[] {
    const key = owner.toLowerCase();
    if (!storage) return [...ids];
    const document = readDocument(storage);
    const merged = [...new Set([...(document[key] ?? []), ...ids.filter(isFaucetMissionId)])];
    delete document[key];
    document[key] = merged;
    try {storage.setItem(MISSION_STORAGE_KEY, JSON.stringify(projectMissions(document)));}
    catch {/* Private mode or a full quota: the click still counts for this visit. */}
    return merged;
}
