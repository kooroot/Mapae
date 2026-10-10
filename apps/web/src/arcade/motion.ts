import {useEffect, useSyncExternalStore} from "react";

/** How much motion a game may spend: everything, feedback without ceremony while an agent is watched, or none. */
export type MotionTier = "full" | "light" | "still";

export function motionTier({still, watched}: {still: boolean; watched: boolean}): MotionTier {
    return still ? "still" : watched ? "light" : "full";
}

let reducedMedia: MediaQueryList | undefined;
const reducedQuery = () => reducedMedia ??= matchMedia("(prefers-reduced-motion: reduce)");
function subscribe(change: () => void) {
    const media = reducedQuery();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
}
const systemReduced = () => reducedQuery().matches;

// Nested shells (route root, signed-in arcade, practice) each hold a claim, so one unmounting never clears another's.
let stillClaims = 0;
function claimStill(delta: 1 | -1) {
    stillClaims += delta;
    document.documentElement.classList.toggle("arc-still", stillClaims > 0);
}

/** The one reduced-motion decision: the player's setting or the OS preference, live. Marks <html> so portaled popups follow it too. */
export function useArcadeMotion(setting: boolean): boolean {
    const still = useSyncExternalStore(subscribe, systemReduced) || setting;
    useEffect(() => {
        if (!still) return;
        claimStill(1);
        return () => claimStill(-1);
    }, [still]);
    return still;
}
