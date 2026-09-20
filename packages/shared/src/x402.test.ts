import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodePaymentHeader,
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
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
        const decoded = decodePaymentHeader(encodePaymentHeader(payload));

        expect(decoded.x402Version).toBe(X402_VERSION);
        expect(decoded.accepted.extra).toEqual({
            assetTransferMethod: "erc7710",
            facilitatorAddresses: [FACILITATOR],
        });
        expect(decoded.payload).toEqual(payload.payload);
    });

    test("the payment header carries an offer with non-Latin-1 text in it", () => {
        // The payload echoes the seller's whole requirements object, fields the agent
        // never reads included. A Korean note in one of them used to make the Latin-1
        // `btoa` codec throw after the leaf was signed; the UTF-8 codec the reference
        // implementation uses carries it, and carries it back byte for byte.
        const payload = buildErc7710PaymentPayload({
            accepted: {
                ...buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n}),
                extra: {assetTransferMethod: "erc7710", note: "한글 메모 — 🎉"},
            },
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });
        const header = encodePaymentHeader(payload);
        // The value travels as an HTTP header, so it must itself be plain base64 ASCII.
        expect(/^[A-Za-z0-9+/]+=*$/.test(header)).toBe(true);
        expect(decodePaymentHeader(header)).toEqual(payload);
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
        // The same codec sits behind every header, so the same refusal holds for the
        // payment and the receipt.
        expect(() => decodePaymentHeader(btoa("ÿþ"))).toThrow();
        expect(() => decodePaymentResponseHeader("!!!not-base64!!!")).toThrow();
    });

    test("Payment-Response codec round-trips a receipt with and without a transaction", () => {
        const settled = {
            success: true,
            network: GIWA_SEPOLIA_CAIP2,
            payer: DELEGATOR,
            transaction: `0x${"cd".repeat(32)}` as const,
        };
        expect(decodePaymentResponseHeader(encodePaymentResponseHeader(settled))).toEqual(settled);
        const unnamed = {success: true, network: GIWA_SEPOLIA_CAIP2, payer: DELEGATOR};
        expect(decodePaymentResponseHeader(encodePaymentResponseHeader(unnamed))).toEqual(unnamed);
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
