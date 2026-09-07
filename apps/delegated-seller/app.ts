import {createHash, timingSafeEqual} from "node:crypto";
import {Hono, type Context, type MiddlewareHandler} from "hono";
import {accepts} from "hono/accepts";
import {html, raw} from "hono/html";
import type {HtmlEscapedString} from "hono/utils/html";
import {getAddress, isAddress, isHex, type Address} from "viem";
import {derivePaymentIntentId, type PaymentIntent} from "@mapae/delegation/facilitator-contract";
import type {MapaeEnv, MapaeSeller, SettlementReceipt} from "@mapae/seller";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    decodeAnyPaymentHeader,
    fromTokenAmount,
    readInboundPaymentHeader,
    toTokenAmount,
} from "@mapae/shared";
import type {Item, MapaeStore, Order, Seller} from "@mapae/store";

/**
 * The hosted shop: one server, many sellers, every seller read from the store.
 *
 * A seller is a row, not a deployment. `/s/:slug` is its manifest (JSON for an agent,
 * a page for a person), `/s/:slug/:key` is one item behind `@mapae/seller`'s paywall,
 * and `/s/:slug/tickets/:code` is what the counter checks at pickup. The paywall is
 * built per request from the item's price and the seller's `payTo`, so a re-seed
 * changes what is sold without a restart; the facilitator client behind every paywall
 * is the one `createMapae` instance, so `/supported` is still cached once for the
 * whole server.
 *
 * The orders table is the double-delivery guard, and it is consulted before the
 * facilitator is. A payment intent binds payTo, amount and the signed permission
 * context — not the item — so two items at one price share intents for one header,
 * and a header bought for the americano satisfies the offer for the logo. A header
 * that arrives is first keyed the way the paywall keys a settlement and looked up; an
 * order found is answered from the row. That order of operations is not an
 * optimisation: on chain the leaf's one-shot allowance is spent by the first
 * settlement, so `/verify` refuses the same header ever after, and a buyer whose first
 * answer was lost in transit could otherwise never see the ticket the payment bought.
 * Only a header nothing bought goes on to the paywall, where `orders.createOnce` keys
 * on the intent again: the row that comes back names the item the payment first
 * bought, and the ticket is that row's. One payment, one ticket, never two deliveries.
 */

/** What every page and manifest of the trial says first, verbatim. */
export const TRIAL_NOTICE =
    "지금은 시험 운영입니다. 들어오는 잔액은 실제 돈이 아니고, 바꿀 수 없습니다. 실제 결제가 열리면 다시 안내드립니다.";
export const PICKUP_LINE = "자리에서 시켜 두고 가게에서 찾으세요";
export const TICKET_LINE = "픽업 시 이 코드를 보여 주세요";

/**
 * The one stylesheet every page carries. Its hash is the only style the policy below
 * admits, and both are computed from this string, so the header and the markup cannot
 * drift apart: a stylesheet edited here is re-hashed on the next module load.
 */
const PAGE_STYLE =
    "body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.6}.notice{color:#7a4b00;background:#fff4dc;padding:.75rem 1rem;border-radius:.5rem}ul{padding-left:1.25rem}code{font-size:1.5rem;letter-spacing:.1em}";

/**
 * Sent with every response, JSON included. Escaping is what keeps a seller's name text
 * on the page rather than markup; this is what keeps markup, should it ever land, from
 * running or fetching anything — nothing may load but the stylesheet above — and
 * `frame-ancestors 'none'` keeps a ticket page out of another site's frame.
 */
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    `style-src 'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join("; ");

export interface ShopAppOptions {
    store: MapaeStore;
    mapae: MapaeSeller;
    /** The origin buyers reach this server at — item URLs in a manifest are built on it. */
    baseUrl: string;
    /**
     * The facilitator named in every manifest and by `/health`: the public one, not the
     * hop this server settles through, which in the hosted topology is loopback.
     */
    facilitatorUrl: string;
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

interface TicketFields {
    /**
     * 픽업 코드 — the store's ticket, the one thing a buyer shows at the counter. The
     * row id is not here: it counts the shop's orders, and anyone could name the next.
     */
    code: string;
    shop: {slug: string; name: string};
    item: {key: string; name: string};
    /** `"1.00 tUSDC"` */
    amount: string;
    transaction: string | null;
    issuedAt: string;
}

/** What a settled payment is answered with. */
export interface Ticket extends TicketFields {
    message: typeof TICKET_LINE;
}

/** What `/s/:slug/tickets/:code` shows whoever holds the code. */
export interface VerifiedTicket extends TicketFields {
    status: string;
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

/** Agents get JSON unless they say otherwise; a browser's Accept says otherwise. */
function wantsHtml(c: Context<ShopEnv>): boolean {
    const wants = accepts(c, {
        header: "Accept",
        supports: ["application/json", "text/html"],
        default: "application/json",
    });
    return wants === "text/html";
}

/**
 * The page a person sees. `html` escapes every interpolation, so a seller or item name
 * is text on the page and never markup. The stylesheet is inserted raw: the bytes
 * served must be the bytes the policy hashed, and escaping could alter them. The
 * notice is the first text of the body.
 */
function page(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
    return html`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${raw(PAGE_STYLE)}</style>
</head>
<body>
<p class="notice">${TRIAL_NOTICE}</p>
${body}
</body>
</html>
`;
}

function shopPage(seller: Seller, items: Item[]) {
    return page(
        seller.name,
        html`<h1>${seller.name}</h1>
<ul>
${items.map((item) => html`<li>${item.name} — ${displayAmount(item.priceBase)} tUSDC</li>\n`)}
</ul>
<p>${PICKUP_LINE}</p>`,
    );
}

function ticketPage(seller: Seller, ticket: VerifiedTicket) {
    return page(
        `${seller.name} — 픽업 코드`,
        html`<h1>${seller.name}</h1>
<p><code>${ticket.code}</code></p>
<ul>
<li>${ticket.item.name} — ${ticket.amount}</li>
<li>상태 — ${ticket.status}</li>
<li>결제 — ${ticket.issuedAt}</li>
<li>트랜잭션 — ${ticket.transaction ?? "없음"}</li>
</ul>`,
    );
}

function ticketFields(order: Order, seller: Seller, item: Item): TicketFields {
    return {
        code: order.ticket,
        shop: {slug: seller.slug, name: seller.name},
        item: {key: item.key, name: item.name},
        amount: `${displayAmount(order.amountBase)} tUSDC`,
        transaction: order.txHash,
        issuedAt: new Date(order.createdAt).toISOString(),
    };
}

function ticketResponse(order: Order, seller: Seller, item: Item, receipt: SettlementReceipt): TicketResponse {
    return {
        ticket: {...ticketFields(order, seller, item), message: TICKET_LINE},
        receipt: {method: "erc7710", ...receipt},
    };
}

/**
 * The receipt of the payment a row records, for a header presented again after the
 * first answer was lost. Every field is the row's or the offer's, and the offer's are
 * honest because the intent that found the row was derived from them: what the lookup
 * matched on is what was paid.
 */
function recordedReceipt(order: Order, payTo: Address): SettlementReceipt {
    return {
        intent: order.paymentIntentId,
        payer: order.payer,
        amount: fromTokenAmount(order.amountBase),
        asset: MOCK_USDC.address,
        payTo,
        network: GIWA_SEPOLIA_CAIP2,
        ...(order.txHash === null ? {} : {transaction: order.txHash}),
    };
}

type Delegation = Pick<PaymentIntent, "delegationManager" | "permissionContext">;

/**
 * The two header fields an intent is keyed on, or nothing. The shape admitted is the
 * paywall's exactly — an ERC-7710 `accepted` block and a delegator beside the
 * delegation — so a header the paywall would answer 400 is never answered a ticket
 * here instead; two gates that disagree on what a payment looks like are a hole. What
 * `accepted` says past its method is not read: the paywall keys a settlement on its
 * own offer plus the delegation and nothing else, so the same signed context is the
 * same intent wherever it is presented. A header this cannot read is left for the
 * paywall to refuse.
 */
function readDelegation(header: string): Delegation | undefined {
    let decoded: unknown;
    try {
        decoded = decodeAnyPaymentHeader(header);
    } catch {
        return undefined;
    }
    const candidate = decoded as {accepted?: {extra?: unknown}; payload?: unknown} | null;
    const extra = candidate?.accepted?.extra;
    if (!extra || typeof extra !== "object" || (extra as {assetTransferMethod?: unknown}).assetTransferMethod !== "erc7710") {
        return undefined;
    }
    const payload = candidate?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const {delegationManager, delegator, permissionContext} = payload as Record<string, unknown>;
    if (typeof delegationManager !== "string" || !isAddress(delegationManager)) return undefined;
    if (typeof delegator !== "string" || !isAddress(delegator)) return undefined;
    if (typeof permissionContext !== "string" || !isHex(permissionContext) || permissionContext.length <= 2) {
        return undefined;
    }
    return {delegationManager: getAddress(delegationManager), permissionContext};
}

export function createShopApp({store, mapae, baseUrl, facilitatorUrl, name, metricsToken}: ShopAppOptions) {
    const app = new Hono<ShopEnv>();
    app.use("*", async (c, next) => {
        await next();
        c.header("Cache-Control", "no-store");
        c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
        c.header("Referrer-Policy", "no-referrer");
        c.header("X-Content-Type-Options", "nosniff");
    });
    app.notFound((c) => c.json({error: "not_found"}, 404));

    /** Only hosted sellers are served here; an external one serves itself from its `baseUrl`. */
    const findShop = (slug: string): Seller | null => {
        if (!SLUG.test(slug)) return null;
        const seller = store.sellers.get(slug);
        return seller?.kind === "hosted" ? seller : null;
    };

    /**
     * The order a presented header already bought, keyed exactly as the paywall keys a
     * settlement: this shop's payTo, this item's price, the network and the asset, plus
     * the header's delegation. A header for another price derives another intent and
     * finds nothing; one nothing bought finds nothing and goes on to pay.
     */
    const paidOrder = (c: Context<ShopEnv>, seller: Seller, item: Item): Order | null => {
        const header = readInboundPaymentHeader((header) => c.req.header(header));
        const delegation = header && readDelegation(header.value);
        if (!delegation) return null;
        return store.orders.getByIntent(
            derivePaymentIntentId({
                network: GIWA_SEPOLIA_CAIP2,
                asset: MOCK_USDC.address,
                amount: item.priceBase,
                payTo: seller.payTo,
                ...delegation,
            }),
        );
    };

    /**
     * The store refuses a code of the wrong shape with a TypeError. A code someone
     * mistyped at the counter is a ticket that does not exist, not a 500.
     */
    const ticketOrder = (seller: Seller, code: string): Order | null => {
        try {
            return store.orders.getByTicket(seller.slug, code);
        } catch (error) {
            if (error instanceof TypeError) return null;
            throw error;
        }
    };

    app.get("/health", (c) =>
        c.json({
            ok: true,
            name,
            network: GIWA_SEPOLIA_CAIP2,
            paymentMethod: "erc7710",
            facilitator: facilitatorUrl,
        }),
    );

    app.get("/s/:slug", (c) => {
        const seller = findShop(c.req.param("slug"));
        if (!seller) return c.json({error: "unknown_shop"}, 404);
        const items = store.items.listBySeller(seller.slug);
        if (wantsHtml(c)) return c.html(shopPage(seller, items));
        return c.json(shopManifest(baseUrl, facilitatorUrl, seller, items));
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
        // Before the facilitator, not after: `/verify` simulates against live chain
        // state, where the first settlement already spent the leaf's one-shot allowance,
        // so a replayed header is refused there and never reaches the orders table.
        const paid = paidOrder(c, seller, item);
        if (paid) {
            c.set("order", paid);
            c.set("mapaeReceipt", recordedReceipt(paid, getAddress(seller.payTo)));
            return next();
        }
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
            // `onSettled` threw — the paywall logged the intent — so the payment settled
            // and nothing recorded it. A retry cannot recover it: no row answers the
            // header here, and `/verify` refuses it on the allowance the settlement
            // spent. The logged intent is what the operator reconciles from; a made-up
            // ticket could not be shown at any counter.
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

    // The code is the capability: 80 random bits, minted by the store, good only at the
    // shop that issued it. Whoever can show it is shown what it bought.
    app.get("/s/:slug/tickets/:code", (c) => {
        const seller = findShop(c.req.param("slug"));
        if (!seller) return c.json({error: "unknown_shop"}, 404);
        const order = ticketOrder(seller, c.req.param("code"));
        if (!order) return c.json({error: "unknown_ticket"}, 404);
        const item = store.items.get(order.sellerSlug, order.itemKey);
        if (!item) return c.json({error: "order_item_missing"}, 500);
        const ticket: VerifiedTicket = {...ticketFields(order, seller, item), status: order.status};
        if (wantsHtml(c)) return c.html(ticketPage(seller, ticket));
        return c.json(ticket);
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
