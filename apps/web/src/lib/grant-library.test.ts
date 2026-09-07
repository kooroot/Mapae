import {describe, expect, test} from "bun:test";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {DELEGATION_FRAMEWORK_VERSION} from "@mapae/delegation/config";
import {giwaSepolia} from "@mapae/shared";
import type {Address, Hex} from "viem";
import type {AgentSessionKey} from "./agent-key";
import type {SessionGrant} from "./grant";
import {createGrantLedger, mergeGrants} from "./grant-library";
import {parseStoredGrants, serializeGrants} from "./grant-store";

const OWNER = "0x0000000000000000000000000000000000000a11" as Address;

function key(seed: string): AgentSessionKey {
    return {
        address: `0x${seed.repeat(20)}` as Address,
        privateKey: `0x${seed.repeat(32)}` as Hex,
    };
}

/**
 * A real, decodable context per delegate: the ledger writes through the actual store,
 * which validates every record it reads back through `parsePermissionContext`, and the
 * context is the identity the merge compares. Typed by the return annotation, not cast: a
 * cast would let a field `SessionGrant` grows tomorrow go missing here without a compile
 * error.
 */
function grant(seed: string, agentKey?: AgentSessionKey): SessionGrant {
    const delegate = `0x${seed.repeat(20)}` as Address;
    return {
        id: `1700000000:${seed}`,
        name: `Agent ${seed}`,
        source: "signed",
        artifact: {
            frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
            chainId: giwaSepolia.id,
            role: "open-agent",
            delegator: OWNER,
            delegate,
            permissionContext: encodeDelegations([
                {
                    delegate,
                    delegator: OWNER,
                    authority: `0x${"0".repeat(64)}` as Hex,
                    caveats: [],
                    salt: `0x${"0".repeat(64)}` as Hex,
                    signature: "0x" as Hex,
                },
            ]),
            createdAt: 1_700_000_000,
        },
        agentKey,
    };
}

/** What the store hands back: the same grant, no key. */
function persisted(item: SessionGrant): SessionGrant {
    const {agentKey: _dropped, ...rest} = item;
    return rest;
}

const names = (grants: SessionGrant[]): string[] => grants.map((item) => item.name);

describe("mergeGrants", () => {
    test("a second add keeps the first grant's agent key", () => {
        // The regression: signing a second agent replaced state with the store's list,
        // and the store never holds a key, so the first agent's bundle button vanished.
        const first = grant("aa", key("11"));
        const second = grant("bb", key("22"));
        const merged = mergeGrants({
            current: [first],
            persisted: [persisted(second), persisted(first)],
            incoming: second,
        });
        expect(names(merged)).toEqual(["Agent bb", "Agent aa"]);
        expect(merged[0]?.agentKey).toEqual(key("22"));
        expect(merged[1]?.agentKey).toEqual(key("11"));
    });

    test("forgetting one grant keeps the others' keys", () => {
        const first = grant("aa", key("11"));
        const second = grant("bb", key("22"));
        const merged = mergeGrants({
            current: [second, first],
            persisted: [persisted(second)],
        });
        expect(merged).toHaveLength(1);
        expect(merged[0]?.name).toBe("Agent bb");
        expect(merged[0]?.agentKey).toEqual(key("22"));
    });

    test("a grant persisted by another tab appears, without a key", () => {
        const mine = grant("aa", key("11"));
        const theirs = grant("cc");
        const merged = mergeGrants({
            current: [mine],
            persisted: [persisted(theirs), persisted(mine)],
        });
        expect(names(merged)).toEqual(["Agent cc", "Agent aa"]);
        expect(merged[0]?.agentKey).toBeUndefined();
        expect(merged[1]?.agentKey).toEqual(key("11"));
    });

    test("a grant the store no longer holds is dropped from memory too", () => {
        // Another tab forgot it; keeping the in-memory object would resurrect a grant the
        // owner deliberately removed, and the next write would persist it again.
        const kept = grant("aa", key("11"));
        const gone = grant("bb", key("22"));
        const merged = mergeGrants({
            current: [kept, gone],
            persisted: [persisted(kept)],
        });
        expect(names(merged)).toEqual(["Agent aa"]);
        expect(merged[0]?.agentKey).toEqual(key("11"));
    });

    test("re-adding a context replaces the in-memory object, as the store replaces the record", () => {
        const stale = grant("aa", key("11"));
        const fresh = {...grant("aa", key("33")), name: "Renamed"};
        const merged = mergeGrants({
            current: [stale],
            persisted: [persisted(fresh)],
            incoming: fresh,
        });
        expect(merged).toHaveLength(1);
        expect(merged[0]?.name).toBe("Renamed");
        expect(merged[0]?.agentKey).toEqual(key("33"));
    });

    test("the store's order wins — memory never reorders what it did not write", () => {
        const older = grant("aa", key("11"));
        const newer = grant("bb");
        const merged = mergeGrants({
            current: [older],
            persisted: [persisted(newer), persisted(older)],
        });
        expect(names(merged)).toEqual(["Agent bb", "Agent aa"]);
    });
});

/**
 * The store reaches storage as `window.localStorage`, and bun test has no window: each
 * test installs one whose writes can be switched to throw — a full storage, Safari's
 * private mode — mid-sequence, which is exactly the sequence the ledger exists for. The
 * real store runs underneath, so "now in the store" is read back from the document it
 * actually wrote, not from a double's idea of it.
 */
function memoryStorage() {
    let document: string | null = null;
    let full = false;
    return {
        storage: {
            getItem: () => document,
            setItem: (_key: string, value: string) => {
                if (full) throw new Error("QuotaExceededError");
                document = value;
            },
        },
        fill(on: boolean) {
            full = on;
        },
        seed(grants: SessionGrant[]) {
            document = serializeGrants(grants);
        },
        stored: () => names(parseStoredGrants(document)),
    };
}

function withStorage<T>(storage: ReturnType<typeof memoryStorage>["storage"], run: () => T): T {
    const scope = globalThis as {window?: unknown};
    const previous = scope.window;
    scope.window = {localStorage: storage};
    try {
        return run();
    } finally {
        if (previous === undefined) delete scope.window;
        else scope.window = previous;
    }
}

describe("createGrantLedger", () => {
    const first = grant("aa", key("11"));
    const second = grant("bb", key("22"));
    const third = grant("cc", key("33"));

    test("hydrates from the store, key-free", () => {
        const store = memoryStorage();
        store.seed([first]);
        const ledger = createGrantLedger();
        const grants = withStorage(store.storage, () => ledger.hydrate());
        expect(names(grants)).toEqual(["Agent aa"]);
        expect(grants[0]?.agentKey).toBeUndefined();
        expect(ledger.grants).toBe(grants);
    });

    test("with a working store, a second add keeps the first grant's key and the store's order", () => {
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            ledger.add(first);
            const grants = ledger.add(second);
            expect(names(grants)).toEqual(["Agent bb", "Agent aa"]);
            expect(grants[0]?.agentKey).toEqual(key("22"));
            expect(grants[1]?.agentKey).toEqual(key("11"));
            expect(store.stored()).toEqual(["Agent bb", "Agent aa"]);
        });
    });

    test("a grant added while storage was full is written by the next add that succeeds, and keeps its key", () => {
        // The regression this pins: the failed-persist path applied the add to memory
        // alone, and the next successful write merged memory against a store that had
        // never held A — so A, and its key, were dropped by the very act of adding B.
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            store.fill(true);
            expect(names(ledger.add(first))).toEqual(["Agent aa"]);
            expect(store.stored()).toEqual([]);

            store.fill(false);
            const grants = ledger.add(second);
            expect(names(grants)).toEqual(["Agent bb", "Agent aa"]);
            expect(grants[0]?.agentKey).toEqual(key("22"));
            expect(grants[1]?.agentKey).toEqual(key("11"));
            expect(store.stored()).toEqual(["Agent bb", "Agent aa"]);
        });
    });

    test("every grant a full storage left behind is written by the next success, in list order", () => {
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            store.fill(true);
            ledger.add(first);
            ledger.add(second);
            expect(store.stored()).toEqual([]);

            store.fill(false);
            const grants = ledger.add(third);
            expect(names(grants)).toEqual(["Agent cc", "Agent bb", "Agent aa"]);
            expect(grants.map((item) => item.agentKey)).toEqual([key("33"), key("22"), key("11")]);
            expect(store.stored()).toEqual(["Agent cc", "Agent bb", "Agent aa"]);
        });
    });

    test("a forget the store answers writes what it is owed too, and forgets only the one asked", () => {
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            ledger.add(third);
            store.fill(true);
            expect(names(ledger.add(first))).toEqual(["Agent aa", "Agent cc"]);

            store.fill(false);
            const grants = ledger.forget(third.artifact.permissionContext);
            expect(names(grants)).toEqual(["Agent aa"]);
            expect(grants[0]?.agentKey).toEqual(key("11"));
            expect(store.stored()).toEqual(["Agent aa"]);
        });
    });

    test("a grant forgotten before the store recovers is not resurrected by the recovery", () => {
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            store.fill(true);
            ledger.add(first);
            ledger.add(second);
            expect(names(ledger.forget(first.artifact.permissionContext))).toEqual(["Agent bb"]);

            store.fill(false);
            const grants = ledger.add(third);
            expect(names(grants)).toEqual(["Agent cc", "Agent bb"]);
            expect(store.stored()).toEqual(["Agent cc", "Agent bb"]);
        });
    });

    test("a forget the store could not take still leaves memory, keys of the others intact", () => {
        // The same regression from the other side: a failed forget used to answer `[]`,
        // and the merge emptied the list.
        const store = memoryStorage();
        const ledger = createGrantLedger();
        withStorage(store.storage, () => {
            ledger.add(first);
            ledger.add(second);
            store.fill(true);
            const grants = ledger.forget(first.artifact.permissionContext);
            expect(names(grants)).toEqual(["Agent bb"]);
            expect(grants[0]?.agentKey).toEqual(key("22"));
            // Nothing was written: the store still holds what it held.
            expect(store.stored()).toEqual(["Agent bb", "Agent aa"]);
        });
    });

    test("a store that cannot be read is not written over, and memory carries the grant alone", () => {
        const writes: string[] = [];
        const ledger = createGrantLedger();
        const grants = withStorage(
            {
                getItem: () => {
                    throw new Error("SecurityError: the operation is insecure");
                },
                setItem: (_key, value) => void writes.push(value),
            },
            () => ledger.add(first),
        );
        expect(names(grants)).toEqual(["Agent aa"]);
        expect(grants[0]?.agentKey).toEqual(key("11"));
        expect(writes).toEqual([]);
    });
});
