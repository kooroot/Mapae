import {useCallback, useEffect, useState} from "react";
import type {SessionGrant} from "./grant";
import {appendGrant, forgetGrant, loadGrants} from "./grant-store";

interface GrantLibrary {
    /**
     * False until the store has been consulted. Distinct from "the list is empty" on
     * purpose: the two render differently, and conflating them shows a returning user the
     * "No agents registered yet" screen — the exact message that reads as data loss.
     */
    hydrated: boolean;
    grants: SessionGrant[];
    add: (grant: SessionGrant) => void;
    forget: (permissionContext: `0x${string}`) => void;
}

/**
 * The next in-memory list after the store was written, without losing what only memory
 * holds.
 *
 * The store never persists `agentKey` (see `grant-store.ts`), so a list read back from it
 * has no key on any entry. Replacing React state with that list — which every mutation
 * used to do — destroyed the only copy of every *other* grant's session key: sign a second
 * agent, forget any grant, or recover from chain, and the first agent's bundle button was
 * gone before the tab closed. The store decides *which* grants exist (so a second tab's
 * writes are honoured and a forgotten grant disappears); memory decides *what object*
 * stands for each one, matched on the permission context, which is the identity the store
 * dedupes on. A grant persisted by another tab has no in-memory object and enters without
 * a key, which is the truth — this tab never held it. A freshly signed grant goes to the
 * head, the position `appendGrant` gave it, carrying the key the form generated.
 */
export function mergeGrants(params: {
    current: SessionGrant[];
    persisted: SessionGrant[];
    incoming?: SessionGrant;
}): SessionGrant[] {
    const {current, persisted, incoming} = params;
    const kept = persisted
        .filter(
            (record) =>
                incoming === undefined ||
                record.artifact.permissionContext !== incoming.artifact.permissionContext,
        )
        .map(
            (record) =>
                current.find(
                    (item) =>
                        item.artifact.permissionContext === record.artifact.permissionContext,
                ) ?? record,
        );
    return incoming ? [incoming, ...kept] : kept;
}

/**
 * The list after an add or a forget, given the store's answer — or none.
 *
 * `appendGrant`/`forgetGrant` return `undefined` when storage could not be read or
 * written (blocked, full, private mode). Nothing was persisted then, and merging memory
 * against an empty answer was the bug: every other grant vanished on add, all of them on
 * forget. With no store to defer to, memory is the only list and the change applies to it
 * directly, on the same context identity the store dedupes on.
 */
export function grantsAfterAdd(
    current: SessionGrant[],
    persisted: SessionGrant[] | undefined,
    grant: SessionGrant,
): SessionGrant[] {
    if (persisted) return mergeGrants({current, persisted, incoming: grant});
    return [grant, ...without(current, grant.artifact.permissionContext)];
}

export function grantsAfterForget(
    current: SessionGrant[],
    persisted: SessionGrant[] | undefined,
    permissionContext: `0x${string}`,
): SessionGrant[] {
    if (persisted) return mergeGrants({current, persisted});
    return without(current, permissionContext);
}

function without(grants: SessionGrant[], permissionContext: `0x${string}`): SessionGrant[] {
    return grants.filter((item) => item.artifact.permissionContext !== permissionContext);
}

/**
 * The Studio's grant list, owned here rather than in the component.
 *
 * `/app` is server-rendered and `localStorage` does not exist there, so the server always
 * emits an empty list. The rule that follows is the whole reason this is an effect and not
 * a lazy `useState` initializer: **the first client render must return exactly what the
 * server returned.** `useState(() => loadGrants())` would make the server say "no agents"
 * and the hydration render say "three agents", which React reports as a mismatch and
 * repaints. Reading in an effect — effects do not run on the server, and run after
 * hydration commits — makes it one clean transition instead.
 */
export function useGrantLibrary(): GrantLibrary {
    const [state, setState] = useState<{hydrated: boolean; grants: SessionGrant[]}>({
        hydrated: false,
        grants: [],
    });

    useEffect(() => {
        setState({hydrated: true, grants: loadGrants()});
    }, []);

    // Functional updates, because `recoverFromChain` calls `add` several times in one
    // tick: each merge must start from the list the previous one produced, not from the
    // render that enqueued them all.
    const add = useCallback((grant: SessionGrant) => {
        const persisted = appendGrant(grant);
        setState(({grants}) => ({
            hydrated: true,
            grants: grantsAfterAdd(grants, persisted, grant),
        }));
    }, []);

    const forget = useCallback((permissionContext: `0x${string}`) => {
        const persisted = forgetGrant(permissionContext);
        setState(({grants}) => ({
            hydrated: true,
            grants: grantsAfterForget(grants, persisted, permissionContext),
        }));
    }, []);

    return {hydrated: state.hydrated, grants: state.grants, add, forget};
}
