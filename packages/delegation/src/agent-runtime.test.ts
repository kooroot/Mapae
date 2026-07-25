import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import {toTokenAmount} from "@mapae/shared";
import {judgePreflight, resolveResourceTarget} from "./agent-runtime.js";
import type {DelegationStatus} from "./delegation-status.js";

const seller = new URL("http://127.0.0.1:3101");

const ADDR = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

/** A link that permits everything, so each test varies exactly one thing. */
function link(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
    return {
        delegationHash: `0x${"11".repeat(32)}`,
        delegator: ADDR(1),
        delegate: ADDR(2),
        remaining: toTokenAmount("3"),
        revoked: false,
        expired: false,
        notYetActive: false,
        ...overrides,
    };
}

/**
 * The check that stands between an agent and a signature.
 *
 * This is the product's central claim in one function: the agent asks the enforcer what
 * is left *before* signing, so a payment the cap cannot cover never becomes a signed
 * bearer authorization. It is deliberately pure so it can be tested without a chain — the
 * closure it was extracted from was reachable only through a bootstrap wanting env vars,
 * files and an RPC, which is why it had no test.
 */
describe("judgePreflight", () => {
    test("clears a payment inside the cap", () => {
        expect(judgePreflight([link()], toTokenAmount("1"))).toEqual({ok: true});
    });

    test("an empty chain is refused, not cleared", () => {
        // Every other rule here is a loop, so with no statuses each one fell through and
        // the function cleared the payment — measured at 999 mUSDC against a chain it had
        // read nothing from. The state is reachable: `isPermissionContext` guards shape
        // and length, and a well-formed ABI encoding of an empty `Delegation[]` is 130
        // characters that passes it and decodes to `[]`.
        const verdict = judgePreflight([], 999_000_000n);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({code: "PERMISSION_EMPTY"});
    });

    test("empty and inactive are told apart, not merged", () => {
        // Separate codes on purpose: `PERMISSION_INACTIVE` sends an operator to check
        // revocation and expiry on chain, where a broken permission artifact leaves
        // nothing to find. Asserting both sides — a `not.toMatchObject` here would pass
        // for a verdict of `{ok: true}` too, which is the bug this pins.
        expect(judgePreflight([], 1n)).toMatchObject({code: "PERMISSION_EMPTY"});
        expect(judgePreflight([link({revoked: true})], 1n)).toMatchObject({
            code: "PERMISSION_INACTIVE",
        });
    });

    test("clears a payment exactly at the cap — the enforcer allows equality", () => {
        // `>` not `>=`: refusing the exact remaining balance would make the last
        // spendable unit unspendable, and the chain would have allowed it.
        expect(judgePreflight([link({remaining: toTokenAmount("1")})], toTokenAmount("1"))).toEqual({
            ok: true,
        });
    });

    test("refuses one wei over the cap", () => {
        const verdict = judgePreflight([link({remaining: 1_000_000n})], 1_000_001n);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({code: "LIMIT_EXCEEDED"});
        // The number the operator needs is the remaining balance, not just a refusal.
        expect(verdict.ok === false && verdict.detail).toContain("1000000");
    });

    test("binds to the tightest link, not the root", () => {
        // A re-delegated child with a smaller cap. The DelegationManager enforces every
        // link, so clearing against the root would sign a payment the chain then reverts.
        const verdict = judgePreflight(
            [link({remaining: toTokenAmount("1")}), link({remaining: toTokenAmount("6")})],
            toTokenAmount("2"),
        );
        expect(verdict).toMatchObject({code: "LIMIT_EXCEEDED"});
        expect(verdict.ok === false && verdict.detail).toContain(String(toTokenAmount("1")));
    });

    test("order of the links does not change the verdict", () => {
        const tight = link({remaining: toTokenAmount("1")});
        const loose = link({remaining: toTokenAmount("6")});
        const amount = toTokenAmount("2");
        expect(judgePreflight([tight, loose], amount)).toEqual(judgePreflight([loose, tight], amount));
    });

    for (const [field, detail] of [
        ["revoked", "permission was revoked"],
        ["expired", "permission has expired"],
        ["notYetActive", "permission is not active yet"],
    ] as const) {
        test(`refuses a ${field} link with its own reason`, () => {
            const verdict = judgePreflight([link({[field]: true})], toTokenAmount("1"));
            expect(verdict).toEqual({ok: false, code: "PERMISSION_INACTIVE", detail});
        });

        test(`${field} outranks an over-cap amount on the same link`, () => {
            // Both refusals apply here, which is the only arrangement that pins the
            // order. An earlier version of this test used an amount that fit, so the cap
            // branch never fired and reordering the two checks broke nothing — the test
            // named the property without testing it, and a mutation run caught that.
            //
            // The order matters because the two send the operator to different places: a
            // permission that is unusable at *any* amount reported as `LIMIT_EXCEEDED`
            // has them raising a cap that was never the cause.
            const verdict = judgePreflight([link({[field]: true, remaining: 0n})], 1n);
            expect(verdict).toEqual({ok: false, code: "PERMISSION_INACTIVE", detail});
        });
    }

    test("an inactive link anywhere in the chain refuses the whole chain", () => {
        const verdict = judgePreflight([link(), link({revoked: true})], toTokenAmount("1"));
        expect(verdict).toMatchObject({code: "PERMISSION_INACTIVE"});
    });

    test("a link with no period cap does not become the tightest", () => {
        // `remaining: undefined` means that link carries no ERC-20 period caveat. Treating
        // an absent cap as zero would refuse every payment on a policy that has no cap.
        expect(
            judgePreflight([link({remaining: undefined}), link({remaining: toTokenAmount("3")})], toTokenAmount("2")),
        ).toEqual({ok: true});
    });

    test("no link carries a cap at all — nothing to exceed", () => {
        expect(judgePreflight([link({remaining: undefined})], toTokenAmount("999"))).toEqual({
            ok: true,
        });
    });

    test("a zero remaining balance refuses any positive amount", () => {
        expect(judgePreflight([link({remaining: 0n})], 1n)).toMatchObject({
            code: "LIMIT_EXCEEDED",
        });
    });
});

/**
 * The MCP tool takes a resource path from whatever is driving the agent, which in
 * D5 is a model. A path that resolves to another origin would send `X-PAYMENT` —
 * a bearer authorization — somewhere the operator never configured, so this is a
 * security boundary rather than input tidying.
 */
describe("resolveResourceTarget", () => {
    test("keeps an ordinary absolute path on the seller origin", () => {
        const target = resolveResourceTarget(seller, "/delegated/deliverable/inv-001");
        expect(target.toString()).toBe("http://127.0.0.1:3101/delegated/deliverable/inv-001");
    });

    test("preserves a query string", () => {
        expect(resolveResourceTarget(seller, "/a?b=c").toString()).toBe(
            "http://127.0.0.1:3101/a?b=c",
        );
    });

    test("refuses a protocol-relative path that would change host", () => {
        // new URL("//evil.example", seller) silently yields http://evil.example.
        expect(() => resolveResourceTarget(seller, "//evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses an absolute URL to another origin", () => {
        expect(() => resolveResourceTarget(seller, "http://evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "https://127.0.0.1:3101/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a backslash, which some parsers fold into a slash", () => {
        expect(() => resolveResourceTarget(seller, "/\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "\\\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a relative path that has no anchor on the origin", () => {
        expect(() => resolveResourceTarget(seller, "deliverable/inv-001")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("traversal cannot climb out of the origin", () => {
        // Path traversal normalises within the origin, so it stays safe — asserted
        // so a future change that swaps the origin check for a prefix check fails.
        expect(resolveResourceTarget(seller, "/../../etc/passwd").origin).toBe(seller.origin);
    });

    test("a port change is a different origin", () => {
        expect(() => resolveResourceTarget(seller, "//127.0.0.1:9999/x")).toThrow(
            "absolute path on the seller origin",
        );
    });
});
