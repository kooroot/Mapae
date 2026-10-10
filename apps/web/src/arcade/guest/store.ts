import {addCharacter, newArcadeState, newCompanion, parseArcadeState, type ArcadeState} from '../state';
import {serializeArcadeState} from '../state-store';

export const GUEST_STORAGE_KEY = 'mapae.arcade.guest.v1';
export const MAX_GUEST_BYTES = 131_072;
export function newGuestState(reducedMotion = false): ArcadeState {
    return addCharacter(newArcadeState(reducedMotion), newCompanion('guest', {
        name: '마루', color: 'jade', temperament: 'calm',
        appearance: {version: 1, seed: '0000000000000001', zodiac: 'dragon', backdrop: 'jade', charm: 'mapae', wardrobe: {hat: 'satgat', outfit: 'scholar', shoes: 'taesahye'}},
    }));
}
/** A tab's practice records only. Projection strips credentials even from hostile input. */
export function serializeGuestState(state: ArcadeState): string {
    if (state.characters.length !== 1 || state.characters[0]?.id !== 'guest' || state.selectedCharacterId !== 'guest' || state.activities.some(a => a.source !== 'practice')) throw new Error('Invalid guest state');
    let next = {...state, activities: state.activities.slice(0, 40), runs: state.runs.slice(0, 40)};
    let raw = serializeArcadeState(next);
    while (new TextEncoder().encode(raw).length > MAX_GUEST_BYTES && (next.activities.length || next.runs.length)) {
        next = {...next, activities: next.activities.slice(0, -1), runs: next.runs.slice(0, -1)};
        raw = serializeArcadeState(next);
    }
    if (new TextEncoder().encode(raw).length > MAX_GUEST_BYTES || parseArcadeState(raw).characters.length !== 1) throw new Error('Invalid guest state');
    return raw;
}
export function parseGuestState(raw: string | null, reducedMotion = false): ArcadeState {
    if (!raw || new TextEncoder().encode(raw).length > MAX_GUEST_BYTES) return newGuestState(reducedMotion);
    const state = parseArcadeState(raw, reducedMotion);
    try {return JSON.parse(serializeGuestState(state)) as ArcadeState;} catch {return newGuestState(reducedMotion);}
}
export function readGuestState(reducedMotion = false): ArcadeState {
    try {return parseGuestState(sessionStorage.getItem(GUEST_STORAGE_KEY), reducedMotion);} catch {return newGuestState(reducedMotion);}
}
export function writeGuestState(state: ArcadeState): boolean {
    try {sessionStorage.setItem(GUEST_STORAGE_KEY, serializeGuestState(state)); return true;} catch {return false;}
}
/** Ref-compatible synchronous update, also used by the hook and tested without React. */
export function guestUpdate(current: {current: ArcadeState}, transform: (value: ArcadeState) => ArcadeState): ArcadeState {
    const next = transform(current.current);
    current.current = next;
    writeGuestState(next);
    return next;
}
