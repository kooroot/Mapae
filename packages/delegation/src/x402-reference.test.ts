import {describe, expect, test} from "bun:test";
import {Hono} from "hono";
import {privateKeyToAccount} from "viem/accounts";
import {getAddress, type Address, type Hex} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {decodeDelegations, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {x402Erc7710Client, x402ExactEvmErc7710ServerScheme} from "@metamask/x402";
import {x402Client} from "@x402/core/client";
import {x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type RoutesConfig} from "@x402/core/server";
import {decodePaymentRequiredHeader, decodePaymentResponseHeader} from "@x402/core/http";
import type {PaymentRequirements, SettleResponse} from "@x402/core/types";
import {wrapFetchWithPayment} from "@x402/fetch";
import {paymentMiddlewareFromHTTPServer} from "@x402/hono";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, buildErc7710SupportedPayload} from "@mapae/shared";
import {createMapaeReferenceClient, createMapaeReferenceScheme} from "../examples/reference-x402.js";
import {ENTRY_POINT_V07} from "./config.js";
import {assertErc7710Offer, type DelegatedLeafProvider} from "./payment-client.js";
import {buildD3Policies, preparePeriodDelegation, withDelegationSignature} from "./policy.js";
import {createMapaeDelegationProvider, validateDelegatedPayment} from "./x402.js";

const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const MANAGER = address(1);
const PAYER = address(2);
const PAYEE = address(3);
const FACILITATOR = address(4);
const TX = `0x${"ab".repeat(32)}` as Hex;
const URL = "https://seller.example/paid";
const session = privateKeyToAccount(`0x${"22".repeat(32)}`);
const environment: SmartAccountsEnvironment = {
    DelegationManager: MANAGER, EntryPoint: ENTRY_POINT_V07, SimpleFactory: address(5),
    implementations: {HybridDeleGatorImpl: address(6)},
    caveatEnforcers: {
        ValueLteEnforcer: address(7), ERC20PeriodTransferEnforcer: address(8),
        ERC20TransferAmountEnforcer: address(9), AllowedCalldataEnforcer: address(10),
        TimestampEnforcer: address(11), RedeemerEnforcer: address(12),
    },
};

function signer() {
    const root = preparePeriodDelegation({
        environment, delegator: PAYER, delegate: session.address,
        policy: buildD3Policies(PAYEE)["open-agent"], startDate: Math.floor(Date.now() / 1000) - 1,
    });
    return createMapaeDelegationProvider({
        account: session, environment, facilitatorAddresses: [FACILITATOR],
        parentPermissionContext: encodeDelegations([withDelegationSignature(root, `0x${"11".repeat(65)}`)]),
    });
}

function routes(extra: Record<string, unknown> = {}): RoutesConfig {
    return {"GET /paid": {
        accepts: {
            scheme: "exact", network: GIWA_SEPOLIA_CAIP2, payTo: PAYEE,
            price: {asset: MOCK_USDC.address, amount: "1000000"},
            extra: {assetTransferMethod: "erc7710", paymentFlow: "upfront", delegationManager: MANAGER, ...extra},
        },
        description: "위임 결제", mimeType: "application/json",
    }};
}

/** Real HTTP adapters, codecs, selection and leaf signing; the chain boundary is stubbed. */
function harness(settleResponse?: SettleResponse) {
    const events: string[] = [];
    const intents: Hex[] = [];
    const received: Headers[] = [];
    const facilitator: FacilitatorClient = {
        getSupported: async () => buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR], delegationManager: MANAGER}),
        verify: async () => {
            events.push("verify");
            return {isValid: true, payer: PAYER};
        },
        settle: async (paymentPayload, paymentRequirements) => {
            // The reference upfront flow calls /settle directly. Mapae validates and
            // simulates there independently of any earlier /verify request.
            const checked = validateDelegatedPayment(
                {x402Version: 2, paymentPayload, paymentRequirements},
                {delegationManager: MANAGER, facilitator: FACILITATOR},
            );
            const chain = decodeDelegations(checked.paymentPayload.payload.permissionContext);
            expect(chain).toHaveLength(2);
            expect(getAddress(chain[0]!.delegator)).toBe(session.address);
            expect(getAddress(chain[1]!.delegator)).toBe(PAYER);
            intents.push(checked.paymentIntentId);
            events.push("settle");
            return settleResponse ?? {success: true, transaction: TX, network: GIWA_SEPOLIA_CAIP2, payer: PAYER};
        },
    };
    const server = new x402ResourceServer(facilitator).register(GIWA_SEPOLIA_CAIP2, createMapaeReferenceScheme());
    const http = new x402HTTPResourceServer(server, routes());
    const app = new Hono();
    // Explicit initialization lets startup failures reject the test instead of exiting
    // the process through the adapter's eager-init handler.
    app.use(paymentMiddlewareFromHTTPServer(http, undefined, undefined, false));
    app.get("/paid", (c) => {events.push("resource"); return c.json({paid: true});});
    const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        received.push(new Headers(request.headers));
        return app.request(request);
    }, {preconnect: globalThis.fetch.preconnect}) satisfies typeof globalThis.fetch;
    return {server, http, facilitator, fetch, events, received, intents};
}

describe("reference HTTP integration", () => {
    test("upstream's unconfigured flow table rejects ERC-7710 at route initialization", async () => {
        const h = harness();
        const server = new x402ResourceServer(h.facilitator)
            .register(GIWA_SEPOLIA_CAIP2, new x402ExactEvmErc7710ServerScheme());
        expect(() => new x402HTTPResourceServer(server, routes())).toThrow("erc7710");
    });

    test("402 → real leaf → validated settle → resource, through the reference fetch and Hono adapters", async () => {
        const h = harness();
        await h.http.initialize();
        const unpaid = await h.fetch(URL);
        expect(unpaid.status).toBe(402);
        const body = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!);
        expect(body.accepts[0]!.extra).toMatchObject({assetTransferMethod: "erc7710", paymentFlow: "upfront", delegationManager: MANAGER});
        expect(h.events).toEqual([]);
        h.received.length = 0;
        const pay = wrapFetchWithPayment(h.fetch, createMapaeReferenceClient(signer(), 1_000_000n));
        const response = await pay(URL, {redirect: "error"});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({paid: true});
        expect(h.events).toEqual(["settle", "resource"]);
        expect(h.received).toHaveLength(2);
        expect(h.received[0]!.has("payment-signature")).toBe(false);
        expect(h.received[1]!.has("payment-signature")).toBe(true);
        expect(h.received[1]!.has("x-payment")).toBe(false);
        expect(decodePaymentResponseHeader(response.headers.get("payment-response")!)).toMatchObject({success: true, transaction: TX, payer: PAYER});
    });

    test("the declared profile refuses serve-first authorization and escrow routes", async () => {
        for (const paymentFlow of ["authorization", "escrow"]) {
            const h = harness();
            expect(() => new x402HTTPResourceServer(h.server, routes({paymentFlow}))).toThrow(paymentFlow);
        }
    });

    test("a settlement failure or pending result never invokes the resource handler", async () => {
        for (const errorReason of ["invalid_payload", "settlement_pending"]) {
            const h = harness({success: false, errorReason, transaction: errorReason === "settlement_pending" ? TX : "", network: GIWA_SEPOLIA_CAIP2});
            await h.http.initialize();
            const response = await wrapFetchWithPayment(h.fetch, createMapaeReferenceClient(signer(), 1_000_000n))(URL);
            expect(response.status).not.toBe(200);
            // Core retries a pending hash exactly once with the same authorization;
            // the facilitator's durable journal must see the same intent, not a new charge.
            expect(h.events).toEqual(errorReason === "settlement_pending" ? ["settle", "settle"] : ["settle"]);
            expect(new Set(h.intents).size).toBe(1);
            expect(h.received).toHaveLength(2);
        }
    });

    test("explicit GIWA asset opt-in admits the cap, rejecting another asset and cap+1 before signing", async () => {
        const h = harness();
        await h.http.initialize();
        const unpaid = await h.fetch(URL);
        const offer = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[0]!;
        let calls = 0;
        const real = signer();
        const provider: DelegatedLeafProvider = async (requirements) => {calls++; return real(requirements);};
        const client = createMapaeReferenceClient(provider, 1_000_000n);
        const create = (requirement: PaymentRequirements) => client.createPaymentPayload({x402Version: 2, resource: {url: URL}, accepts: [requirement]});
        await expect(create({...offer, asset: address(99)})).rejects.toThrow("spendControls");
        await expect(create({...offer, amount: "1000001"})).rejects.toThrow("spendControls");
        expect(calls).toBe(0);
        const payload = await create(offer);
        expect(payload.accepted.amount).toBe("1000000");
        expect(calls).toBe(1);
    });

    test("a bare reference client refuses this non-default token before invoking the provider", async () => {
        const h = harness();
        await h.http.initialize();
        let calls = 0;
        const real = signer();
        const client = new x402Client().register(GIWA_SEPOLIA_CAIP2, new x402Erc7710Client({
            delegationProvider: (offer) => {calls++; return real(assertErc7710Offer(offer));},
        }));
        await expect(wrapFetchWithPayment(h.fetch, client)(URL)).rejects.toThrow("spendControls");
        expect(calls).toBe(0);
        expect(h.events).toEqual([]);
    });

    test("a client cap must be positive", () => {
        expect(() => createMapaeReferenceClient(signer(), 0n)).toThrow("positive");
        expect(() => createMapaeReferenceClient(signer(), -1n)).toThrow("positive");
    });
});
