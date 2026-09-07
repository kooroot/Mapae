import {describe, expect, test} from "bun:test";
import {DELEGATION_FRAMEWORK_VERSION} from "@mapae/delegation/config";
import {giwaSepolia} from "@mapae/shared";
import type {Address, Hex} from "viem";
import type {AgentSessionKey} from "./agent-key";
import type {SessionGrant} from "./grant";
import {mergeGrants} from "./grant-library";

const OWNER = "0x0000000000000000000000000000000000000a11" as Address;

function key(seed: string): AgentSessionKey {
    return {
        address: `0x${seed.repeat(20)}` as Address,
        privateKey: `0x${seed.repeat(32)}` as Hex,
    };
}

/**
 * The context is the identity the store dedupes on, so each grant gets its own; the
 * bytes never decode here because the merge compares them and nothing else. Typed by the
 * return annotation, not cast: a cast would let a field `SessionGrant` grows tomorrow go
 * missing here without a compile error.
 */
function grant(seed: string, agentKey?: AgentSessionKey): SessionGrant {
    return {
        id: `1700000000:${seed}`,
        name: `Agent ${seed}`,
        source: "signed",
        artifact: {
            frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
            chainId: giwaSepolia.id,
            role: "open-agent",
            delegator: OWNER,
            delegate: `0x${seed.repeat(20)}` as Address,
            permissionContext: `0x${seed.repeat(40)}` as Hex,
            createdAt: 1_700_000_000,
        },
        agentKey,
    };
}

/** What `loadGrants`/`appendGrant`/`forgetGrant` hand back: the same grant, no key. */
function persisted(item: SessionGrant): SessionGrant {
    const {agentKey: _dropped, ...rest} = item;
    return rest;
}

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
        expect(merged.map((item) => item.name)).toEqual(["Agent bb", "Agent aa"]);
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
        expect(merged.map((item) => item.name)).toEqual(["Agent cc", "Agent aa"]);
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
        expect(merged.map((item) => item.name)).toEqual(["Agent aa"]);
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
        expect(merged.map((item) => item.name)).toEqual(["Agent bb", "Agent aa"]);
    });
});
