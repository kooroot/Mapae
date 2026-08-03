import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodeAnyPaymentHeader,
    decodePaymentRequiredHeader,
    encodePaymentHeader,
    encodePaymentRequiredHeader,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {
    decodePaymentRequiredHeader as referenceDecodePaymentRequired,
    decodePaymentSignatureHeader as referenceDecodePaymentSignature,
    encodePaymentRequiredHeader as referenceEncodePaymentRequired,
    encodePaymentSignatureHeader as referenceEncodePaymentSignature,
} from "@x402/core/http";
import {
    PaymentPayloadV2Schema,
    PaymentRequiredV2Schema,
} from "@x402/core/schemas";
import {x402Erc7710Client, x402Erc7710Server} from "@metamask/x402";
import {ENTRY_POINT_V07} from "./config.js";
import {
    assertErc7710Offer,
    payForDelegatedResource,
    type DelegatedLeafProvider,
} from "./payment-client.js";
import {buildD3Policies, preparePeriodDelegation, withDelegationSignature} from "./policy.js";
import {validateDelegatedPayment} from "./x402.js";

/**
 * Conformance harness: Mapae's wire surfaces against the REAL `@x402/core` and
 * `@metamask/x402` implementations, hermetically — no chain, no network, so it can sit
 * inside `bun run check` and fail on the day either side drifts.
 *
 * Every interop defect this repo has shipped was exactly this class of bug and was
 * found late, by a live counterparty or an e2e: `/supported` advertising an extra that
 * offers never carried, a dual-sent submission header crossing the server's size limit
 * (431), a codec that could not carry a Korean description. These tests make the
 * reference implementation itself the reviewer. Versions are pinned in
 * `package.json` on purpose: a conformance failure after a dependency bump is a
 * finding about the ecosystem moving, not noise.
 */

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const OTHER_PAYEE = getAddress("0x2000000000000000000000000000000000000002");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const SIGNATURE = `0x${"11".repeat(65)}` as Hex;
const D3_POLICIES = buildD3Policies(OTHER_PAYEE);

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

function rootPermissionContext(): Hex {
    const root = preparePeriodDelegation({
        environment,
        delegator: DELEGATOR,
        delegate: FACILITATOR,
        policy: D3_POLICIES["open-agent"],
        startDate: 2_000_000_000,
    });
    return encodeDelegations([withDelegationSignature(root, SIGNATURE)]);
}

/** The offer exactly as `apps/delegated-seller` builds it, in-band manager included. */
function sellerOffer(): Erc7710PaymentRequirements {
    return buildErc7710PaymentRequirements({
        payTo: PAYEE,
        amount: 1_000_000n,
        facilitatorAddresses: [FACILITATOR],
        delegationManager: MANAGER,
    });
}

function sellerBody(): PaymentRequired<Erc7710PaymentRequirements> {
    return {
        x402Version: X402_VERSION,
        resource: {
            url: "https://seller.mapae.io/delegated/deliverable/inv-001",
            // Non-Latin-1 on purpose — the codec divergence a btoa-based encoder hides.
            description: "위임 결제 — 로고 시안",
            mimeType: "application/json",
        },
        accepts: [sellerOffer()],
    };
}

describe("x402 conformance — 402 offer against the reference implementation", () => {
    test("the seller's 402 body satisfies the reference PaymentRequiredV2 schema, extra intact", () => {
        const verdict = PaymentRequiredV2Schema.safeParse(sellerBody());
        expect(verdict.success).toBe(true);
        if (!verdict.success) throw new Error("unreachable");
        // The schema must not strip the open extra fields this rail depends on:
        // facilitatorAddresses is the trust gate, delegationManager the in-band
        // discovery channel for chains absent from every registry.
        expect(verdict.data.accepts[0]?.extra).toEqual({
            assetTransferMethod: "erc7710",
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
    });

    test("Payment-Required header bytes agree with the reference codec in both directions", () => {
        const body = sellerBody();
        // Ours → theirs: the reference client must read what our seller emits.
        expect(referenceDecodePaymentRequired(encodePaymentRequiredHeader(body))).toEqual(
            body as never,
        );
        // Theirs → ours: our agent must read what a reference server emits.
        expect(decodePaymentRequiredHeader(referenceEncodePaymentRequired(body as never))).toEqual(
            body,
        );
    });
});

describe("x402 conformance — payment payload against the reference implementation", () => {
    test("the reference erc7710 client accepts our offer and its payload passes our validator", async () => {
        // The provider reads the manager from the offer itself — exactly what a
        // third-party integrator on GIWA has to do, since the manager is in no registry.
        const client = new x402Erc7710Client({
            delegationProvider: async (requirements) => ({
                delegationManager: requirements.extra?.delegationManager as Hex,
                permissionContext: rootPermissionContext(),
                delegator: DELEGATOR as Hex,
            }),
        });
        const offer = sellerOffer();
        const created = await client.createPaymentPayload(X402_VERSION, offer as never);
        const wirePayload = {
            x402Version: X402_VERSION,
            accepted: offer,
            payload: created.payload,
        };

        expect(PaymentPayloadV2Schema.safeParse(wirePayload).success).toBe(true);
        // The strict D4 boundary — manager allowlist, payer binding to the signed
        // root, requirement echo — must accept what the reference client produced.
        const outcome = validateDelegatedPayment(
            {x402Version: X402_VERSION, paymentPayload: wirePayload, paymentRequirements: offer},
            {delegationManager: MANAGER, facilitator: FACILITATOR},
        );
        expect(outcome.payer).toBe(DELEGATOR);
    });

    test("submission header bytes agree with the reference codec in both directions", () => {
        const payload = buildErc7710PaymentPayload({
            accepted: sellerOffer(),
            delegationManager: MANAGER,
            permissionContext: rootPermissionContext(),
            delegator: DELEGATOR,
        });
        expect(referenceDecodePaymentSignature(encodePaymentHeader(payload))).toEqual(
            payload as never,
        );
        expect(decodeAnyPaymentHeader(referenceEncodePaymentSignature(payload as never))).toEqual(
            payload,
        );
    });
});

describe("x402 conformance — supportedKind flow against the reference implementation", () => {
    test("our /supported kind flows through the reference server into an offer our agent trusts", async () => {
        const supported = buildErc7710SupportedPayload({
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
        const server = new x402Erc7710Server();
        const enhanced = await server.enhancePaymentRequirements(
            {
                scheme: "exact",
                network: GIWA_SEPOLIA_CAIP2,
                asset: MOCK_USDC.address,
                amount: "1000000",
                payTo: PAYEE,
                maxTimeoutSeconds: 60,
                extra: {},
            },
            supported.kinds[0] as never,
        );

        const accepted = assertErc7710Offer(enhanced);
        expect(accepted.extra.facilitatorAddresses).toEqual([FACILITATOR]);
        // Measured behavior of @metamask/x402 0.2.0, pinned so an upgrade that starts
        // propagating more of kinds[].extra announces itself here: the flow copies
        // ONLY facilitatorAddresses — the in-band manager does not survive it, which
        // is exactly why the seller's own offer is the load-bearing channel.
        expect("delegationManager" in accepted.extra).toBe(false);
    });
});

describe("x402 conformance — full client loop against reference-built wire bytes", () => {
    test("our client pays a 402 the reference codec built, and the submission parses back", async () => {
        const referenceHeader = referenceEncodePaymentRequired(sellerBody() as never);
        const calls: Array<{init?: RequestInit}> = [];
        const impl = (async (_url: URL, init?: RequestInit) => {
            calls.push({init});
            if (calls.length === 1) {
                // Reference v2 transport: offer in the header, empty body.
                return {
                    status: 402,
                    ok: false,
                    headers: new Headers({"Payment-Required": referenceHeader}),
                    json: async () => null,
                } as unknown as Response;
            }
            return {
                status: 200,
                ok: true,
                headers: new Headers(),
                json: async () => ({invoice: "inv-001"}),
            } as unknown as Response;
        }) as unknown as typeof fetch;

        const provider: DelegatedLeafProvider = async () => ({
            delegationManager: MANAGER,
            permissionContext: rootPermissionContext(),
            delegator: DELEGATOR,
        });
        const result = await payForDelegatedResource(
            new URL("https://seller.mapae.io/delegated/deliverable/inv-001"),
            {provider, delegationManager: MANAGER, trustedFacilitators: [FACILITATOR], fetchImpl: impl},
        );

        expect(result.ok).toBe(true);
        const submitted = (calls[1]?.init?.headers as Record<string, string>)["Payment-Signature"];
        expect(submitted).toBeTypeOf("string");
        const decoded = referenceDecodePaymentSignature(submitted as string);
        expect(PaymentPayloadV2Schema.safeParse(decoded).success).toBe(true);
        expect(
            getAddress((decoded as unknown as {payload: {delegator: string}}).payload.delegator),
        ).toBe(DELEGATOR);
    });
});
