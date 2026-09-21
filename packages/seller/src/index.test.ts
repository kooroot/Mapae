import {describe, expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    decodePaymentHeader,
    decodePaymentRequiredHeader,
    encodePaymentHeader,
    type Erc7710DelegationPayload,
} from "@mapae/shared";
import {ENTRY_POINT_V07} from "@mapae/delegation/config";
import {
    CLIENT_IP_HEADER,
    DELEGATION_REJECTED,
    FACILITATOR_NOT_READY,
    INVALID_PAYLOAD,
    RATE_LIMITED,
    SETTLEMENT_PENDING,
    SETTLEMENT_REVERTED,
    UNEXPECTED_SETTLE_ERROR,
    VENDOR_NOT_CREDITED,
} from "@mapae/delegation/facilitator-contract";
import {
    buildD3Policies,
    preparePeriodDelegation,
    withDelegationSignature,
} from "@mapae/delegation/policy";
import {validateDelegatedPayment} from "@mapae/delegation/x402";
import {
    DEFAULT_FACILITATOR_URL,
    MAPAE_MANIFEST_PATH,
    createMapae,
    mapaeManifest,
    mapaePaywall,
    type MapaeManifest,
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
    /** The buyer the paywall named in `X-Mapae-Client-IP`, when it named one. */
    clientIp?: string;
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
            clientIp: headers.get(CLIENT_IP_HEADER) ?? undefined,
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

const pay = (app: Hono, header = paymentHeader()) =>
    app.request(RESOURCE, {headers: {[PAYMENT_SIGNATURE_HEADER]: header}});

/** The x402 v2 `SettleResponse` a failing answer carries, decoded. */
function failureReceipt(response: Response): Record<string, unknown> {
    const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
    expect(header).toBeString();
    return JSON.parse(atob(header ?? "")) as Record<string, unknown>;
}

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
        expect(() => paywall({facilitator: "https://facilitator.mapae.io/?env=1"})).toThrow(/query/);
        expect(() => paywall({facilitator: "https://facilitator.mapae.io/#x"})).toThrow(/fragment/);
        expect(() => paywall({facilitator: "not a url"})).toThrow();
    });

    test("rejects a blank description — the offer and the manifest both show it", () => {
        expect(() => paywall({description: " "})).toThrow(/description/);
    });

    test("rejects a baseUrl that is not a bare http(s) origin", () => {
        expect(() => paywall({baseUrl: "https://user:pw@shop.example"})).toThrow(/credentials/);
        expect(() => paywall({baseUrl: "ftp://shop.example"})).toThrow(/HTTP\(S\)/);
        for (const baseUrl of ["https://shop.example/api", "https://shop.example/?env=1", "https://shop.example/#x"]) {
            expect(() => paywall({baseUrl}), baseUrl).toThrow(/origin/);
        }
        expect(() => paywall({baseUrl: "shop.example"})).toThrow();
        for (const baseUrl of ["https://shop.example", "https://shop.example/", "http://127.0.0.1:3000"]) {
            expect(() => paywall({baseUrl}), baseUrl).not.toThrow();
        }
    });

    test("rejects extensions JSON cannot carry — at boot, not in a buyer's 402", () => {
        expect(() => paywall({extensions: {budget: {info: 1n}}})).toThrow();
        expect(() => paywall({extensions: {mapae: {info: {seller: "demo-cafe"}}}})).not.toThrow();
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
            // 흐름 선언은 판매자의 것이고, 퍼실리테이터가 무엇을 광고하든 오퍼에 실린다.
            paymentFlow: "upfront",
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
        // Nobody presented a payment, so there is no settlement for a receipt to be about.
        // (An unreadable header does get one — see the 400 rungs. The rule is "a payment was
        // attempted", not "a payer is known".)
        expect(first.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
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

    test("keeps serving the last advertised kind when a re-fetch fails after the TTL, and spaces the retries", async () => {
        let attempts = 0;
        const remote = facilitator({
            "/supported": () => {
                attempts += 1;
                if (attempts > 1) throw new TypeError("fetch failed");
                return Response.json(SUPPORTED);
            },
        });
        const {app} = seller(paywall({fetch: remote.fetch}));
        const start = Date.now();
        const now = spyOn(Date, "now").mockReturnValue(start);
        try {
            expect((await app.request(RESOURCE)).status).toBe(402);
            now.mockReturnValue(start + 6 * 60_000);
            const response = await app.request(RESOURCE);
            expect(response.status).toBe(402);
            const body = await response.json();
            expect(body.accepts[0].extra.facilitatorAddresses).toEqual([FACILITATOR]);
            expect(remote.paths()).toEqual(["/supported", "/supported"]);
            // Within the retry window the failed re-fetch is not repeated per request.
            expect((await app.request(RESOURCE)).status).toBe(402);
            expect(remote.paths()).toHaveLength(2);
            now.mockReturnValue(start + 6 * 60_000 + 31_000);
            expect((await app.request(RESOURCE)).status).toBe(402);
            expect(remote.paths()).toHaveLength(3);
        } finally {
            now.mockRestore();
        }
    });

    test("discovery is cached across requests", async () => {
        const remote = facilitator();
        const {app} = seller(paywall({fetch: remote.fetch}));
        await app.request(RESOURCE);
        await pay(app);
        expect(remote.paths()).toEqual(["/supported", "/verify", "/settle"]);
    });

    test("advertises baseUrl + path as the resource, so a server behind a tunnel names its public URL", async () => {
        const remote = facilitator();
        const {app} = seller(paywall({fetch: remote.fetch, baseUrl: "https://shop.example/"}));
        const response = await app.request("http://127.0.0.1:3000/paid?table=4");
        expect(response.status).toBe(402);
        const body = await response.json();
        expect(body.resource).toEqual({url: "https://shop.example/paid", description: "Logo — final SVG"});
        expect(decodePaymentRequiredHeader(response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")).toEqual(body);

        // The path is taken as it arrived, still percent-encoded: the result is a URL.
        const shop = new Hono();
        shop.get("/s/:slug", paywall({fetch: remote.fetch, baseUrl: "https://shop.example"}), (c) => c.text("ok"));
        const encoded = await shop.request("http://127.0.0.1:3000/s/%EC%B9%B4%ED%8E%98");
        expect(((await encoded.json()) as {resource: {url: string}}).resource.url).toBe(
            "https://shop.example/s/%EC%B9%B4%ED%8E%98",
        );
    });

    test("carries extensions in the spec envelope, in the body and the Payment-Required header alike; absent, the slot is absent", async () => {
        // 스펙의 `extensions`는 확장 이름 → {info, schema} 맵이다. 불투명한 덩어리를
        // 통째로 싣던 시절과 달리, 판매자가 선언하는 내용은 `info` 아래에 있고
        // `schema`는 클라이언트가 에코할 형태를 기술할 때만 붙는다.
        const extensions = {
            mapae: {
                info: {seller: "demo-cafe", manifest: "https://shop.example/s/demo-cafe"},
                schema: {type: "object", properties: {seller: {type: "string"}}},
            },
        };
        const withThem = await seller(paywall({fetch: facilitator().fetch, extensions})).app.request(RESOURCE);
        expect(withThem.status).toBe(402);
        const body = await withThem.json();
        expect(body.extensions).toEqual(extensions);
        expect(body.extensions.mapae.info.seller).toBe("demo-cafe");
        expect(decodePaymentRequiredHeader(withThem.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")).toEqual(body);

        const without = await seller(paywall({fetch: facilitator().fetch})).app.request(RESOURCE);
        expect(await without.json()).not.toHaveProperty("extensions");
    });
});

describe("mapaePaywall — malformed payments", () => {
    test("400 for a header over the size limit, before any facilitator call", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app, "A".repeat(150_001));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({error: "malformed_payment", detail: "header too large"});
        // A payment was attempted, so it gets a receipt — the buyer's agent decides between
        // "fix the header" and "sign a new leaf" by machine, and the body's prose is for a
        // human. No payer: the name was inside the text that did not parse.
        expect(failureReceipt(response)).toEqual({
            success: false,
            errorReason: INVALID_PAYLOAD,
            network: GIWA_SEPOLIA_CAIP2,
            transaction: "",
        });
        // Checked separately because `toEqual` above would accept `payer: undefined`, and
        // the point of this rung is that no payer is *claimed* — not that a claimed one is
        // empty.
        expect(failureReceipt(response)).not.toHaveProperty("payer");
        expect(remote.calls).toEqual([]);
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
            // One §9 word for every way the text can be unreadable: the buyer's agent has
            // nothing to do differently between them, and `detail` already says which for a
            // human. The payer is unknown on all of them.
            expect(failureReceipt(response), detail).toEqual({
                success: false,
                errorReason: INVALID_PAYLOAD,
                network: GIWA_SEPOLIA_CAIP2,
                transaction: "",
            });
            expect(failureReceipt(response), detail).not.toHaveProperty("payer");
            expect(remote.calls).toEqual([]);
            expect(seen.served).toBe(0);
        }
    });

    test("a request with no payment header gets no receipt, even when /supported is down", async () => {
        // The 400s above refused a payment that was attempted. This request attempted none
        // — it asked what the resource costs — so there is no settlement for a receipt to
        // be the receipt of, and inventing one would have the seller answer a payment
        // nobody made. The 503 is the same rung either way; only the receipt differs.
        const remote = facilitator({"/supported": refused});
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await app.request(RESOURCE);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({error: "facilitator_unavailable"});
        expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
        expect(seen.served).toBe(0);
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
            // No verdict was obtained, so the receipt says not-ready and carries no offer:
            // the same payment may be presented again once the facilitator answers.
            expect(failureReceipt(response)).toEqual({
                success: false,
                errorReason: FACILITATOR_NOT_READY,
                network: GIWA_SEPOLIA_CAIP2,
                payer: PAYER,
                transaction: "",
            });
            expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
            expect(remote.paths()).toEqual(["/supported", "/verify"]);
            expect(seen.served).toBe(0);
        }
    });

    test("503 facilitator_unavailable when the facilitator refuses to look at either call — never 402 or 502", async () => {
        // /verify's not-ready answer rides a 503, unavailable before the body is read;
        // the reason in the body says the same under any status.
        for (const invalidReason of [RATE_LIMITED, FACILITATOR_NOT_READY]) {
            const throttledVerify = facilitator({"/verify": json({isValid: false, invalidReason})});
            const verify = seller(paywall({fetch: throttledVerify.fetch}));
            const refusedAtVerify = await pay(verify.app);
            expect(refusedAtVerify.status).toBe(503);
            expect(await refusedAtVerify.json()).toEqual({error: "facilitator_unavailable"});
            // The word the facilitator used, not a flattened one: the buyer's agent tells
            // "wait out the limiter" from "the facilitator is not ready" by reading it.
            expect(failureReceipt(refusedAtVerify).errorReason, invalidReason).toBe(invalidReason);
            expect(throttledVerify.paths()).toEqual(["/supported", "/verify"]);
            expect(verify.seen.served).toBe(0);
        }

        // /settle's refusals that examined nothing — the limiter, or a readiness probe
        // that failed — cannot use a status code, so they ride in the body's reason.
        for (const errorReason of [RATE_LIMITED, FACILITATOR_NOT_READY]) {
            const throttledSettle = facilitator({
                "/settle": json({success: false, network: GIWA_SEPOLIA_CAIP2, errorReason}),
            });
            const settle = seller(paywall({fetch: throttledSettle.fetch}));
            const refusedAtSettle = await pay(settle.app);
            expect(refusedAtSettle.status).toBe(503);
            expect(await refusedAtSettle.json()).toEqual({error: "facilitator_unavailable"});
            expect(failureReceipt(refusedAtSettle).errorReason, errorReason).toBe(errorReason);
            expect(throttledSettle.paths()).toEqual(["/supported", "/verify", "/settle"]);
            expect(settle.seen.served).toBe(0);
        }
    });

    test("a refused delegation is answered 402 with the offer re-issued, not 403", async () => {
        // The buyer can sign another leaf and pay again, which is what 402 means; 403 said
        // "this identity may not have it", which was never true of a payment that was
        // simply not accepted yet. The offer rides along so the agent needs no extra trip.
        for (const verify of [
            json({isValid: false, invalidReason: DELEGATION_REJECTED}),
            json({isValid: true, payer: IMPOSTOR}),
            json({isValid: true}),
        ]) {
            const remote = facilitator({"/verify": verify});
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status).toBe(402);
            const body = await response.json();
            expect(body).toEqual({
                x402Version: X402_VERSION,
                resource: {url: RESOURCE, description: "Logo — final SVG"},
                accepts: [OFFER],
            });
            expect(decodePaymentRequiredHeader(response.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")).toEqual(body);
            expect(failureReceipt(response)).toEqual({
                success: false,
                errorReason: DELEGATION_REJECTED,
                network: GIWA_SEPOLIA_CAIP2,
                payer: PAYER,
                transaction: "",
            });
            expect(remote.paths()).toEqual(["/supported", "/verify"]);
            expect(seen.served).toBe(0);
        }
    });

    test("the refusal's word is the facilitator's when we know it, and folded when we do not", async () => {
        // A facilitator's reason is free text on that wire, and this header is read by the
        // buyer's agent: only the closed vocabulary passes through.
        const cases: Array<[unknown, string]> = [
            ["invalid_transaction_state", "invalid_transaction_state"],
            ["payer_budget_exhausted", "payer_budget_exhausted"],
            // The seller's own word for the 400 rung is also one the facilitator produces,
            // for an `accepted` block that disagrees with the offer, and the fold passes it
            // through. So one word spans two rungs and the rung is read off the status.
            [INVALID_PAYLOAD, INVALID_PAYLOAD],
            ["ERC20PeriodTransferEnforcer:allowance-exceeded", DELEGATION_REJECTED],
            [undefined, DELEGATION_REJECTED],
        ];
        for (const [invalidReason, expected] of cases) {
            const remote = facilitator({"/verify": json({isValid: false, invalidReason})});
            const response = await pay(seller(paywall({fetch: remote.fetch})).app);
            expect(response.status, String(invalidReason)).toBe(402);
            expect(failureReceipt(response).errorReason, String(invalidReason)).toBe(expected);
        }
    });

    test("invalid_payload on the 402 rung names the payer the 400 rung cannot", async () => {
        // Same word, two rungs: the 400 answers a header nothing could read, so its receipt
        // names nobody, while a facilitator refusing a header that parsed leaves the payer
        // known. A client that read the rung off the word would confuse the two.
        const remote = facilitator({"/verify": json({isValid: false, invalidReason: INVALID_PAYLOAD})});
        const refused = await pay(seller(paywall({fetch: remote.fetch})).app);
        expect(refused.status).toBe(402);
        expect(failureReceipt(refused)).toEqual({
            success: false,
            errorReason: INVALID_PAYLOAD,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
            transaction: "",
        });
    });

    test("504 settlement_unknown when /settle is unreachable, pending, or names another payer", async () => {
        for (const settle of [
            refused,
            json({}, 502),
            json({...SETTLED, success: false, errorReason: SETTLEMENT_PENDING}),
            json({...SETTLED, payer: IMPOSTOR}),
        ]) {
            const remote = facilitator({"/settle": settle});
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status).toBe(504);
            expect(await response.json()).toEqual({error: "settlement_unknown"});
            // No offer: a payment that may have been charged must not be invited again.
            expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
            expect(failureReceipt(response).errorReason).toBe(SETTLEMENT_PENDING);
            expect(seen.served).toBe(0);
        }
    });

    test("the pending receipt carries the hash whenever the facilitator named one", async () => {
        // It is the buyer's only way to find out for themselves whether they were charged.
        const remote = facilitator({
            "/settle": json({...SETTLED, success: false, errorReason: SETTLEMENT_PENDING}),
        });
        const withHash = await pay(seller(paywall({fetch: remote.fetch})).app);
        expect(failureReceipt(withHash)).toEqual({
            success: false,
            errorReason: SETTLEMENT_PENDING,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
            transaction: TX,
        });
        // And spells "no hash" the way the spec does when there is none to name.
        const lost = facilitator({"/settle": refused});
        const without = await pay(seller(paywall({fetch: lost.fetch})).app);
        expect(failureReceipt(without).transaction).toBe("");
    });

    test("502 settlement_misdirected when the redemption credited someone else — and no offer", async () => {
        // The buyer's balance moved, so re-offering would take a second payment for one
        // sale. The hash goes out with it: it is what names the movement.
        const remote = facilitator({
            "/settle": json({
                success: false,
                network: GIWA_SEPOLIA_CAIP2,
                transaction: TX,
                errorReason: VENDOR_NOT_CREDITED,
            }),
        });
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({error: "settlement_misdirected"});
        expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
        expect(failureReceipt(response)).toEqual({
            success: false,
            errorReason: VENDOR_NOT_CREDITED,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
            transaction: TX,
        });
        expect(seen.served).toBe(0);
    });

    test("504 settlement_unknown when a settle failure names a hash under any other word", async () => {
        // The word says a refusal formed before the broadcast — the fold makes every word
        // that reaches `failed` say that — and the hash says something went out anyway. The
        // offer must not go back with it: "pay again" over a mined transaction is how one
        // sale takes two payments. Our own facilitator writes `""` on every rejection, so
        // this is the shape a third-party facilitator arrives in.
        for (const errorReason of ["token_transfer_partially_applied", DELEGATION_REJECTED, undefined]) {
            const remote = facilitator({
                "/settle": json({success: false, network: GIWA_SEPOLIA_CAIP2, transaction: TX, errorReason}),
            });
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status, String(errorReason)).toBe(504);
            expect(await response.json()).toEqual({error: "settlement_unknown"});
            expect(response.headers.get(PAYMENT_REQUIRED_HEADER), String(errorReason)).toBeNull();
            expect(failureReceipt(response), String(errorReason)).toEqual({
                success: false,
                errorReason: SETTLEMENT_PENDING,
                network: GIWA_SEPOLIA_CAIP2,
                payer: PAYER,
                transaction: TX,
            });
            expect(seen.served).toBe(0);
        }
    });

    test("504 settlement_unknown for §9's unexpected settle error, hash or no hash", async () => {
        // It names no point in the sequence, so it cannot be answered "nobody was charged".
        for (const transaction of ["", TX]) {
            const remote = facilitator({
                "/settle": json({
                    success: false,
                    network: GIWA_SEPOLIA_CAIP2,
                    transaction,
                    errorReason: UNEXPECTED_SETTLE_ERROR,
                }),
            });
            const response = await pay(seller(paywall({fetch: remote.fetch})).app);
            expect(response.status, transaction).toBe(504);
            expect(response.headers.get(PAYMENT_REQUIRED_HEADER), transaction).toBeNull();
            expect(failureReceipt(response).transaction, transaction).toBe(transaction);
        }
    });

    test("every other settlement failure charged nobody, so the offer is re-issued", async () => {
        // `settlement_reverted` is the one word that may bring a hash here: the redemption
        // was mined and reverted, so the asset never moved and the offer is safe to re-issue.
        // The facilitator read that off the receipt; every other word claims a refusal
        // formed before the broadcast, and one arriving with a hash goes to 504 above.
        const cases: Array<[string, Hex | ""]> = [
            [SETTLEMENT_REVERTED, TX],
            [SETTLEMENT_REVERTED, ""],
            ["payer_budget_exhausted", ""],
            [DELEGATION_REJECTED, ""],
        ];
        for (const [errorReason, transaction] of cases) {
            const remote = facilitator({
                "/settle": json({success: false, network: GIWA_SEPOLIA_CAIP2, transaction, errorReason}),
            });
            const {app, seen} = seller(paywall({fetch: remote.fetch}));
            const response = await pay(app);
            expect(response.status, errorReason).toBe(402);
            expect(((await response.json()) as {accepts: unknown}).accepts).toEqual([OFFER]);
            expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeString();
            expect(failureReceipt(response).errorReason, errorReason).toBe(errorReason);
            expect(failureReceipt(response).transaction, errorReason).toBe(transaction);
            expect(seen.served).toBe(0);
        }
    });

    test("a payment presented while /supported is down still gets a receipt naming its payer", async () => {
        const remote = facilitator({"/supported": refused});
        const response = await pay(seller(paywall({fetch: remote.fetch})).app);
        expect(response.status).toBe(503);
        expect(failureReceipt(response)).toEqual({
            success: false,
            errorReason: FACILITATOR_NOT_READY,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
            transaction: "",
        });
    });

    test("every answer is uncacheable and keyed on the payment header", async () => {
        // A shared cache that ignored this would hand a paid body to a request that did not
        // pay, or hand a 402 to one that did. It is the paywall's word, not the handler's.
        const cases: Array<[string, () => Response | Promise<Response>]> = [
            ["402 offer", () => seller(paywall({fetch: facilitator().fetch})).app.request(RESOURCE)],
            ["400 malformed", () => pay(seller(paywall({fetch: facilitator().fetch})).app, "not-base64!!")],
            [
                "503 unavailable",
                () => pay(seller(paywall({fetch: facilitator({"/supported": refused}).fetch})).app),
            ],
            [
                "402 refused",
                () => pay(seller(paywall({fetch: facilitator({"/verify": json({isValid: false})}).fetch})).app),
            ],
            ["504 unknown", () => pay(seller(paywall({fetch: facilitator({"/settle": refused}).fetch})).app)],
            [
                "502 misdirected",
                () =>
                    pay(
                        seller(
                            paywall({
                                fetch: facilitator({
                                    "/settle": json({
                                        success: false,
                                        network: GIWA_SEPOLIA_CAIP2,
                                        transaction: TX,
                                        errorReason: VENDOR_NOT_CREDITED,
                                    }),
                                }).fetch,
                            }),
                        ).app,
                    ),
            ],
            ["200 served", () => pay(seller(paywall({fetch: facilitator().fetch})).app)],
        ];
        for (const [name, request] of cases) {
            const response = await request();
            expect(response.headers.get("cache-control"), name).toBe("no-store");
            expect(response.headers.get("vary"), name).toBe(PAYMENT_SIGNATURE_HEADER);
        }
    });

    test("the receipt says when the facilitator answered out of its own record", async () => {
        // A recovered settlement is the same body as a fresh one but for this word. It is
        // not a delivery gate — once a first attempt ends pending, every later success is
        // marked — so the seller reads it as "some other call did this" and dedupes on the
        // intent id instead.
        const remote = facilitator({"/settle": json({...SETTLED, replayed: true})});
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        expect((await pay(app)).status).toBe(200);
        expect(seen.receipt?.replayed).toBe(true);
        expect(seen.served).toBe(1);

        const fresh = seller(paywall({fetch: facilitator().fetch}));
        await pay(fresh.app);
        expect(fresh.seen.receipt?.replayed).toBe(false);
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
            replayed: false,
        };
        expect(seen.receipt).toEqual(expectedReceipt);
        expect(seen.receipt?.intent).toMatch(/^0x[0-9a-f]{64}$/);
        expect(settled).toEqual([expectedReceipt]);
        expect(await response.json()).toEqual({deliverable: "logo-final.svg", receipt: expectedReceipt});

        const wire = {success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER, transaction: TX};
        expect(JSON.parse(atob(response.headers.get(PAYMENT_RESPONSE_HEADER) ?? ""))).toEqual(wire);

        // What the facilitator was sent: the decoded header and our own offer, as JSON.
        const request = {
            x402Version: X402_VERSION,
            paymentPayload: decodePaymentHeader(header),
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
                paymentPayload: decodePaymentHeader(header),
                paymentRequirements: OFFER,
            },
            {delegationManager: MANAGER, facilitator: FACILITATOR},
        );
        expect(validated.payer).toBe(PAYER);
        expect(seen.receipt?.intent).toBe(validated.paymentIntentId);
    });

    test("a settlement without a transaction hash still serves, and the receipt says \"\"", async () => {
        const remote = facilitator({
            "/settle": json({success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER}),
        });
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        const response = await pay(app);
        expect(response.status).toBe(200);
        expect(seen.receipt).not.toHaveProperty("transaction", expect.anything());
        // The wire receipt still carries the key: the spec's "no hash" is `""`.
        expect(JSON.parse(atob(response.headers.get(PAYMENT_RESPONSE_HEADER) ?? ""))).toEqual({
            success: true,
            network: GIWA_SEPOLIA_CAIP2,
            payer: PAYER,
            transaction: "",
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
        const unpriced = await app.request("http://seller.test/api/nothing");
        expect(unpriced.status).toBe(404);
        // The cache headers are set before this rung, so "every answer" is a claim about
        // every answer: the 404 is the one that leaves before the ladder starts.
        expect(unpriced.headers.get("cache-control")).toBe("no-store");
        expect(unpriced.headers.get("vary")).toBe(PAYMENT_SIGNATURE_HEADER);
        // A request that did carry a payment gets the same 404 and no receipt: this rung
        // returns before the header is read, so it is the second answer without one. The
        // docs claim two such answers, not "only the request that sent no payment".
        const withPayment = await app.request("http://seller.test/api/nothing", {
            headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader()},
        });
        expect(withPayment.status).toBe(404);
        expect(withPayment.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
        expect(remote.calls).toEqual([]);
        expect((await app.request("http://seller.test/api/thing")).status).toBe(402);
    });
});

const LOCAL_FACILITATOR = "http://127.0.0.1:8081";
const OTHER_PAY_TO = getAddress("0x2000000000000000000000000000000000000002");

describe("mapaePaywall — naming the buyer to the facilitator", () => {
    const BUYER = "203.0.113.5";
    const payFrom = (app: Hono, headers: Record<string, string>) =>
        app.request(RESOURCE, {headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader(), ...headers}});
    const forwarded = (remote: ReturnType<typeof facilitator>) =>
        remote.calls.map((call) => [call.path, call.clientIp]);

    test("the buyer's CF-Connecting-IP rides on /verify and /settle as X-Mapae-Client-IP", async () => {
        const remote = facilitator();
        const {app, seen} = seller(paywall({fetch: remote.fetch}));
        expect((await payFrom(app, {"cf-connecting-ip": BUYER})).status).toBe(200);
        expect(seen.served).toBe(1);
        // /supported is about the facilitator, not a buyer, and is cached across buyers.
        expect(forwarded(remote)).toEqual([
            ["/supported", undefined],
            ["/verify", BUYER],
            ["/settle", BUYER],
        ]);
    });

    test("a request without CF-Connecting-IP names nobody", async () => {
        const remote = facilitator();
        const {app} = seller(paywall({fetch: remote.fetch}));
        expect((await pay(app)).status).toBe(200);
        expect(forwarded(remote)).toEqual([
            ["/supported", undefined],
            ["/verify", undefined],
            ["/settle", undefined],
        ]);
    });

    test("a remote facilitator is told nothing about the buyer", async () => {
        // The facilitator reads X-Mapae-Client-IP only from a caller whose address it
        // cannot see. Through the tunnel it sees this server's, so the buyer's address
        // would cross the internet only to be ignored.
        const remote = facilitator();
        const {app, seen} = seller(
            paywall({facilitator: "https://facilitator.example", fetch: remote.fetch}),
        );
        expect((await payFrom(app, {"cf-connecting-ip": BUYER})).status).toBe(200);
        expect(seen.served).toBe(1);
        expect(forwarded(remote)).toEqual([
            ["/supported", undefined],
            ["/verify", undefined],
            ["/settle", undefined],
        ]);
    });

    test("an X-Mapae-Client-IP the buyer sent is never passed through", async () => {
        // Forwarding it would let a buyer with no CF-Connecting-IP pick whose window they
        // are counted in. Beside a CF-Connecting-IP it is simply not the buyer's address.
        const remote = facilitator();
        const {app} = seller(paywall({fetch: remote.fetch}));
        expect((await payFrom(app, {[CLIENT_IP_HEADER]: "198.51.100.7"})).status).toBe(200);
        expect(forwarded(remote)).toEqual([
            ["/supported", undefined],
            ["/verify", undefined],
            ["/settle", undefined],
        ]);
        remote.calls.length = 0;
        expect(
            (await payFrom(app, {"cf-connecting-ip": BUYER, [CLIENT_IP_HEADER]: "198.51.100.7"})).status,
        ).toBe(200);
        expect(forwarded(remote)).toEqual([
            ["/verify", BUYER],
            ["/settle", BUYER],
        ]);
    });
});

describe("createMapae", () => {
    test("shares one facilitator client across its paywalls: two routes, one /supported fetch", async () => {
        const remote = facilitator();
        const mapae = createMapae({facilitator: `${LOCAL_FACILITATOR}/`, fetch: remote.fetch});
        expect(mapae.facilitator).toBe(LOCAL_FACILITATOR);
        const app = new Hono();
        app.get(
            "/logo",
            mapae.paywall({payTo: PAY_TO, price: "1.00", description: "Logo"}),
            (c) => c.text("logo"),
        );
        app.get(
            "/spec",
            mapae.paywall({payTo: PAY_TO, price: "2.50", description: "Spec"}),
            (c) => c.text("spec"),
        );
        expect((await app.request("http://seller.test/logo")).status).toBe(402);
        expect((await app.request("http://seller.test/spec")).status).toBe(402);
        expect(remote.paths()).toEqual(["/supported"]);

        const paid = await app.request("http://seller.test/logo", {
            headers: {[PAYMENT_SIGNATURE_HEADER]: paymentHeader()},
        });
        expect(paid.status).toBe(200);
        expect(await paid.text()).toBe("logo");
        expect(remote.paths()).toEqual(["/supported", "/verify", "/settle"]);
    });

    test("a createMapae paywall never prices or charges a route nothing serves", async () => {
        const remote = facilitator();
        const mapae = createMapae({facilitator: LOCAL_FACILITATOR, fetch: remote.fetch});
        const app = new Hono();
        app.use("/api/*", mapae.paywall({payTo: PAY_TO, price: "1.00", description: "API"}));
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

describe("mapaeManifest — derived from the mounted paywalls", () => {
    async function manifest(app: Hono): Promise<MapaeManifest> {
        const response = await app.request(`http://seller.test${MAPAE_MANIFEST_PATH}`);
        expect(response.status).toBe(200);
        return (await response.json()) as MapaeManifest;
    }

    test("lists each paywall's method, path, price, description and own payTo, sorted by path then method; other routes are ignored", async () => {
        expect(MAPAE_MANIFEST_PATH).toBe("/.well-known/mapae.json");
        const mapae = createMapae({facilitator: LOCAL_FACILITATOR, fetch: facilitator().fetch});
        const app = new Hono();
        app.use("*", async (_c, next) => {
            await next();
        });
        app.get("/health", (c) => c.json({ok: true}));
        // Mounted before the paywalls on purpose: the app is read on the first request, not here.
        app.get(MAPAE_MANIFEST_PATH, mapae.manifest({name: "  Logo shop ", app}));
        app.post(
            "/reports",
            mapae.paywall({payTo: OTHER_PAY_TO, price: "2.50", description: "Custom report"}),
            (c) => c.text("made"),
        );
        app.get(
            "/reports/:id",
            mapae.paywall({payTo: PAY_TO.toLowerCase(), price: " 1.00 ", description: "One report"}),
            (c) => c.text("one"),
        );
        app.get(
            "/reports",
            mapae.paywall({payTo: PAY_TO, price: "0.10", description: "Report index"}),
            (c) => c.text("index"),
        );
        expect(await manifest(app)).toEqual({
            version: 1,
            name: "Logo shop",
            chain: "eip155:91342",
            asset: MOCK_USDC.address,
            facilitator: LOCAL_FACILITATOR,
            endpoints: [
                {method: "GET", path: "/reports", price: "0.10", description: "Report index", payTo: PAY_TO},
                {method: "POST", path: "/reports", price: "2.50", description: "Custom report", payTo: OTHER_PAY_TO},
                {method: "GET", path: "/reports/:id", price: "1.00", description: "One report", payTo: PAY_TO},
            ],
        });
    });

    test("reads the app once, on the first request, and keeps the result", async () => {
        const mapae = createMapae({facilitator: LOCAL_FACILITATOR, fetch: facilitator().fetch});
        const app = new Hono();
        app.get(
            "/early",
            mapae.paywall({payTo: PAY_TO, price: "1.00", description: "Early"}),
            (c) => c.text("early"),
        );
        // A stand-in for `app` whose route list can be swapped between requests — Hono
        // itself refuses a new route once the first request has been matched, so this is
        // the only way to show the second request never looks again.
        let routes = app.routes;
        let reads = 0;
        const catalogue = {
            get routes() {
                reads += 1;
                return routes;
            },
        };
        app.get(MAPAE_MANIFEST_PATH, mapaeManifest({name: "Shop", app: catalogue}));
        expect(reads).toBe(0);
        const first = await manifest(app);
        expect(first.facilitator).toBe(DEFAULT_FACILITATOR_URL);
        expect(first.endpoints.map((endpoint) => endpoint.path)).toEqual(["/early"]);
        routes = [];
        expect((await manifest(app)).endpoints.map((endpoint) => endpoint.path)).toEqual(["/early"]);
        expect(reads).toBe(1);
    });

    test("sees paywalls behind basePath() and app.route() under their mounted prefix — also when the sub-app has its own onError", async () => {
        const mapae = createMapae({facilitator: LOCAL_FACILITATOR, fetch: facilitator().fetch});
        const plain = new Hono();
        plain.get(
            "/logo",
            mapae.paywall({payTo: PAY_TO, price: "1.00", description: "Logo"}),
            (c) => c.text("logo"),
        );
        const guarded = new Hono().onError((_error, c) => c.text("guarded", 500));
        guarded.get(
            "/spec",
            mapae.paywall({payTo: PAY_TO, price: "2.00", description: "Spec"}),
            (c) => c.text("spec"),
        );
        const app = new Hono();
        const v1 = app.basePath("/v1");
        v1.route("/design", plain);
        v1.route("/docs", guarded);
        app.get(MAPAE_MANIFEST_PATH, mapaeManifest({name: "Shop", app}));
        expect((await manifest(app)).endpoints.map((e) => [e.method, e.path, e.price])).toEqual([
            ["GET", "/v1/design/logo", "1.00"],
            ["GET", "/v1/docs/spec", "2.00"],
        ]);
        // The wrapped paywall is still the paywall.
        expect((await app.request("http://seller.test/v1/docs/spec")).status).toBe(402);
    });

    test("lists a paywall mounted with app.use on a wildcard as ALL on its pattern", async () => {
        const mapae = createMapae({facilitator: LOCAL_FACILITATOR, fetch: facilitator().fetch});
        const app = new Hono();
        app.use("/api/*", mapae.paywall({payTo: PAY_TO, price: "0.01", description: "Any API call"}));
        app.get("/api/thing", (c) => c.text("thing"));
        app.get(MAPAE_MANIFEST_PATH, mapaeManifest({name: "Shop", app}));
        expect((await manifest(app)).endpoints).toEqual([
            {method: "ALL", path: "/api/*", price: "0.01", description: "Any API call", payTo: PAY_TO},
        ]);
    });

    test("refuses at construction a manifest without a name, or advertising a facilitator nobody should trust", () => {
        const app = new Hono();
        expect(() => mapaeManifest({name: "Shop", app})).not.toThrow();
        expect(() => mapaeManifest({name: " ", app})).toThrow(/name/);
        expect(() => mapaeManifest({name: "Shop", app, facilitator: "http://remote.example"})).toThrow(/HTTPS/);
        expect(() => createMapae().manifest({name: " ", app})).toThrow(/name/);
    });
});

/**
 * The published shape, guarded from the inside.
 *
 * `files` ships `dist` and nothing else, so an `exports` condition pointing anywhere else
 * resolves to a path the tarball does not contain. A `"bun": "./src/index.ts"` condition
 * did exactly that: convenient in this workspace, and a hard `Cannot find module` for every
 * Bun consumer who installed the package. Node never noticed, because it never reads that
 * condition — which is why this is a manifest assertion and not a smoke test.
 */
describe("published package shape", () => {
    const manifest = require("../package.json") as {
        files: string[];
        exports: Record<string, Record<string, string>>;
    };

    function targets(node: unknown): string[] {
        if (typeof node === "string") return [node];
        if (node && typeof node === "object") return Object.values(node).flatMap(targets);
        return [];
    }

    test("ships dist", () => {
        expect(manifest.files).toContain("dist");
    });

    test("every exports target resolves inside the shipped dist", () => {
        const all = targets(manifest.exports);
        expect(all.length).toBeGreaterThan(0);
        for (const target of all) expect(target.startsWith("./dist/")).toBe(true);
    });
});
