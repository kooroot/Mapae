import {describe, expect, test} from "bun:test";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Address, Hex} from "viem";
import {parseStoredGrants, serializeGrants, STORAGE_KEY} from "./grant-store";
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
