import {describe, expect, test} from "bun:test";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Address, Hex} from "viem";
import {
    loadGrants,
    parseStoredGrants,
    serializeGrants,
    STORAGE_KEY,
    writeGrants,
} from "./grant-store";
import type {SessionGrant} from "./grant";

const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
const AGENT = "0x0000000000000000000000000000000000000b22" as Address;
const ROOT_AUTHORITY = `0x${"0".repeat(64)}` as Hex;

/** A real, decodable context — the store validates through `parsePermissionContext`. */
function context(delegate: Address = AGENT): Hex {
    return encodeDelegations([
        {
            delegate,
            delegator: OWNER,
            authority: ROOT_AUTHORITY,
            caveats: [],
            salt: `0x${"0".repeat(64)}` as Hex,
            signature: "0x" as Hex,
        },
    ]);
}

/**
 * A private key that must never survive serialization. Its literal value is asserted
 * against the output, so widening the projection to include `agentKey` fails here rather
 * than in a user's browser profile.
 */
const LEAKED_KEY = `0x${"ab".repeat(32)}` as Hex;

function grant(overrides: Partial<SessionGrant> = {}): SessionGrant {
    return {
        id: "1700000000:agent",
        name: "Invoice agent",
        source: "signed",
        artifact: {
            frameworkVersion: "1.3.0",
            chainId: 91342,
            role: "open-agent",
            delegator: OWNER,
            delegate: AGENT,
            permissionContext: context(),
            createdAt: 1_700_000_000,
        },
        amount: 3_000_000n,
        periodSeconds: 86_400,
        expirySeconds: 2_592_000,
        agentKey: {address: AGENT, privateKey: LEAKED_KEY},
        ...overrides,
    } as SessionGrant;
}

describe("serializeGrants", () => {
    test("never writes the agent private key, even when the grant carries one", () => {
        // The one test that must fail if someone later widens the persisted shape. The
        // permission context is not a bearer instrument — redemption requires the named
        // delegate — but the key is the single field whose theft converts into spend, and
        // storing the pair hands any XSS a ready-to-redeem capability.
        const raw = serializeGrants([grant()]);
        expect(raw).not.toContain(LEAKED_KEY);
        expect(raw).not.toContain("privateKey");
        expect(raw).not.toContain("agentKey");
    });

    test("bigint fields never reach JSON — they are derived from the context on read", () => {
        // `JSON.stringify` throws on a bigint, so a naive write loses the whole document
        // rather than one field. The projection excludes `amount` entirely.
        expect(() => serializeGrants([grant()])).not.toThrow();
        expect(serializeGrants([grant()])).not.toContain("3000000");
    });

    test("keeps only the four facts that cannot be recovered from anything else", () => {
        const parsed = JSON.parse(serializeGrants([grant()]));
        expect(Object.keys(parsed[0]).sort()).toEqual([
            "createdAt",
            "name",
            "permissionContext",
            "source",
        ]);
    });
});

describe("parseStoredGrants", () => {
    test("round-trips a grant's identity and context", () => {
        const restored = parseStoredGrants(serializeGrants([grant()]));
        expect(restored).toHaveLength(1);
        expect(restored[0]?.name).toBe("Invoice agent");
        expect(restored[0]?.source).toBe("signed");
        expect(restored[0]?.artifact.permissionContext).toBe(context());
        expect(restored[0]?.artifact.delegate).toBe(AGENT);
    });

    test("a restored grant carries no agent key", () => {
        const restored = parseStoredGrants(serializeGrants([grant()]));
        expect(restored[0]?.agentKey).toBeUndefined();
    });

    test("absent storage is an empty list, not a throw", () => {
        expect(parseStoredGrants(null)).toEqual([]);
    });

    test("a corrupt document is an empty list, not a throw", () => {
        // localStorage is user- and script-editable, and this value flows into the revoke
        // path. Refusing it must never take the page down with it.
        expect(parseStoredGrants("{not json")).toEqual([]);
        expect(parseStoredGrants('{"grants":[]}')).toEqual([]);
    });

    test("one bad entry is dropped and its siblings survive", () => {
        const good = JSON.parse(serializeGrants([grant({name: "Keeper"})]));
        const raw = JSON.stringify([
            good[0],
            {name: "Truncated", source: "signed", createdAt: 1, permissionContext: "0xdead"},
            {name: 42, source: "signed", createdAt: 1, permissionContext: context()},
            {name: "Bad source", source: "forged", createdAt: 1, permissionContext: context()},
        ]);
        const restored = parseStoredGrants(raw);
        expect(restored.map((g) => g.name)).toEqual(["Keeper"]);
    });

    test("the storage key carries its version so a shape change needs no migration reader", () => {
        expect(STORAGE_KEY).toBe("mapae.grants.v1");
    });
});

/** Only the two calls the store makes. */
interface ScriptedStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}

/**
 * The store reaches storage as `window.localStorage`, and bun test has no window: each
 * test installs a scripted one for the duration of one call and removes it after, so a
 * throwing `getItem` (a blocked storage) or `setItem` (a full one, Safari's private mode)
 * is exactly what the store sees in the browser it was written for.
 */
function withStorage<T>(storage: ScriptedStorage, run: () => T): T {
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

const blocked = (): never => {
    throw new Error("SecurityError: the operation is insecure");
};

/** A storage that keeps its document, so a test can read back what a write left. */
function memoryStorage(initial: SessionGrant[]): {storage: ScriptedStorage; names: () => string[]} {
    let document: string | null = serializeGrants(initial);
    return {
        storage: {
            getItem: () => document,
            setItem: (_key, value) => {
                document = value;
            },
        },
        names: () => parseStoredGrants(document).map((item) => item.name),
    };
}

const OTHER = "0x0000000000000000000000000000000000000c33" as Address;
const THIRD = "0x0000000000000000000000000000000000000d44" as Address;

function other(name: string, delegate: Address): SessionGrant {
    return grant({
        name,
        artifact: {...grant().artifact, delegate, permissionContext: context(delegate)},
    });
}

describe("writeGrants", () => {
    test("adds go to the head in order, each replacing the stored record with its context", () => {
        const store = memoryStorage([other("Older", OTHER)]);
        const written = withStorage(store.storage, () =>
            writeGrants({add: [grant({name: "Newer"}), other("Third", THIRD)]}),
        );
        expect(written?.map((item) => item.name)).toEqual(["Newer", "Third", "Older"]);
        expect(store.names()).toEqual(["Newer", "Third", "Older"]);

        // Same context, new record: replaced in place at the head, not duplicated.
        const renamed = withStorage(store.storage, () =>
            writeGrants({add: [grant({name: "Renamed"})]}),
        );
        expect(renamed?.map((item) => item.name)).toEqual(["Renamed", "Third", "Older"]);
        expect(store.names()).toEqual(["Renamed", "Third", "Older"]);
    });

    test("a remove leaves in the same write as the adds", () => {
        const store = memoryStorage([other("Older", OTHER), grant({name: "Doomed"})]);
        const written = withStorage(store.storage, () =>
            writeGrants({add: [other("Third", THIRD)], remove: [context()]}),
        );
        expect(written?.map((item) => item.name)).toEqual(["Third", "Older"]);
        expect(store.names()).toEqual(["Third", "Older"]);

        const alone = withStorage(store.storage, () => writeGrants({add: [], remove: [context(OTHER)]}));
        expect(alone?.map((item) => item.name)).toEqual(["Third"]);
        expect(store.names()).toEqual(["Third"]);
    });

    // The regression these pin: a throwing storage used to read as an empty document, so
    // an add answered `[grant]` and a forget answered `[]` — and the library, merging
    // memory against those, dropped every other grant on add and all on forget.
    test("an unreadable store answers undefined, and is not written over", () => {
        const writes: string[] = [];
        const result = withStorage(
            {getItem: blocked, setItem: (_key, value) => void writes.push(value)},
            () => writeGrants({add: [grant()]}),
        );
        expect(result).toBeUndefined();
        // A write on top of a document nobody could read would replace another tab's
        // grants with this tab's guess.
        expect(writes).toEqual([]);
        expect(
            withStorage({getItem: blocked, setItem: () => {}}, () =>
                writeGrants({add: [], remove: [context()]}),
            ),
        ).toBeUndefined();
    });

    test("a failed write answers undefined, not the list it could not keep", () => {
        const stored = serializeGrants([grant()]);
        expect(
            withStorage({getItem: () => null, setItem: blocked}, () => writeGrants({add: [grant()]})),
        ).toBeUndefined();
        expect(
            withStorage({getItem: () => stored, setItem: blocked}, () =>
                writeGrants({add: [], remove: [context()]}),
            ),
        ).toBeUndefined();
    });

    test("hydrating from a blocked store is an empty list, not a throw", () => {
        expect(withStorage({getItem: blocked, setItem: blocked}, loadGrants)).toEqual([]);
    });
});
