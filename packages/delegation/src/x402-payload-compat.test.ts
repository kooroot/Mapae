import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {decodeDelegations, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {
    x402Erc7710Client,
    x402ExactEvmErc7710ServerScheme,
    type x402DelegationPaymentPayload,
} from "@metamask/x402";
import {
    decodePaymentSignatureHeader as referenceDecodePaymentSignature,
    encodePaymentSignatureHeader as referenceEncodePaymentSignature,
} from "@x402/core/http";
import {PaymentPayloadV2Schema} from "@x402/core/schemas";
import {
    isEIP3009Payload,
    isPermit2Payload,
    type AssetTransferMethod,
    type ExactEvmPayloadV2,
} from "@x402/evm";
import {getAddress, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodeAnyPaymentHeader,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {derivePaymentIntentId} from "./facilitator-contract.js";
import {assertErc7710Offer} from "./payment-client.js";
import {buildD3Policies, preparePeriodDelegation, withDelegationSignature} from "./policy.js";
import {createMapaeDelegationProvider, validateDelegatedPayment} from "./x402.js";

/**
 * Payload compatibility: what our payer actually PRODUCES — the per-payment leaf that
 * `createMapaeDelegationProvider` (Smart Accounts Kit 1.7.0) mints and signs — against
 * the reference implementations that would consume it: `@metamask/x402` 0.2.0's
 * ERC-7710 client and server, and `@x402/evm` 2.20.0 / `@x402/core` 2.20.0's codecs,
 * schemas and payload guards.
 *
 * `x402-conformance.test.ts` proves our wire *types* against the reference with stub
 * providers. This file closes the gap it names: a stub provider proves nothing about
 * the bytes a real signer emits. Every assertion here runs the real provider with a real
 * session key, hermetically — no chain, no network. Versions are pinned in
 * `package.json`; a failure after a bump is a finding about the ecosystem moving.
 */

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const MANAGER = address(1);
const PAYER = address(0x99);
const VENDOR = address(0x20);
const FACILITATOR = address(0x30);
const session = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);

const environment: SmartAccountsEnvironment = {
    DelegationManager: MANAGER,
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(2),
    implementations: {HybridDeleGatorImpl: address(3)},
    caveatEnforcers: {
        ValueLteEnforcer: address(4),
        ERC20PeriodTransferEnforcer: address(5),
        ERC20TransferAmountEnforcer: address(6),
        AllowedCalldataEnforcer: address(7),
        TimestampEnforcer: address(8),
        RedeemerEnforcer: address(9),
    },
};

/** The root the account owner signed for the session key. Its signature is not checked here. */
function parentContext(): Hex {
    const root = preparePeriodDelegation({
        environment,
        delegator: PAYER,
        delegate: session.address,
        policy: buildD3Policies(VENDOR)["open-agent"],
        startDate: 2_000_000_000,
    });
    return encodeDelegations([withDelegationSignature(root, `0x${"11".repeat(65)}` as Hex)]);
}

function payer() {
    return createMapaeDelegationProvider({
        account: session,
        environment,
        parentPermissionContext: parentContext(),
        facilitatorAddresses: [FACILITATOR],
    });
}

function wireEnvelope(
    accepted: Erc7710PaymentRequirements,
    payload: x402DelegationPaymentPayload,
): Erc7710PaymentPayload {
    return {x402Version: X402_VERSION, accepted, payload};
}

describe("payload compat — the leaf our payer signs, through the reference client and codecs", () => {
    test("the reference erc7710 client emits our provider's leaf unchanged, and every reference codec carries it", async () => {
        const provider = payer();
        // Type-level: the provider's output IS the reference client's payload type.
        // Assigning here is the assertion; a field rename on either side fails tsc.
        const client = new x402Erc7710Client({
            delegationProvider: async (requirements): Promise<x402DelegationPaymentPayload> =>
                provider(assertErc7710Offer(requirements)),
        });
        const offer = buildErc7710PaymentRequirements({
            payTo: VENDOR,
            amount: 1_000_000n,
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });

        const created = await client.createPaymentPayload(X402_VERSION, offer);
        expect(created.x402Version).toBe(X402_VERSION);
        expect(Object.keys(created.payload).sort()).toEqual([
            "delegationManager",
            "delegator",
            "permissionContext",
        ]);
        const payload = created.payload as x402DelegationPaymentPayload;
        expect(getAddress(payload.delegationManager)).toBe(MANAGER);
        // SAK names the ROOT delegator, not the session key that signed the leaf — the
        // identity our facilitator binds the payload to and the seller cross-checks.
        expect(getAddress(payload.delegator)).toBe(PAYER);
        const chain = decodeDelegations(payload.permissionContext);
        expect(chain).toHaveLength(2);
        expect(getAddress(chain[0]!.delegator)).toBe(session.address);
        expect(getAddress(chain[1]!.delegator)).toBe(PAYER);

        const wire = wireEnvelope(offer, payload);
        expect(PaymentPayloadV2Schema.safeParse(wire).success).toBe(true);
        const referenceHeader = referenceEncodePaymentSignature(wire as never);
        expect(referenceDecodePaymentSignature(referenceHeader)).toEqual(wire as never);
        expect(decodeAnyPaymentHeader(referenceHeader)).toEqual(wire);

        const validated = validateDelegatedPayment(
            {x402Version: X402_VERSION, paymentPayload: wire, paymentRequirements: offer},
            {delegationManager: MANAGER, facilitator: FACILITATOR},
        );
        expect(validated.payer).toBe(PAYER);
        expect(validated.amount).toBe(1_000_000n);
    });

    test("the reference EVM server scheme builds the offer from our /supported kind; our payer signs it and the intent id agrees seller-side", async () => {
        // MetaMask's ERC-7710 scheme extends @x402/evm's ExactEvmScheme — the class a
        // reference resource server registers for EVM networks. This is the path a
        // third-party seller on the reference stack takes to offer GIWA payments.
        // Measured against 0.2.0: the subclass adds `facilitatorAddresses` only to
        // requirements that already carry `assetTransferMethod: "erc7710"` — the seller
        // declares the method; the supported kind cannot switch it on. So the bare
        // requirements below name it, exactly as a reference seller's config would.
        const scheme = new x402ExactEvmErc7710ServerScheme();
        const supported = buildErc7710SupportedPayload({
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
        const enhanced = await scheme.enhancePaymentRequirements(
            {
                scheme: "exact",
                network: GIWA_SEPOLIA_CAIP2,
                asset: MOCK_USDC.address,
                amount: "1000000",
                payTo: VENDOR,
                maxTimeoutSeconds: 60,
                extra: {assetTransferMethod: "erc7710"},
            },
            supported.kinds[0]!,
            [],
        );
        const offer = assertErc7710Offer(enhanced);
        expect(offer.extra.facilitatorAddresses).toEqual([FACILITATOR]);

        const leaf = await payer()(offer);
        const wire = wireEnvelope(offer, leaf);
        const validated = validateDelegatedPayment(
            {x402Version: X402_VERSION, paymentPayload: wire, paymentRequirements: offer},
            {delegationManager: MANAGER, facilitator: FACILITATOR},
        );
        expect(validated.payer).toBe(PAYER);
        // What @mapae/seller hands to onSettled is derived from the offer and the leaf
        // alone, and must be the key the facilitator's replay cache uses.
        expect(validated.paymentIntentId).toBe(
            derivePaymentIntentId({
                network: offer.network,
                asset: offer.asset,
                amount: 1_000_000n,
                payTo: offer.payTo,
                delegationManager: getAddress(leaf.delegationManager),
                permissionContext: leaf.permissionContext,
            }),
        );
    });

    test("@x402/evm 2.20.0 has no ERC-7710 route of its own — pinned so the day it grows one announces itself", async () => {
        const leaf = await payer()(
            buildErc7710PaymentRequirements({
                payTo: VENDOR,
                amount: 1_000_000n,
                facilitatorAddresses: [FACILITATOR],
            }),
        );
        // The reference EVM facilitator dispatches on these two guards. Both say no:
        // an ERC-7710 payload reaches the reference stack only through
        // @metamask/x402's own client/server, never through @x402/evm's settlement.
        const asEvm = leaf as unknown as ExactEvmPayloadV2;
        expect(isEIP3009Payload(asEvm)).toBe(false);
        expect(isPermit2Payload(asEvm)).toBe(false);
        // @ts-expect-error — "erc7710" is not a member of AssetTransferMethod in 2.20.0.
        // When a release adds it, this directive turns into a type error: the moment to
        // test our leaf against the reference facilitator's settlement path.
        const method: AssetTransferMethod = "erc7710";
        expect(method as string).toBe("erc7710");
    });
});
