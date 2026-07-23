import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    decodeAnyPaymentHeader,
    encodePaymentHeader,
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
