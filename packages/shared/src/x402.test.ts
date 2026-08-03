import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodeAnyPaymentHeader,
    decodePaymentRequiredHeader,
    encodePaymentHeader,
    encodePaymentRequiredHeader,
    isLatin1,
    readInboundPaymentHeader,
    type PaymentRequired,
    type Erc7710PaymentRequirements,
} from "./x402.js";
import {GIWA_SEPOLIA_CAIP2} from "./chain.js";

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

describe("ERC-7710 /supported payload", () => {
    test("advertises the facilitator identically in kinds[].extra and signers", () => {
        const payload = buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR]});

        expect(payload.kinds).toHaveLength(1);
        const kind = payload.kinds[0];
        expect(kind?.x402Version).toBe(X402_VERSION);
        expect(kind?.scheme).toBe("exact");
        expect(kind?.network).toBe(GIWA_SEPOLIA_CAIP2);
        expect(kind?.extra.assetTransferMethod).toBe("erc7710");
        // A third-party resource server copies kinds[].extra verbatim into its
        // offers (the supportedKind flow), while this repo's own seller and agent
        // read `signers`. The two channels must never drift, or an offer built
        // from one is refused by a component reading the other.
        expect(kind?.extra.facilitatorAddresses).toEqual([FACILITATOR]);
        expect(payload.signers[GIWA_SEPOLIA_CAIP2]).toEqual([FACILITATOR]);
        expect(payload.extensions).toEqual([]);
    });
});

describe("x402 v2 transport headers", () => {
    const offerBody = (): PaymentRequired<Erc7710PaymentRequirements> => ({
        x402Version: X402_VERSION,
        resource: {
            // Deliberately not Latin-1: the 402 body carries human-facing text, and a
            // Korean description must survive the header codec. This is exactly where
            // the btoa-based payload codec would throw — the reference implementation
            // base64-encodes UTF-8 bytes, and this codec must match it byte for byte.
            description: "결제가 필요합니다 — 로고 시안",
            mimeType: "application/json",
        },
        accepts: [buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n})],
    });

    test("Payment-Required codec round-trips a non-Latin-1 offer body", () => {
        const header = encodePaymentRequiredHeader(offerBody());
        // The value travels as an HTTP header, so it must itself be plain base64 ASCII.
        expect(/^[A-Za-z0-9+/]+=*$/.test(header)).toBe(true);
        expect(decodePaymentRequiredHeader(header)).toEqual(offerBody());
    });

    test("decode rejects garbage and non-UTF-8 bytes instead of returning mojibake", () => {
        expect(() => decodePaymentRequiredHeader("!!!not-base64!!!")).toThrow();
        // 0xFF is not a valid UTF-8 start byte; a non-fatal decoder would silently
        // hand back U+FFFD replacement characters inside a "successfully" parsed offer.
        expect(() => decodePaymentRequiredHeader(btoa("ÿþ"))).toThrow();
    });

    test("readInboundPaymentHeader prefers Payment-Signature over X-PAYMENT", () => {
        // Wire names are written as literals on purpose: a typo in the exported
        // constants must fail here, not in an interop session with a v2 client.
        const headers: Record<string, string> = {
            "payment-signature": "v2-payload",
            "x-payment": "v1-payload",
        };
        expect(readInboundPaymentHeader((name) => headers[name.toLowerCase()])).toEqual({
            name: "Payment-Signature",
            value: "v2-payload",
        });
    });

    test("readInboundPaymentHeader falls back to the X-PAYMENT alias", () => {
        const headers: Record<string, string> = {"x-payment": "v1-payload"};
        expect(readInboundPaymentHeader((name) => headers[name.toLowerCase()])).toEqual({
            name: "X-PAYMENT",
            value: "v1-payload",
        });
    });

    test("readInboundPaymentHeader returns undefined when no payment header is present", () => {
        expect(readInboundPaymentHeader(() => undefined)).toBeUndefined();
    });
});

describe("in-band DelegationManager advertisement", () => {
    test("the offer carries extra.delegationManager when the seller provides one", () => {
        // GIWA's manager is not in @metamask/delegation-deployments, and the merged
        // ERC-7710 scheme is registry-free — the offer itself is the only in-band place
        // a third-party agent's delegationProvider can learn which manager to build its
        // leaf against (it receives these requirements verbatim, extra included).
        const withManager = buildErc7710PaymentRequirements({
            payTo: PAYEE,
            amount: 1_000_000n,
            delegationManager: MANAGER,
        });
        expect(withManager.extra.delegationManager).toBe(MANAGER);

        // Omission stays omission — existing offers and fixtures must not change shape.
        const without = buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n});
        expect("delegationManager" in without.extra).toBe(false);
    });

    test("/supported kinds[].extra can carry the manager as a discovery document", () => {
        // Measured against @metamask/x402 0.2.0: its supportedKind flow copies only
        // facilitatorAddresses into offers, so this field does NOT propagate through a
        // third-party seller automatically. It is still the one queryable place an
        // integrator can read the rail's manager from, which is why it rides here too.
        const payload = buildErc7710SupportedPayload({
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
        expect(payload.kinds[0]?.extra.delegationManager).toBe(MANAGER);
        expect(payload.signers[GIWA_SEPOLIA_CAIP2]).toEqual([FACILITATOR]);
    });
});
