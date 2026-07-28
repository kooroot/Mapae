import {describe, expect, test} from "bun:test";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Address, Hex} from "viem";
import {parsePermissionContext} from "./permission";

const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
const AGENT = "0x0000000000000000000000000000000000000b22" as Address;
const SESSION = "0x0000000000000000000000000000000000000c33" as Address;
const ROOT_AUTHORITY = `0x${"0".repeat(64)}` as Hex;

function link(delegator: Address, delegate: Address, authority: Hex = ROOT_AUTHORITY) {
    return {
        delegate,
        delegator,
        authority,
        caveats: [],
        // `salt` is a uint256 carried as hex, not a bigint. The runtime encoder
        // coerces either, so this only surfaces under typecheck — which is the
        // point of running both.
        salt: `0x${"0".repeat(64)}` as Hex,
        signature: "0x" as Hex,
    };
}

describe("parsePermissionContext", () => {
    test("an empty field is empty, not invalid", () => {
        // This is the literal first state of the field on every visit. "Paste a
        // permission context" and "this could not be decoded" send a reader to
        // two different places, and only one of them exists.
        expect(parsePermissionContext("").kind).toBe("empty");
        expect(parsePermissionContext("   ").kind).toBe("empty");
    });

    test("text that is not hex is refused with a reason", () => {
        const parsed = parsePermissionContext("permission context goes here");
        expect(parsed.kind).toBe("invalid");
        expect(parsed.kind === "invalid" && parsed.reason).toContain("0x");
    });

    test("well-formed hex that is not a delegation array is refused, not thrown", () => {
        // The likely first-run mistake is a truncated paste of a ~2 kB context:
        // still hex, no longer a Delegation[]. A throw here would unmount the
        // page and leave nothing on screen at all.
        const parsed = parsePermissionContext(`0x${"ab".repeat(64)}`);
        expect(parsed.kind).toBe("invalid");
        expect(parsed.kind === "invalid" && parsed.reason).toContain("전체");
    });

    test("the root is the LAST link, because the leaf is the throwaway", () => {
        // decodeDelegations returns leaf-first. The leaf is minted per payment
        // and carries that one payment's allowance; showing it as the account's
        // standing cap would put a number too small in the headline position.
        const leaf = link(AGENT, SESSION);
        const root = link(OWNER, AGENT);
        const parsed = parsePermissionContext(encodeDelegations([leaf, root]));
        expect(parsed.kind).toBe("ok");
        if (parsed.kind !== "ok") return;
        expect(parsed.root.delegator.toLowerCase()).toBe(OWNER.toLowerCase());
        expect(parsed.root.delegate.toLowerCase()).toBe(AGENT.toLowerCase());
        expect(parsed.links).toBe(2);
    });

    test("a single-link chain reports one link and uses it as the root", () => {
        const parsed = parsePermissionContext(encodeDelegations([link(OWNER, AGENT)]));
        expect(parsed.kind === "ok" && parsed.links).toBe(1);
        expect(
            parsed.kind === "ok" && parsed.root.delegator.toLowerCase(),
        ).toBe(OWNER.toLowerCase());
    });

    test("surrounding whitespace from a paste is tolerated", () => {
        const encoded = encodeDelegations([link(OWNER, AGENT)]);
        expect(parsePermissionContext(`\n  ${encoded}\t\n`).kind).toBe("ok");
    });

    test("the context is returned verbatim so it is never re-derived downstream", () => {
        // The console learned this one: re-deriving a value at the point of use,
        // or narrowing it with a cast, is how "validate, never cast" gets lost.
        const encoded = encodeDelegations([link(OWNER, AGENT)]);
        const parsed = parsePermissionContext(encoded);
        expect(parsed.kind === "ok" && parsed.context).toBe(encoded);
    });
});
