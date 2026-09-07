import {useCallback, useEffect, useState} from "react";
import type {Hex} from "viem";
import type {SessionGrant} from "./grant";
import {loadGrants, writeGrants} from "./grant-store";

interface GrantLibrary {
    /**
     * False until the store has been consulted. Distinct from "the list is empty" on
     * purpose: the two render differently, and conflating them shows a returning user the
     * "No agents registered yet" screen — the exact message that reads as data loss.
     */
    hydrated: boolean;
    grants: SessionGrant[];
    add: (grant: SessionGrant) => void;
    forget: (permissionContext: Hex) => void;
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
 * head, the position `writeGrants` gave it, carrying the key the form generated.
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

export interface GrantLedger {
    readonly grants: SessionGrant[];
    /** Reads the store once, at mount. */
    hydrate: () => SessionGrant[];
    add: (grant: SessionGrant) => SessionGrant[];
    forget: (permissionContext: Hex) => SessionGrant[];
}

/**
 * The list this tab holds, and what the store still owes it.
 *
 * Synchronous on purpose: `recoverFromChain` calls `add` several times in one tick, and
 * each must start from the list the previous one produced, not from the render that
 * enqueued them all. The hook mirrors the result into React state for rendering.
 *
 * `writeGrants` answers `undefined` when storage could not be read or written (blocked,
 * full, private mode). Nothing was persisted then, and merging memory against an empty
 * answer was the bug: every other grant vanished on add, all of them on forget. With no
 * store to defer to, the change applies to memory alone and the grant's context is noted
 * as unpersisted. The next call the store does answer writes those grants first — the ones
 * still in memory; a forgotten one is not resurrected — alongside the change at hand, and
 * only then defers to the merge. Without that a grant added while storage was full would
 * be dropped by the very next successful write, because the store never held it.
 */
export function createGrantLedger(): GrantLedger {
    let grants: SessionGrant[] = [];
    const unpersisted = new Set<Hex>();

    /** The grants a failed write left in memory alone, minus the one being changed now. */
    function owed(except: Hex): SessionGrant[] {
        return grants.filter(
            (item) =>
                unpersisted.has(item.artifact.permissionContext) &&
                item.artifact.permissionContext !== except,
        );
    }

    return {
        get grants() {
            return grants;
        },
        hydrate() {
            grants = loadGrants();
            return grants;
        },
        add(grant) {
            const context = grant.artifact.permissionContext;
            const persisted = writeGrants({add: [grant, ...owed(context)]});
            if (persisted) {
                unpersisted.clear();
                grants = mergeGrants({current: grants, persisted, incoming: grant});
            } else {
                unpersisted.add(context);
                grants = [grant, ...without(grants, context)];
            }
            return grants;
        },
        forget(context) {
            const persisted = writeGrants({add: owed(context), remove: context});
            if (persisted) {
                unpersisted.clear();
                grants = mergeGrants({current: grants, persisted});
            } else {
                unpersisted.delete(context);
                grants = without(grants, context);
            }
            return grants;
        },
    };
}

function without(grants: SessionGrant[], permissionContext: Hex): SessionGrant[] {
    return grants.filter((item) => item.artifact.permissionContext !== permissionContext);
}

/**
 * The Studio's grant list, owned here rather than in the component.
 *
 * `/app` is server-rendered and `localStorage` does not exist there, so the server always
 * emits an empty list. The rule that follows is the whole reason hydration is an effect
 * and not a lazy `useState` initializer: **the first client render must return exactly
 * what the server returned.** `useState(() => loadGrants())` would make the server say
 * "no agents" and the hydration render say "three agents", which React reports as a
 * mismatch and repaints. Reading in an effect — effects do not run on the server, and run
 * after hydration commits — makes it one clean transition instead.
 */
export function useGrantLibrary(): GrantLibrary {
    const [ledger] = useState(createGrantLedger);
    const [state, setState] = useState<{hydrated: boolean; grants: SessionGrant[]}>({
        hydrated: false,
        grants: [],
    });

    useEffect(() => {
        setState({hydrated: true, grants: ledger.hydrate()});
    }, [ledger]);

    const add = useCallback(
        (grant: SessionGrant) => setState({hydrated: true, grants: ledger.add(grant)}),
        [ledger],
    );

    const forget = useCallback(
        (permissionContext: Hex) =>
            setState({hydrated: true, grants: ledger.forget(permissionContext)}),
        [ledger],
    );

    return {hydrated: state.hydrated, grants: state.grants, add, forget};
}
