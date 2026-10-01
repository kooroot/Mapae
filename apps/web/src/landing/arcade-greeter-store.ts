import {ZODIACS, type Zodiac} from "../arcade/guardian";

const LAST_GUEST = "mapae.arcade.last-greeter";

export function pickGuest(roll: number, previous: string | null): Zodiac {
    const candidates = ZODIACS.filter(zodiac => zodiac !== previous);
    return candidates[roll % candidates.length]!;
}

/** Cosmetic, tab-local memory: only a catalog name can be written, never agent data. */
export function welcomeGuest(): Zodiac {
    let previous: string | null = null;
    try {previous = window.sessionStorage.getItem(LAST_GUEST);} catch { /* Storage is optional for an invitation. */ }
    const roll = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const zodiac = pickGuest(roll, previous);
    try {window.sessionStorage.setItem(LAST_GUEST, zodiac);} catch { /* The doorway still works in private storage modes. */ }
    return zodiac;
}
