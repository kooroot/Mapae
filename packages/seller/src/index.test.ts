import {describe, expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    LEGACY_PAYMENT_HEADER,
    LEGACY_PAYMENT_RESPONSE_HEADER,
    MOCK_USDC,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodeAnyPaymentHeader,
    decodePaymentRequiredHeader,
    encodePaymentHeader,
    type Erc7710DelegationPayload,
} from "@mapae/shared";
import {ENTRY_POINT_V07} from "@mapae/delegation/config";
import {SETTLEMENT_UNCONFIRMED} from "@mapae/delegation/facilitator-contract";
import {
    buildD3Policies,
    preparePeriodDelegation,
    withDelegationSignature,
} from "@mapae/delegation/policy";
import {validateDelegatedPayment} from "@mapae/delegation/x402";
import {
    DEFAULT_FACILITATOR_URL,
    MAPAE_MANIFEST_PATH,
    mapaeManifest,
    mapaePaywall,
    type MapaePaywallOptions,
    type SettlementReceipt,
} from "./index.js";

/**
 * Hermetic: every facilitator call goes through the injected fetch, so the suite runs
 * with no chain, no network and no key. The permission context is a real signed
 * delegation chain so the one cross-check against the facilitator's own validator
 * (`validateDelegatedPayment`) is a genuine comparison rather than two calls to one
 * function — which is the only reason the Smart Accounts Kit is a dev dependency here.
 */

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const PAY_TO = getAddress("0x2000000000000000000000000000000000000001");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const PAYER = getAddress("0x5000000000000000000000000000000000000001");
const IMPOSTOR = getAddress("0x5000000000000000000000000000000000000002");
const SIGNATURE = `0x${"11".repeat(65)}` as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;
const RESOURCE = "http://seller.test/paid";

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

const CONTEXT: Hex = encodeDelegations([
    withDelegationSignature(
        preparePeriodDelegation({
            environment,
            delegator: PAYER,
            delegate: FACILITATOR,
            policy: buildD3Policies(address(10))["open-agent"],
            startDate: 2_000_000_000,
        }),
        SIGNATURE,
    ),
]);

const SUPPORTED = buildErc7710SupportedPayload({
    facilitatorAddresses: [FACILITATOR],
    delegationManager: MANAGER,
});
const OFFER = buildErc7710PaymentRequirements({
    payTo: PAY_TO,
    amount: 1_000_000n,
    facilitatorAddresses: [FACILITATOR],
    delegationManager: MANAGER,
});
const SETTLED = {success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER, transaction: TX};

function paymentHeader(patch: Partial<Erc7710DelegationPayload> = {}): string {
    return encodePaymentHeader(
        buildErc7710PaymentPayload({
            accepted: OFFER,
            delegationManager: MANAGER,
            permissionContext: CONTEXT,
            delegator: PAYER,
            ...patch,
        }),
    );
}

type Route = (init?: RequestInit) => Response | Promise<Response>;
type Path = "/supported" | "/verify" | "/settle";
interface Call {
    url: string;
    path: string;
    method: string;
    contentType?: string;
    body?: unknown;
}

const json =
    (body: unknown, status = 200): Route =>
    () =>
        Response.json(body, {status});
const refused: Route = () => {
    throw new TypeError("fetch failed");
};

/** A facilitator made of routes. A path with no route is a refused connection. */
function facilitator(routes: Partial<Record<Path, Route>> = {}) {
    const calls: Call[] = [];
    const table: Record<Path, Route> = {
        "/supported": json(SUPPORTED),
        "/verify": json({isValid: true, payer: PAYER}),
        "/settle": json(SETTLED),
        ...routes,
    };
    const fetch: NonNullable<MapaePaywallOptions["fetch"]> = async (input, init) => {
        const url = new URL(input);
        const headers = new Headers(init?.headers);
        calls.push({
            url: url.href,
            path: url.pathname,
            method: init?.method ?? "GET",
            contentType: headers.get("content-type") ?? undefined,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const route = table[url.pathname as Path];
        if (!route) throw new TypeError("fetch failed");
        return route(init);
    };
    return {fetch, calls, paths: () => calls.map((call) => call.path)};
}

interface Seen {
    receipt?: SettlementReceipt;
    served: number;
}

function paywall(overrides: Partial<MapaePaywallOptions> = {}) {
    return mapaePaywall({
        payTo: PAY_TO,
        price: "1.00",
        description: "Logo — final SVG",
        facilitator: "http://127.0.0.1:8081",
        ...overrides,
    });
}

/** `GET /paid` behind the paywall; the handler records what it saw in the context. */
function seller(middleware: ReturnType<typeof mapaePaywall>) {
    const seen: Seen = {served: 0};
    const app = new Hono();
    app.get("/paid", middleware, (c) => {
        seen.served += 1;
        seen.receipt = c.get("mapaeReceipt");
        return c.json({deliverable: "logo-final.svg", receipt: c.get("mapaeReceipt")});
    });
    return {app, seen};
}

const pay = (app: Hono, header = paymentHeader(), name = PAYMENT_SIGNATURE_HEADER) =>
    app.request(RESOURCE, {headers: {[name]: header}});

describe("mapaePaywall — construction", () => {
    test("rejects a payTo that is not a usable public address", () => {
        expect(() => paywall({payTo: "0xabc"})).toThrow(/public receiving address/);
        expect(() => paywall({payTo: `0x${"00".repeat(32)}`})).toThrow(/public receiving address/);
        expect(() => paywall({payTo: `0x${"00".repeat(20)}`})).toThrow(/zero address/);
    });

    test("rejects prices that are not positive tUSDC decimals", () => {
        for (const price of ["abc", "-1", "1.1234567", "0", "0.0", ""]) {
            expect(() => paywall({price}), price).toThrow();
        }
        expect(() => paywall({price: "0.000001"})).not.toThrow();
    });

    test("rejects a facilitator URL that is remote over http, carries credentials, or is not http(s)", () => {
        expect(() => paywall({facilitator: "http://facilitator.example"})).toThrow(/HTTPS/);
        expect(() => paywall({facilitator: "https://user:pw@facilitator.mapae.io"})).toThrow(
            /credentials/,
        );
        expect(() => paywall({facilitator: "ftp://facilitator.mapae.io"})).toThrow(/HTTP\(S\)/);
        expect(() => paywall({facilitator: "not a url"})).toThrow();
    });

    test("defaults to the public facilitator, and strips a trailing slash from a custom one", async () => {
        const remote = facilitator();
        await seller(paywall({facilitator: undefined, fetch: remote.fetch})).app.request(RESOURCE);
        expect(DEFAULT_FACILITATOR_URL).toBe("https://facilitator.mapae.io");
        expect(remote.calls[0]?.url).toBe("https://facilitator.mapae.io/supported");

        const local = facilitator();
        await seller(paywall({facilitator: "http://127.0.0.1:8081/", fetch: local.fetch})).app.request(
            RESOURCE,
        );
        expect(local.calls[0]?.url).toBe("http://127.0.0.1:8081/supported");
    });
});

describe("mapaePaywall — the 402 offer", () => {
    test("answers an unpaid request with the x402 v2 offer in header and body, and serves nothing", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await app.request(RESOURCE);
        expect(response.status).toBe(402);
        const body = await response.json();
        expect(body).toEqual({
            x402Version: X402_VERSION,
            resource: {url: RESOURCE, description: "Logo — final SVG"},
            accepts: [OFFER],
        });
        const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
        expect(header).toBeString();
        expect(decodePaymentRequiredHeader(header ?? "")).toEqual(body);
        expect(seen.served).toBe(0);
        expect(remote.calls).toEqual([
            {url: "http://127.0.0.1:8081/supported", path: "/supported", method: "GET"},
        ]);
    });

    test("copies the facilitator's advertised kind verbatim — no manager advertised, none offered", async () => {
        const remote = facilitator({
            "/supported": json(buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR]})),
        });
        const response = await seller(paywall({fetch: remote.fetch})).app.request(RESOURCE);
        const body = await response.json();
        expect(body.accepts[0].extra).toEqual({
            assetTransferMethod: "erc7710",
            facilitatorAddresses: [FACILITATOR],
        });
    });

    test("503 facilitator_unavailable while /supported is down, and asks again on the next request", async () => {
        let attempts = 0;
        const remote = facilitator({
            "/supported": () => {
                attempts += 1;
                if (attempts === 1) throw new TypeError("fetch failed");
                return Response.json(SUPPORTED);
            },
        });
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const first = await app.request(RESOURCE);
        expect(first.status).toBe(503);
        expect(await first.json()).toEqual({error: "facilitator_unavailable"});
        const second = await app.request(RESOURCE);
        expect(second.status).toBe(402);
        expect(remote.paths()).toEqual(["/supported", "/supported"]);
        expect(seen.served).toBe(0);
    });

    test("503 when /supported carries no usable GIWA ERC-7710 kind", async () => {
        const documents: unknown[] = [
            {kinds: [], extensions: [], signers: {}},
            {
                kinds: [
                    {
                        x402Version: 2,
                        scheme: "exact",
                        network: "eip155:8453",
                        extra: {assetTransferMethod: "erc7710", facilitatorAddresses: [FACILITATOR]},
                    },
                ],
            },
            {
                kinds: [
                    {
                        x402Version: 2,
                        scheme: "exact",
                        network: GIWA_SEPOLIA_CAIP2,
                        extra: {assetTransferMethod: "erc7710", facilitatorAddresses: []},
                    },
                ],
            },
            {
                kinds: [
                    {
                        x402Version: 2,
                        scheme: "exact",
                        network: GIWA_SEPOLIA_CAIP2,
                        extra: {assetTransferMethod: "erc7710", facilitatorAddresses: ["nope"]},
                    },
                ],
            },
            "not even an object",
        ];
        for (const document of documents) {
            const remote = facilitator({"/supported": json(document)});
            const response = await seller(paywall({fetch: remote.fetch})).app.request(RESOURCE);
            expect(response.status, JSON.stringify(document)).toBe(503);
        }
    });

    test("discovery is cached across requests", async () => {
        const remote = facilitator();
        const {app} = seller(paywall({fetch: remote.fetch}));
        await app.request(RESOURCE);
        await pay(app);
        expect(remote.paths()).toEqual(["/supported", "/verify", "/settle"]);
    });

    test("reads the legacy X-PAYMENT header as well as Payment-Signature", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app, paymentHeader(), LEGACY_PAYMENT_HEADER);
        expect(response.status).toBe(200);
        expect(seen.served).toBe(1);
    });
});

describe("mapaePaywall — malformed payments", () => {
    test("400 for a header over the size limit, before any facilitator call", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app, "A".repeat(150_001));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({error: "malformed_payment", detail: "header too large"});
        expect(remote.paths()).toEqual(["/supported"]);
        expect(seen.served).toBe(0);
    });

    test("400 for headers that are not an ERC-7710 payment, naming what was wrong", async () => {
        const cases: Array<[string, string]> = [
            ["not-base64!!", "invalid base64 JSON"],
            [
                btoa(JSON.stringify({x402Version: 2, accepted: {extra: {assetTransferMethod: "eip3009"}}})),
                "not an ERC-7710 payment",
            ],
            [
                btoa(JSON.stringify({x402Version: 2, accepted: OFFER, payload: {delegator: PAYER}})),
                "invalid delegation payload",
            ],
            [paymentHeader({delegator: "0xnope" as Address}), "invalid delegation payload"],
            [paymentHeader({permissionContext: "0x"}), "invalid delegation payload"],
        ];
        for (const [header, detail] of cases) {
            const remote = facilitator();
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app, header);
            expect(response.status, detail).toBe(400);
            expect(await response.json()).toEqual({error: "malformed_payment", detail});
            expect(remote.paths()).toEqual(["/supported"]);
            expect(seen.served).toBe(0);
        }
    });
});

describe("mapaePaywall — settle-before-serve ladder", () => {
    test("503 facilitator_unavailable when /verify cannot be reached; /settle is never tried", async () => {
        for (const verify of [refused, json({}, 500), json("garbage")]) {
            const remote = facilitator({"/verify": verify});
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status).toBe(503);
            expect(await response.json()).toEqual({error: "facilitator_unavailable"});
            expect(remote.paths()).toEqual(["/supported", "/verify"]);
            expect(seen.served).toBe(0);
        }
    });

    test("403 delegation_rejected when the facilitator refuses, or names a payer we did not send", async () => {
        for (const verify of [
            json({isValid: false, invalidReason: "delegation_rejected"}),
            json({isValid: true, payer: IMPOSTOR}),
            json({isValid: true}),
        ]) {
            const remote = facilitator({"/verify": verify});
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({error: "delegation_rejected"});
            expect(remote.paths()).toEqual(["/supported", "/verify"]);
            expect(seen.served).toBe(0);
        }
    });

    test("504 settlement_unknown when /settle is unreachable, unconfirmed, or names another payer", async () => {
        for (const settle of [
            refused,
            json({}, 502),
            json({...SETTLED, success: false, errorReason: SETTLEMENT_UNCONFIRMED}),
            json({...SETTLED, payer: IMPOSTOR}),
        ]) {
            const remote = facilitator({"/settle": settle});
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status).toBe(504);
            expect(await response.json()).toEqual({error: "settlement_unknown"});
            expect(seen.served).toBe(0);
        }
    });

    test("422 settlement_failed when the facilitator reports the transfer did not happen", async () => {
        const remote = facilitator({
            "/settle": json({success: false, network: GIWA_SEPOLIA_CAIP2, errorReason: "vendor_not_credited"}),
        });
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app);
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({error: "settlement_failed"});
        expect(seen.served).toBe(0);
    });

    test("serves after settlement: receipt in both headers, in the context, and in onSettled", async () => {
        const remote = facilitator();
        const settled: SettlementReceipt[] = [];
        const {app, seen} = seller(
            paywall({
                fetch: remote.fetch,
                onSettled: (receipt) => {
                    settled.push(receipt);
                },
            }),
        );
        const header = paymentHeader();
        const response = await pay(app, header);
        expect(response.status).toBe(200);
        expect(seen.served).toBe(1);

        const expectedReceipt: SettlementReceipt = {
            intent: seen.receipt?.intent ?? "0x",
            payer: PAYER,
            amount: "1.0",
            asset: MOCK_USDC.address,
            payTo: PAY_TO,
            network: GIWA_SEPOLIA_CAIP2,
            transaction: TX,
        };
        expect(seen.receipt).toEqual(expectedReceipt);
        expect(seen.receipt?.intent).toMatch(/^0x[0-9a-f]{64}$/);
        expect(settled).toEqual([expectedReceipt]);
        expect(await response.json()).toEqual({deliverable: "logo-final.svg", receipt: expectedReceipt});

        const wire = {success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER, transaction: TX};
        expect(JSON.parse(atob(response.headers.get(PAYMENT_RESPONSE_HEADER) ?? ""))).toEqual(wire);
        expect(response.headers.get(LEGACY_PAYMENT_RESPONSE_HEADER)).toBe(
            response.headers.get(PAYMENT_RESPONSE_HEADER),
        );

        // What the facilitator was sent: the decoded header and our own offer, as JSON.
        const request = {
            x402Version: X402_VERSION,
            paymentPayload: decodeAnyPaymentHeader(header),
            paymentRequirements: OFFER,
        };
        expect(remote.calls.slice(1)).toEqual([
            {
                url: "http://127.0.0.1:8081/verify",
                path: "/verify",
                method: "POST",
                contentType: "application/json",
                body: request,
            },
            {
                url: "http://127.0.0.1:8081/settle",
                path: "/settle",
                method: "POST",
                contentType: "application/json",
                body: request,
            },
        ]);
    });

    test("the receipt's intent is the id the facilitator's own validator derives", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const header = paymentHeader();
        await pay(app, header);
        const validated = validateDelegatedPayment(
            {
                x402Version: X402_VERSION,
                paymentPayload: decodeAnyPaymentHeader(header),
                paymentRequirements: OFFER,
            },
            {delegationManager: MANAGER, facilitator: FACILITATOR},
        );
        expect(validated.payer).toBe(PAYER);
        expect(seen.receipt?.intent).toBe(validated.paymentIntentId);
    });

    test("a settlement without a transaction hash still serves, with no transaction field", async () => {
        const remote = facilitator({
            "/settle": json({success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER}),
        });
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app);
        expect(response.status).toBe(200);
        expect(seen.receipt).not.toHaveProperty("transaction", expect.anything());
        expect(JSON.parse(atob(response.headers.get(PAYMENT_RESPONSE_HEADER) ?? ""))).toEqual({
            success: true,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
        });
    });

    test("onSettled runs before the handler, and a throw there still serves the buyer — redacted", async () => {
        const order: string[] = [];
        const remote = facilitator();
        const app = new Hono();
        app.get(
            "/paid",
            paywall({
                fetch: remote.fetch,
                onSettled: () => {
                    order.push("onSettled");
                    throw new Error("ledger down at http://user:secret@db.internal/orders");
                },
            }),
            (c) => {
                order.push("handler");
                return c.text("served");
            },
        );
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
            const response = await pay(app);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("served");
            expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeString();
            expect(order).toEqual(["onSettled", "handler"]);
            expect(error).toHaveBeenCalledTimes(1);
            const line = String(error.mock.calls[0]?.[0]);
            expect(line).toContain("onSettled threw");
            expect(line).not.toContain("secret");
        } finally {
            error.mockRestore();
        }
    });

    test("never prices or charges a route nothing serves", async () => {
        const remote = facilitator();
        const app = new Hono();
        app.use("/api/*", paywall({fetch: remote.fetch}));
        app.get("/api/thing", (c) => c.text("thing"));
        expect((await app.request("http://seller.test/api/nothing")).status).toBe(404);
        expect(
            (await app.request("http://seller.test/api/nothing", {
                headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader()},
            })).status,
        ).toBe(404);
        expect(remote.calls).toEqual([]);
        expect((await app.request("http://seller.test/api/thing")).status).toBe(402);
    });
});

describe("mapaeManifest", () => {
    test("serves the manifest a buyer's agent reads at /.well-known/mapae.json", async () => {
        expect(MAPAE_MANIFEST_PATH).toBe("/.well-known/mapae.json");
        const app = new Hono();
        app.get(
            MAPAE_MANIFEST_PATH,
            mapaeManifest({
                name: "  Logo shop ",
                payTo: PAY_TO.toLowerCase(),
                endpoints: [{path: "/paid", price: " 1.00 ", description: "Logo — final SVG"}],
            }),
        );
        const response = await app.request(`http://seller.test${MAPAE_MANIFEST_PATH}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            version: 1,
            name: "Logo shop",
            chain: "eip155:91342",
            asset: MOCK_USDC.address,
            payTo: PAY_TO,
            facilitator: DEFAULT_FACILITATOR_URL,
            endpoints: [{path: "/paid", price: "1.00", description: "Logo — final SVG"}],
        });
    });

    test("refuses at construction a manifest nobody could pay against", () => {
        const endpoint = {path: "/paid", price: "1.00", description: "Logo"};
        const valid = {name: "Shop", payTo: PAY_TO, endpoints: [endpoint]};
        expect(() => mapaeManifest(valid)).not.toThrow();
        expect(() => mapaeManifest({...valid, name: " "})).toThrow(/name/);
        expect(() => mapaeManifest({...valid, payTo: "0x1"})).toThrow(/payTo/);
        expect(() => mapaeManifest({...valid, facilitator: "http://remote.example"})).toThrow(/HTTPS/);
        expect(() => mapaeManifest({...valid, endpoints: [{...endpoint, price: "0"}]})).toThrow(/positive/);
        expect(() => mapaeManifest({...valid, endpoints: [{...endpoint, price: "1.1234567"}]})).toThrow();
        expect(() => mapaeManifest({...valid, endpoints: [{...endpoint, path: "paid"}]})).toThrow(/start with/);
        expect(() => mapaeManifest({...valid, endpoints: [{...endpoint, description: ""}]})).toThrow(
            /description/,
        );
    });
});
