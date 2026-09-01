import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    encodePaymentHeader,
} from "@mapae/shared";

/**
 * What the two shop suites share: a facilitator made of three canned answers, and a
 * payment header that looks signed. No chain, no network, no key — the paywall's own
 * ladder is proven in `packages/seller`; these fixtures only let the shop around it be
 * driven from both sides of a process boundary.
 */

export const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
export const PAY_TO = address(0x2001);
export const FACILITATOR = address(0x3001);
export const MANAGER = address(0x4001);
export const PAYER = address(0x5001);
export const TX = `0x${"ab".repeat(32)}` as Hex;
/** Three leaves: distinct permission contexts, hence distinct intents for one offer. */
export const LEAF_A = `0x${"a1".repeat(40)}` as Hex;
export const LEAF_B = `0x${"b2".repeat(40)}` as Hex;
export const LEAF_C = `0x${"c3".repeat(40)}` as Hex;

export type FacilitatorPath = "/supported" | "/verify" | "/settle";
export type FacilitatorRoute = () => Response;

/** The happy facilitator: every path answers as if the payment were good. */
export const FACILITATOR_ROUTES: Record<FacilitatorPath, FacilitatorRoute> = {
    "/supported": () =>
        Response.json(
            buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR], delegationManager: MANAGER}),
        ),
    "/verify": () => Response.json({isValid: true, payer: PAYER}),
    "/settle": () => Response.json({success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER, transaction: TX}),
};

/** A signed-looking payment for `amountBase` to `payTo`, under `context`. */
export function paymentHeader(amountBase: bigint, context: Hex, payTo: Address = PAY_TO): string {
    const accepted = buildErc7710PaymentRequirements({
        payTo,
        amount: amountBase,
        facilitatorAddresses: [FACILITATOR],
        delegationManager: MANAGER,
    });
    return encodePaymentHeader(
        buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext: context,
            delegator: PAYER,
        }),
    );
}
