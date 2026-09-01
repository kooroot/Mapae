import {createHash, timingSafeEqual} from "node:crypto";
import {Hono, type MiddlewareHandler} from "hono";
import {accepts} from "hono/accepts";
import {html} from "hono/html";
import type {MapaeEnv, MapaeSeller, SettlementReceipt} from "@mapae/seller";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, fromTokenAmount, toTokenAmount} from "@mapae/shared";
import type {Item, MapaeStore, Order, Seller} from "@mapae/store";

/**
 * The hosted shop: one server, many sellers, every seller read from the store.
 *
 * A seller is a row, not a deployment. `/s/:slug` is its manifest (JSON for an agent,
 * a page for a person) and `/s/:slug/:key` is one item behind `@mapae/seller`'s paywall.
 * The paywall is built per request from the item's price and the seller's `payTo`, so a
 * re-seed changes what is sold without a restart; the facilitator client behind every
 * paywall is the one `createMapae` instance, so `/supported` is still cached once for
 * the whole server.
 *
 * The orders table is the double-delivery guard. A payment intent binds payTo, amount
 * and the signed permission context — not the item — so two items at one price share
 * intents for one header, and a header bought for the americano satisfies the offer for
 * the logo. `orders.createOnce` keys on the intent: the row that comes back names the
 * item the payment first bought, and the ticket is that row's ticket. One payment, one
 * ticket, never two deliveries.
 */

/** What every page and manifest of the trial says first, verbatim. */
export const TRIAL_NOTICE =
    "지금은 시험 운영입니다. 들어오는 잔액은 실제 돈이 아니고, 바꿀 수 없습니다. 실제 결제가 열리면 다시 안내드립니다.";
export const PICKUP_LINE = "자리에서 시켜 두고 가게에서 찾으세요";
export const TICKET_LINE = "픽업 시 이 번호를 보여 주세요";

export interface ShopAppOptions {
    store: MapaeStore;
    mapae: MapaeSeller;
    /** The origin buyers reach this server at — item URLs in a manifest are built on it. */
    baseUrl: string;
    /** The operator's name, reported by `/health`. */
    name: string;
    /** Bearer for `/metrics`; absent, the route answers 503 rather than opening up. */
    metricsToken?: string;
}

export interface ShopManifestItem {
    key: string;
    name: string;
    description: string;
    /** Decimal tUSDC, two fractional digits unless the price needs more. */
    price: string;
    url: string;
}

export interface ShopManifest {
    version: 1;
    notice: typeof TRIAL_NOTICE;
    slug: string;
    name: string;
    payTo: string;
    network: typeof GIWA_SEPOLIA_CAIP2;
    asset: string;
    facilitator: string;
    items: ShopManifestItem[];
}

export interface Ticket {
    /** 주문 번호 — the store's order id, what the buyer shows at pickup. */
    order: number;
    shop: {slug: string; name: string};
    item: {key: string; name: string};
    /** `"1.00 tUSDC"` */
    amount: string;
    transaction: string | null;
    issuedAt: string;
    message: typeof TICKET_LINE;
}

export interface TicketResponse {
    ticket: Ticket;
    receipt: SettlementReceipt & {method: "erc7710"};
}

type ShopEnv = {
    Variables: MapaeEnv["Variables"] & {seller: Seller; item: Item; order?: Order};
};

/**
 * The store's own route-segment rule. Its `get` throws on anything else, and a URL a
 * buyer can type is not a reason to answer 500 — it is a shop that does not exist.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `1000000n` → `"1.00"`; a price with more fractional digits keeps them all. */
export function displayAmount(amountBase: bigint): string {
    const [whole, fraction = "0"] = fromTokenAmount(amountBase).split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
}

function sha256(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

/** Constant-time bearer check; both sides hashed so length never leaks through timing. */
function bearerTokenMatches(header: string | undefined, token: string): boolean {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
    if (presented === undefined) return false;
    return timingSafeEqual(sha256(presented), sha256(token));
}

function itemUrl(baseUrl: string, seller: Seller, item: Item): string {
    return `${baseUrl}/s/${seller.slug}/${item.key}`;
}

function shopManifest(
    baseUrl: string,
    facilitator: string,
    seller: Seller,
    items: Item[],
): ShopManifest {
    return {
        version: 1,
        notice: TRIAL_NOTICE,
        slug: seller.slug,
        name: seller.name,
        payTo: seller.payTo,
        network: GIWA_SEPOLIA_CAIP2,
        asset: MOCK_USDC.address,
        facilitator,
        items: items.map((item) => ({
            key: item.key,
            name: item.name,
            description: item.description,
            price: displayAmount(item.priceBase),
            url: itemUrl(baseUrl, seller, item),
        })),
    };
}

/**
 * The page a person sees. `html` escapes every interpolation, so a seller or item name
 * is text on the page and never markup. The notice is the first text of the body.
 */
function shopPage(seller: Seller, items: Item[]) {
    return html`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${seller.name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.6}.notice{color:#7a4b00;background:#fff4dc;padding:.75rem 1rem;border-radius:.5rem}ul{padding-left:1.25rem}</style>
</head>
<body>
<p class="notice">${TRIAL_NOTICE}</p>
<h1>${seller.name}</h1>
<ul>
${items.map((item) => html`<li>${item.name} — ${displayAmount(item.priceBase)} tUSDC</li>\n`)}
</ul>
<p>${PICKUP_LINE}</p>
</body>
</html>
`;
}

function ticketResponse(order: Order, seller: Seller, item: Item, receipt: SettlementReceipt): TicketResponse {
    return {
        ticket: {
            order: order.id,
            shop: {slug: seller.slug, name: seller.name},
            item: {key: item.key, name: item.name},
            amount: `${displayAmount(order.amountBase)} tUSDC`,
            transaction: order.txHash,
            issuedAt: new Date(order.createdAt).toISOString(),
            message: TICKET_LINE,
        },
        receipt: {method: "erc7710", ...receipt},
    };
}

export function createShopApp({store, mapae, baseUrl, name, metricsToken}: ShopAppOptions) {
    const app = new Hono<ShopEnv>();
    app.use("*", async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
    });
    app.notFound((c) => c.json({error: "not_found"}, 404));

    /** Only hosted sellers are served here; an external one serves itself from its `baseUrl`. */
    const findShop = (slug: string): Seller | null => {
        if (!SLUG.test(slug)) return null;
        const seller = store.sellers.get(slug);
        return seller?.kind === "hosted" ? seller : null;
    };

    app.get("/health", (c) =>
        c.json({
            ok: true,
            name,
            network: GIWA_SEPOLIA_CAIP2,
            paymentMethod: "erc7710",
            facilitator: mapae.facilitator,
        }),
    );

    app.get("/s/:slug", (c) => {
        const seller = findShop(c.req.param("slug"));
        if (!seller) return c.json({error: "unknown_shop"}, 404);
        const items = store.items.listBySeller(seller.slug);
        const wants = accepts(c, {
            header: "Accept",
            supports: ["application/json", "text/html"],
            default: "application/json",
        });
        if (wants === "text/html") return c.html(shopPage(seller, items));
        return c.json(shopManifest(baseUrl, mapae.facilitator, seller, items));
    });

    // 404 before any price is quoted: the paywall must never offer what nothing serves.
    const lookup: MiddlewareHandler<ShopEnv, "/s/:slug/:key"> = async (c, next) => {
        const seller = findShop(c.req.param("slug"));
        if (!seller) return c.json({error: "unknown_shop"}, 404);
        const key = c.req.param("key");
        const item = SLUG.test(key) ? store.items.get(seller.slug, key) : null;
        if (!item) return c.json({error: "unknown_item"}, 404);
        c.set("seller", seller);
        c.set("item", item);
        await next();
    };

    // The paywall is invoked as a middleware with the ticket handler still ahead of it:
    // when it is the last matched route it answers 404 instead of pricing anything.
    const paywall: MiddlewareHandler<ShopEnv> = (c, next) => {
        const seller = c.get("seller");
        const item = c.get("item");
        const guard = mapae.paywall({
            payTo: seller.payTo,
            price: fromTokenAmount(item.priceBase),
            description: `${seller.name} — ${item.name}`,
            extensions: {
                mapae: {
                    seller: {slug: seller.slug, name: seller.name},
                    manifest: `${baseUrl}/s/${seller.slug}`,
                },
            },
            // The one place an order is written. Money has moved when this runs; the
            // row keyed on the intent is what makes the second delivery the same ticket.
            onSettled: (receipt) => {
                c.set(
                    "order",
                    store.orders.createOnce({
                        sellerSlug: seller.slug,
                        itemKey: item.key,
                        paymentIntentId: receipt.intent,
                        payer: receipt.payer,
                        amountBase: toTokenAmount(receipt.amount),
                        txHash: receipt.transaction ?? null,
                        status: "paid",
                        createdAt: Date.now(),
                    }),
                );
            },
        });
        // `MiddlewareHandler<MapaeEnv>` is invariant in its env: this context carries
        // every variable the paywall reads and writes plus the shop's own, which is
        // exactly what it needs and what the declared type refuses.
        return (guard as unknown as MiddlewareHandler<ShopEnv>)(c, next);
    };

    app.get("/s/:slug/:key", lookup, paywall, (c) => {
        const order = c.get("order");
        if (!order) {
            // `onSettled` threw — the paywall logged it — so the payment settled and
            // nothing recorded it. The same header replays to the same intent, so a
            // retry can still get its ticket; a made-up one here could not be shown.
            return c.json({error: "order_not_recorded"}, 500);
        }
        // A same-price replay comes back as the row of the item the payment first
        // bought — possibly another shop's, since seeded shops share one payTo. The
        // ticket is that row's: deliver what was bought, and only that.
        const seller = c.get("seller");
        const item = c.get("item");
        const sameItem = order.sellerSlug === seller.slug && order.itemKey === item.key;
        const shop = sameItem ? seller : store.sellers.get(order.sellerSlug);
        const bought = sameItem ? item : store.items.get(order.sellerSlug, order.itemKey);
        if (!shop || !bought) {
            // Unreachable under `PRAGMA foreign_keys` (orders reference items), and
            // answered honestly rather than with a ticket for nothing if it ever is.
            return c.json({error: "order_item_missing"}, 500);
        }
        return c.json(ticketResponse(order, shop, bought, c.get("mapaeReceipt")));
    });

    app.get("/metrics", (c) => {
        if (metricsToken === undefined) return c.json({error: "metrics_disabled"}, 503);
        if (!bearerTokenMatches(c.req.header("authorization"), metricsToken)) {
            c.header("WWW-Authenticate", 'Bearer realm="metrics"');
            return c.json({error: "unauthorized"}, 401);
        }
        const now = Date.now();
        return c.json({
            orders: {
                allTime: store.orders.summary({sinceMs: 0}),
                last24h: store.orders.summary({sinceMs: now - 24 * 60 * 60_000}),
            },
        });
    });

    return app;
}
