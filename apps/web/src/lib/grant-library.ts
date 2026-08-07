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

    const add = useCallback((grant: SessionGrant) => {
        // The store's read-modify-write is the source of the next list, so a second tab's
        // grants survive this one's write instead of being overwritten by a stale snapshot.
        // The returned list has no `agentKey` on the restored entries, so the freshly signed
        // grant — which may carry one — is put back at the head.
        const persisted = appendGrant(grant);
        setState({
            hydrated: true,
            grants: [
                grant,
                ...persisted.filter(
                    (item) =>
                        item.artifact.permissionContext !== grant.artifact.permissionContext,
                ),
            ],
        });
    }, []);

    const forget = useCallback((permissionContext: `0x${string}`) => {
        setState({hydrated: true, grants: forgetGrant(permissionContext)});
    }, []);

    return {hydrated: state.hydrated, grants: state.grants, add, forget};
}
