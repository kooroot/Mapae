import {describe, expect, spyOn, test} from "bun:test";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    decodePaymentRequiredHeader,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {createMapae, type MapaeOptions} from "@mapae/seller";
import {IN_MEMORY, openStore, type MapaeStore} from "@mapae/store";
import {
    PICKUP_LINE,
    TICKET_LINE,
    TRIAL_NOTICE,
    createShopApp,
    displayAmount,
    type ShopManifest,
    type TicketResponse,
} from "./app.js";
import {DEMO_SHOPS, seedShops} from "./seed.js";
import {
    FACILITATOR_ROUTES,
    LEAF_A,
    LEAF_B,
    PAY_TO,
    PAYER,
    TX,
    paymentHeader,
    type FacilitatorPath,
    type FacilitatorRoute,
} from "./test-support.js";

/**
 * Hermetic: an in-memory store seeded with the demo shops and a facilitator made of
 * stub routes behind the injected fetch. No chain, no network, no key. The paywall's
 * own ladder is proven in `packages/seller`; what is proven here is the shop around
 * it — lookup before pricing, the order written once, the replay paths.
 */

const BASE_URL = "http://shop.test";
const METRICS_TOKEN = "metrics-token-sixteen+";
const NOW = 1_800_000_000_000;

/** A facilitator made of routes behind the injected fetch; a path without one is a refused connection. */
function facilitator(routes: Partial<Record<FacilitatorPath, FacilitatorRoute>> = {}) {
    const paths: string[] = [];
    const table: Record<FacilitatorPath, FacilitatorRoute> = {...FACILITATOR_ROUTES, ...routes};
    const fetch: NonNullable<MapaeOptions["fetch"]> = async (input) => {
        const path = new URL(input).pathname;
        paths.push(path);
        const route = table[path as FacilitatorPath];
        if (!route) throw new TypeError("fetch failed");
        return route();
    };
    return {fetch, paths};
}

const ONE = 1_000_000n;
const AMERICANO = "/s/demo-cafe/americano";
const CROISSANT = "/s/demo-cafe/croissant";
const LOGO = "/s/demo-studio/logo";

function shop(options: {metricsToken?: string; store?: MapaeStore} = {}) {
    const store = options.store ?? openStore(IN_MEMORY);
    seedShops(store, PAY_TO, NOW);
    const stub = facilitator();
    const mapae = createMapae({facilitator: "http://127.0.0.1:8081", fetch: stub.fetch, baseUrl: BASE_URL});
    const app = createShopApp({
        store,
        mapae,
        baseUrl: BASE_URL,
        name: "테스트 상점",
        ...(options.metricsToken === undefined ? {} : {metricsToken: options.metricsToken}),
    });
    const get = (path: string, headers: Record<string, string> = {}) =>
        app.request(`${BASE_URL}${path}`, {headers});
    const pay = (path: string, header: string) => get(path, {[PAYMENT_SIGNATURE_HEADER]: header});
    return {store, app, stub, get, pay};
}

async function ticketOf(response: Response): Promise<TicketResponse> {
    expect(response.status).toBe(200);
    return (await response.json()) as TicketResponse;
}

/** Visible text of the page's body, one trimmed line per source line, blanks dropped. */
function bodyLines(page: string): string[] {
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "";
    return body
        .replace(/<[^>]+>/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

describe("lookup — nothing is priced that nothing serves", () => {
    test("an unknown shop or item is 404 before the facilitator is asked", async () => {
        const {get, stub} = shop();
        expect((await get("/s/nope")).status).toBe(404);
        expect(await (await get("/s/nope")).json()).toEqual({error: "unknown_shop"});
        expect((await get("/s/nope/americano")).status).toBe(404);
        const item = await get("/s/demo-cafe/nope");
        expect(item.status).toBe(404);
        expect(await item.json()).toEqual({error: "unknown_item"});
        expect(stub.paths).toEqual([]);
    });

    test("segments the store would refuse are 404, not 500", async () => {
        const {get} = shop();
        for (const path of ["/s/Demo-Cafe", "/s/demo_cafe/americano", "/s/demo-cafe/Americano", `/s/${"a".repeat(65)}`]) {
            expect((await get(path)).status, path).toBe(404);
        }
        expect(await (await get("/s/demo-cafe/americano/extra")).json()).toEqual({error: "not_found"});
    });

    test("an external seller is not served by the hosted shop", async () => {
        const {store, get} = shop();
        store.sellers.upsert({
            slug: "elsewhere",
            kind: "external",
            name: "밖의 가게",
            payTo: PAY_TO,
            baseUrl: "https://elsewhere.test",
            internal: false,
            createdAt: NOW,
        });
        expect((await get("/s/elsewhere")).status).toBe(404);
    });
});

describe("402 — the offer", () => {
    test("carries the item's price, the seller's payTo and extensions.mapae", async () => {
        const {get} = shop();
        const response = await get(AMERICANO);
        expect(response.status).toBe(402);
        const body = (await response.json()) as PaymentRequired<Erc7710PaymentRequirements>;
        expect(body.resource?.url).toBe(`${BASE_URL}${AMERICANO}`);
        expect(body.resource?.description).toBe("데모 카페 — 아메리카노");
        expect(body.accepts[0]?.amount).toBe(ONE.toString());
        expect(body.accepts[0]?.payTo).toBe(PAY_TO);
        expect(body.accepts[0]?.network).toBe(GIWA_SEPOLIA_CAIP2);
        expect(body.extensions).toEqual({
            mapae: {seller: {slug: "demo-cafe", name: "데모 카페"}, manifest: `${BASE_URL}/s/demo-cafe`},
        });
        const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
        expect(header).not.toBeNull();
        expect(decodePaymentRequiredHeader(header ?? "")).toEqual(body);
    });

    test("each item is its own price", async () => {
        const {get} = shop();
        const body = (await (await get(CROISSANT)).json()) as PaymentRequired<Erc7710PaymentRequirements>;
        expect(body.accepts[0]?.amount).toBe("2500000");
        expect(body.resource?.description).toBe("데모 카페 — 크루아상");
    });
});

describe("ticket — one payment, one ticket", () => {
    test("a settled payment yields a ticket and exactly one order row", async () => {
        const {store, pay, stub} = shop();
        const {ticket, receipt} = await ticketOf(await pay(AMERICANO, paymentHeader(ONE, LEAF_A)));
        expect(ticket).toEqual({
            order: 1,
            shop: {slug: "demo-cafe", name: "데모 카페"},
            item: {key: "americano", name: "아메리카노"},
            amount: "1.00 tUSDC",
            transaction: TX,
            issuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            message: TICKET_LINE,
        });
        expect(receipt.method).toBe("erc7710");
        expect(receipt.intent).toMatch(/^0x[0-9a-f]{64}$/);
        expect(receipt.payer).toBe(PAYER);
        expect(receipt.payTo).toBe(PAY_TO);
        expect(stub.paths).toEqual(["/supported", "/verify", "/settle"]);

        const orders = store.orders.listBySeller("demo-cafe");
        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({
            id: 1,
            sellerSlug: "demo-cafe",
            itemKey: "americano",
            paymentIntentId: receipt.intent,
            payer: PAYER,
            amountBase: ONE,
            txHash: TX,
            status: "paid",
        });
    });

    test("same-intent replay returns the same ticket", async () => {
        const {store, pay} = shop();
        const header = paymentHeader(ONE, LEAF_A);
        const first = await ticketOf(await pay(AMERICANO, header));
        const again = await ticketOf(await pay(AMERICANO, header));
        expect(again.receipt.intent).toBe(first.receipt.intent);
        expect(again.ticket).toEqual(first.ticket);
        expect(store.orders.summary({sinceMs: 0})).toEqual({total: 1, bySeller: {"demo-cafe": 1}});
    });

    test("two leaves for one item are two intents and two tickets", async () => {
        const {store, pay} = shop();
        const first = await ticketOf(await pay(AMERICANO, paymentHeader(ONE, LEAF_A)));
        const second = await ticketOf(await pay(AMERICANO, paymentHeader(ONE, LEAF_B)));
        expect(second.receipt.intent).not.toBe(first.receipt.intent);
        expect([first.ticket.order, second.ticket.order]).toEqual([1, 2]);
        expect(store.orders.listBySeller("demo-cafe").map((order) => order.itemKey)).toEqual(["americano", "americano"]);
    });

    test("same-price cross-item replay returns the ORIGINAL ticket and never delivers the second item", async () => {
        const {store, pay} = shop();
        // The logo costs what the americano costs and both shops pay to one address, so
        // the header is byte-for-byte a valid payment for either offer.
        const header = paymentHeader(ONE, LEAF_A);
        const original = await ticketOf(await pay(AMERICANO, header));
        const replay = await ticketOf(await pay(LOGO, header));
        expect(replay.receipt.intent).toBe(original.receipt.intent);
        expect(replay.ticket).toEqual(original.ticket);
        expect(replay.ticket.item.key).toBe("americano");
        expect(replay.ticket.shop.slug).toBe("demo-cafe");
        expect(store.orders.listBySeller("demo-studio")).toEqual([]);
        expect(store.orders.summary({sinceMs: 0})).toEqual({total: 1, bySeller: {"demo-cafe": 1}});
    });

    test("the same price under a fresh leaf is a fresh order for the other item", async () => {
        const {store, pay} = shop();
        await ticketOf(await pay(AMERICANO, paymentHeader(ONE, LEAF_A)));
        const logo = await ticketOf(await pay(LOGO, paymentHeader(ONE, LEAF_B)));
        expect(logo.ticket).toMatchObject({order: 2, shop: {slug: "demo-studio"}, item: {key: "logo", name: "로고 시안"}});
        expect(store.orders.summary({sinceMs: 0})).toEqual({total: 2, bySeller: {"demo-cafe": 1, "demo-studio": 1}});
    });

    test("a ledger that cannot be written is a 500, not a made-up ticket", async () => {
        const store = openStore(IN_MEMORY);
        const broken: MapaeStore = {
            ...store,
            orders: {
                ...store.orders,
                createOnce: () => {
                    throw new Error("disk full");
                },
            },
        };
        const quiet = spyOn(console, "error").mockImplementation(() => {});
        try {
            const {pay} = shop({store: broken});
            const response = await pay(AMERICANO, paymentHeader(ONE, LEAF_A));
            expect(response.status).toBe(500);
            expect(await response.json()).toEqual({error: "order_not_recorded"});
            expect(quiet).toHaveBeenCalledTimes(1);
        } finally {
            quiet.mockRestore();
        }
    });
});

describe("manifest — JSON for an agent, a page for a person", () => {
    const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    test("JSON by default, with every item priced and addressed", async () => {
        const {get} = shop();
        const response = await get("/s/demo-cafe");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        const manifest = (await response.json()) as ShopManifest;
        expect(manifest).toEqual({
            version: 1,
            notice: TRIAL_NOTICE,
            slug: "demo-cafe",
            name: "데모 카페",
            payTo: PAY_TO,
            network: GIWA_SEPOLIA_CAIP2,
            asset: MOCK_USDC.address,
            facilitator: "http://127.0.0.1:8081",
            items: [
                {key: "americano", name: "아메리카노", description: "따뜻한 아메리카노 한 잔", price: "1.00", url: `${BASE_URL}${AMERICANO}`},
                {key: "croissant", name: "크루아상", description: "버터 크루아상 한 개", price: "2.50", url: `${BASE_URL}${CROISSANT}`},
            ],
        });
    });

    test("JSON when the client accepts anything or asks for JSON", async () => {
        const {get} = shop();
        for (const accept of ["*/*", "application/json", "application/json, text/html;q=0.5"]) {
            const response = await get("/s/demo-studio", {Accept: accept});
            expect(response.headers.get("content-type"), accept).toContain("application/json");
        }
    });

    test("HTML when the client prefers it, opening with the fixed sentence", async () => {
        const {get} = shop();
        const response = await get("/s/demo-cafe", {Accept: BROWSER});
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        const page = await response.text();
        const lines = bodyLines(page);
        expect(lines[0]).toBe(TRIAL_NOTICE);
        expect(lines).toContain("데모 카페");
        expect(lines).toContain("아메리카노 — 1.00 tUSDC");
        expect(lines).toContain("크루아상 — 2.50 tUSDC");
        expect(lines.at(-1)).toBe(PICKUP_LINE);
        expect(page).not.toContain("mUSDC");
    });

    test("seller and item names are text on the page, never markup", async () => {
        const {store, get} = shop();
        store.sellers.upsert({slug: "evil", kind: "hosted", name: "<b>가게</b>", payTo: PAY_TO, internal: true, createdAt: NOW});
        store.items.upsert({sellerSlug: "evil", key: "x", name: "<script>alert(1)</script>", description: "-", priceBase: ONE, createdAt: NOW});
        const page = await (await get("/s/evil", {Accept: BROWSER})).text();
        expect(page).toContain("&lt;b&gt;가게&lt;/b&gt;");
        expect(page).toContain("&lt;script&gt;");
        expect(page).not.toContain("<b>가게");
        expect(page).not.toContain("<script>");
    });

    test("displayAmount keeps two digits, or every digit a price needs", () => {
        expect(displayAmount(ONE)).toBe("1.00");
        expect(displayAmount(2_500_000n)).toBe("2.50");
        expect(displayAmount(1n)).toBe("0.000001");
        expect(displayAmount(0n)).toBe("0.00");
    });
});

describe("metrics", () => {
    test("disabled without a token", async () => {
        const {get} = shop();
        const response = await get("/metrics");
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({error: "metrics_disabled"});
    });

    test("guarded by the bearer, reporting the orders summary", async () => {
        const {get, pay} = shop({metricsToken: METRICS_TOKEN});
        const missing = await get("/metrics");
        expect(missing.status).toBe(401);
        expect(missing.headers.get("WWW-Authenticate")).toBe('Bearer realm="metrics"');
        expect((await get("/metrics", {Authorization: `Bearer ${METRICS_TOKEN}x`})).status).toBe(401);
        expect((await get("/metrics", {Authorization: `Basic ${METRICS_TOKEN}`})).status).toBe(401);

        await ticketOf(await pay(AMERICANO, paymentHeader(ONE, LEAF_A)));
        const ok = await get("/metrics", {Authorization: `Bearer ${METRICS_TOKEN}`});
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({
            orders: {
                allTime: {total: 1, bySeller: {"demo-cafe": 1}},
                last24h: {total: 1, bySeller: {"demo-cafe": 1}},
            },
        });
    });
});

describe("health and seed", () => {
    test("/health names the facilitator and the network", async () => {
        const {get} = shop();
        expect(await (await get("/health")).json()).toEqual({
            ok: true,
            name: "테스트 상점",
            network: GIWA_SEPOLIA_CAIP2,
            paymentMethod: "erc7710",
            facilitator: "http://127.0.0.1:8081",
        });
    });

    test("seeding twice changes no row", () => {
        const store = openStore(IN_MEMORY);
        seedShops(store, PAY_TO, NOW);
        const snapshot = () => ({
            sellers: store.sellers.list(),
            items: DEMO_SHOPS.map((demo) => store.items.listBySeller(demo.slug)),
        });
        const first = snapshot();
        seedShops(store, PAY_TO, NOW + 60_000);
        expect(snapshot()).toEqual(first);
        expect(first.sellers.map((seller) => [seller.slug, seller.internal, seller.kind])).toEqual([
            ["demo-cafe", true, "hosted"],
            ["demo-studio", true, "hosted"],
        ]);
        expect(first.items.flat().map((item) => [item.sellerSlug, item.key, item.priceBase])).toEqual([
            ["demo-cafe", "americano", ONE],
            ["demo-cafe", "croissant", 2_500_000n],
            ["demo-studio", "logo", ONE],
        ]);
    });
});
