import type {Address} from "viem";
import {arcadeStorageKey, readArcadeState, serializeArcadeState} from "../state-store";
import {newArcadeState, parseArcadeState, type ArcadeState} from "../state";
import {parseProfile, projectProfile, type ProfileSnapshot} from "./model";

type Draft = {state: ArcadeState; base: ProfileSnapshot | null; pending: boolean; imported: boolean};
const key = (owner: Address) => `mapae.arcade.sync.${owner.toLowerCase()}`;
/** This is a recovery draft and per-device preferences, never the authoritative profile. */
export function readDeviceDraft(owner: Address): Draft {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
        const raw = localStorage.getItem(key(owner));
        if (raw) {
            const v = JSON.parse(raw);
            const profile = parseProfile(v.base?.profile);
            const base = profile && v.base?.owner === owner.toLowerCase() && Number.isSafeInteger(v.base?.revision) && v.base.revision >= 0 ? {owner: owner.toLowerCase(), revision: v.base.revision, generation: typeof v.base.generation === "string" ? v.base.generation : "", profile} : null;
            return {state: parseArcadeState(JSON.stringify(v.state), reduced), base, pending: v.pending === true, imported: v.imported === true};
        }
        // Existing wallet-bound records must survive the move to server storage.
        // Remove this source only after an authenticated server save succeeds.
        const state = readArcadeState(owner, reduced);
        return {state, base: null, pending: state.characters.length > 0, imported: false};
    } catch {return {state: newArcadeState(reduced), base: null, pending: false, imported: false};}
}
export function writeDeviceDraft(owner: Address, draft: Draft): boolean {
    try {
        localStorage.setItem(key(owner), JSON.stringify({
            state: JSON.parse(serializeArcadeState(draft.state)),
            base: draft.base ? {owner: owner.toLowerCase(), revision: draft.base.revision, generation: draft.base.generation, profile: projectProfile({...draft.state, ...draft.base.profile})} : null,
            pending: draft.pending, imported: draft.imported,
        }));
        if (draft.imported) localStorage.removeItem(arcadeStorageKey(owner));
        return true;
    } catch {return false;}
}
/** Keep a conflicting draft separately before explicitly choosing the server copy. */
export function preserveDeviceDraft(owner: Address, state: ArcadeState): void {
    localStorage.setItem(`${key(owner)}.conflict`, serializeArcadeState(state));
}
