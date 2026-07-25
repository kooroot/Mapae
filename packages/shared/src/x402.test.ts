import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    decodeAnyPaymentHeader,
    encodePaymentHeader,
    isLatin1,
} from "./x402.js";

const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");

describe("x402 v2 ERC-7710 wire types", () => {
    test("round-trips the opaque permission context without changing D2 codecs", () => {
        const accepted = buildErc7710PaymentRequirements({
            payTo: PAYEE,
            amount: 1_000_000n,
            facilitatorAddresses: [FACILITATOR],
        });
        const payload = buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });
        const decoded = decodeAnyPaymentHeader(encodePaymentHeader(payload));

        expect(decoded.x402Version).toBe(X402_VERSION);
        expect(decoded.accepted.extra).toEqual({
            assetTransferMethod: "erc7710",
            facilitatorAddresses: [FACILITATOR],
        });
        expect(decoded.payload).toEqual(payload.payload);
    });
});

/**
 * The header codec's Latin-1 boundary.
 *
 * `btoa` throws a bare `DOMException: The string contains invalid characters.` on any
 * character above U+00FF. On the agent's path that call sits *after* the leaf delegation
 * has been signed, so this guard is a backstop that names the problem for other callers —
 * the refusal that matters happens upstream in `assertErc7710Offer`, before signing.
 *
 * Boundary values are written as escapes rather than literals: a test that defines the
 * limit for non-ASCII characters is the worst place for a bad re-encode to hide.
 */
describe("isLatin1", () => {
    test("accepts everything btoa can encode, up to and including the last byte", () => {
        for (const value of ["", "plain ascii", "\u0000", "é", "ÿ"]) {
            expect(isLatin1(value)).toBe(true);
        }
    });

    test("rejects the first character past the range", () => {
        // U+0100 is exactly one past U+00FF; an off-by-one here would admit precisely the
        // characters that break the codec.
        expect(isLatin1("Ā")).toBe(false);
    });

    test("rejects Hangul, CJK, an em dash, and astral characters", () => {
        // The em dash is the realistic one: this repo's own seller descriptions contain
        // one, and they are one layout change away from riding inside the payload.
        for (const value of ["한", "漢", "—", "🎉"]) {
            expect(isLatin1(value)).toBe(false);
        }
    });

    test("finds a single bad character buried in a long string", () => {
        expect(isLatin1(`${"a".repeat(500)}—${"b".repeat(500)}`)).toBe(false);
    });
});

describe("encodePaymentHeader Latin-1 guard", () => {
    const payload = () =>
        buildErc7710PaymentPayload({
            accepted: buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n}),
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });

    test("encodes an ordinary payload", () => {
        expect(typeof encodePaymentHeader(payload())).toBe("string");
    });

    test("names the problem instead of raising a DOMException", () => {
        const poisoned = payload();
        // A field nothing reads. The point is that the whole object reaches btoa, so
        // validating only the fields the agent uses does not make the encode safe.
        (poisoned.accepted.extra as Record<string, unknown>).note = "한글";
        expect(() => encodePaymentHeader(poisoned)).toThrow("Latin-1");
    });
});
