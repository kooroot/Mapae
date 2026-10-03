import {newArcadeState, parseArcadeState, MAX_CHARACTERS, type ArcadeState, type Companion} from "../state";
import {serializeArcadeState} from "../state-store";

export type Profile = Pick<ArcadeState, "characters" | "runs" | "activities">;
// Rotate and deploy to BOTH web Workers before reopening traffic after a DB restore.
export const PROFILE_GENERATION = "2026-10-02-a";
export type ProfileSnapshot = {owner: string; revision: number; generation: string; profile: Profile};
export function serverRestored(base: Pick<ProfileSnapshot, "revision" | "generation">, next: Pick<ProfileSnapshot, "revision" | "generation">): boolean {
    return base.generation !== next.generation || next.revision < base.revision;
}
export const MAX_PROFILE_BYTES = 786_432;
export const emptyProfile = (): Profile => ({characters: [], runs: [], activities: []});
export const sameProfile = (a: Profile, b: Profile) => JSON.stringify(a) === JSON.stringify(b);
export function profileState(profile: Profile, device = newArcadeState()): ArcadeState {
    const selectedCharacterId = profile.characters.some(c => c.id === device.selectedCharacterId) ? device.selectedCharacterId : profile.characters[0]?.id ?? null;
    return {...device, ...profile, selectedCharacterId};
}
/** An allowlist projection excludes wallet credentials, grants, device preferences and balances. */
export function projectProfile(state: ArcadeState): Profile {
    const value: ArcadeState = JSON.parse(serializeArcadeState(state));
    return {characters: value.characters, runs: value.runs, activities: value.activities};
}
export function parseProfile(value: unknown): Profile | null {
    if (!value || typeof value !== "object" || !("characters" in value) || !("runs" in value) || !("activities" in value)) return null;
    if (!Array.isArray(value.characters) || !Array.isArray(value.runs) || !Array.isArray(value.activities) || value.characters.length > MAX_CHARACTERS) return null;
    const first: unknown = value.characters[0];
    const selected = first && typeof first === "object" && "id" in first ? first.id : null;
    const raw = JSON.stringify({...newArcadeState(), characters: value.characters, runs: value.runs, activities: value.activities, selectedCharacterId: selected});
    if (new TextEncoder().encode(raw).length > MAX_PROFILE_BYTES) return null;
    const clean = parseArcadeState(raw);
    if (clean.characters.length !== value.characters.length || clean.runs.length !== value.runs.length || clean.activities.length !== value.activities.length) return null;
    if (new Set(clean.runs.map(r => r.id)).size !== clean.runs.length || new Set(clean.activities.map(a => a.id)).size !== clean.activities.length) return null;
    return projectProfile(clean);
}
export class ProfileConflict extends Error {
    constructor(readonly code: "concurrent_edit" | "character_limit" | "server_restored" = "concurrent_edit") {super(code);}
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function field<T>(base: T | undefined, local: T, remote: T): T {
    if (equal(local, base) || equal(local, remote)) return remote;
    if (equal(remote, base)) return local;
    throw new ProfileConflict();
}
/** Merge disjoint edits. Conflicting edits to the same field require an explicit retry. */
export function mergeProfiles(base: Profile, local: Profile, remote: Profile): Profile {
    const characters = new Map(remote.characters.map(c => [c.id, c]));
    for (const c of local.characters) {
        const old = base.characters.find(v => v.id === c.id), other = characters.get(c.id);
        if (!other) {characters.set(c.id, c); continue;}
        const merged: Companion = {...other,
            name: field(old?.name, c.name, other.name), color: field(old?.color, c.color, other.color),
            temperament: field(old?.temperament, c.temperament, other.temperament),
            appearance: field(old?.appearance, c.appearance, other.appearance), agent: field(old?.agent, c.agent, other.agent),
            configured: c.configured || other.configured, ...mergeRecords(c, other)};
        characters.set(c.id, merged);
    }
    if (characters.size > MAX_CHARACTERS) throw new ProfileConflict("character_limit");
    function history<T extends {id: string; at: number; status: string}>(localRows: T[], remoteRows: T[]): T[] {
        const rows = new Map(remoteRows.map(v => [v.id, v]));
        for (const v of localRows) {
            const other = rows.get(v.id);
            if (!other || (other.status !== "complete" && v.status === "complete")) rows.set(v.id, v);
        }
        return [...rows.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 40);
    }
    return {characters: [...characters.values()], runs: history(local.runs, remote.runs), activities: history(local.activities, remote.activities)};
}
/** Preserve existing device-only characters once; the server wins existing profile edits. */
export function importDeviceProfile(device: Profile, remote: Profile): Profile {
    const existing = new Map(remote.characters.map(c => [c.id, c]));
    const local = {...device, characters: device.characters.map(c => existing.has(c.id) ? {...existing.get(c.id)!, best: c.best, bests: c.bests, recordVersion: c.recordVersion} : c)};
    return mergeProfiles(remote, local, remote);
}

function mergeRecords(a: Companion, b: Companion): Pick<Companion, "recordVersion" | "best" | "bests"> {
    const av = a.recordVersion ?? 1, bv = b.recordVersion ?? 1;
    const chosen = av > bv ? a : b;
    if (av !== bv) return {recordVersion: chosen.recordVersion, best: chosen.best, bests: chosen.bests};
    return {recordVersion: chosen.recordVersion, best: Math.max(a.best, b.best), bests: {
        stamp: Math.max(a.bests.stamp, b.bests.stamp), race: Math.max(a.bests.race, b.bests.race), shop: Math.max(a.bests.shop, b.bests.shop),
    }};
}
