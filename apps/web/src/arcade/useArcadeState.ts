import type {Address} from "viem";
import {useEffect, useRef, useState} from "react";
import {newArcadeState, parseArcadeState, type ArcadeState} from "./state";
import {arcadeStorageKey, readArcadeState, saveArcadeState} from "./state-store";

/** Mounted under a wallet-address key; a wallet switch discards all in-flight UI state. */
export function useArcadeState(owner: Address) {
    const storageKey = arcadeStorageKey(owner);
    const [demo, setDemo] = useState<ArcadeState>(() => newArcadeState());
    const current = useRef(demo);
    const [ready, setReady] = useState(false);
    const [saved, setSaved] = useState(true);
    useEffect(() => {
        try {
            current.current = readArcadeState(owner, matchMedia("(prefers-reduced-motion: reduce)").matches);
            setDemo(current.current);
        } catch { setSaved(false); }
        setReady(true);
        const receive = (event: StorageEvent) => {
            if (event.storageArea !== localStorage || (event.key !== null && event.key !== storageKey)) return;
            current.current = parseArcadeState(event.newValue);
            setDemo(current.current);
        };
        window.addEventListener("storage", receive);
        return () => window.removeEventListener("storage", receive);
    }, [storageKey]);

    function update(transform: (value: ArcadeState) => ArcadeState): ArcadeState {
        const next = transform(current.current);
        current.current = next;
        setDemo(next);
        setSaved(saveArcadeState(owner, next));
        return next;
    }
    return {demo, ready, saved, update};
}
