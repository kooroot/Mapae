import {Hono} from "hono";
import {createMapae, type MapaeEnv, type MapaeOptions, type PaymentIdentifierBinding} from "@mapae/seller";
import {payForDelegatedResource, derivePaymentIntentId, type DelegatedPaymentConfig} from "@mapae/delegation";
import {MOCK_USDC, GIWA_SEPOLIA_CAIP2, toTokenAmount} from "@mapae/shared";
import type {MapaeStore, Order} from "@mapae/store";
import {AdmissionError, type Admission, type ArcadeGame, type ArcadeStore} from "@mapae/store/arcade";
import {getAddress, type Address, type Hex} from "viem";
import {ArcadeError} from "./model.js";
import {ARCADE_TICKET_PRICE, ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";

export type PaymentOptions = {
    mode: "simulation" | "fork"; payTo: Address; facilitator: string;
    facilitatorFetch?: MapaeOptions["fetch"]; client: Omit<DelegatedPaymentConfig, "fetchImpl">;
    /** Read the original transaction only; never create or broadcast a replacement payment. */
    reconcile?: (intent: Hex) => Promise<void>;
};
const BASE = "http://127.0.0.1:3004";
const SLUG = "mapae-arcade";
const GAMES: ArcadeGame[] = ["stamp", "race", "shop"];
function ticketBody(ticket: Admission, order: Order, mode: PaymentOptions["mode"]) {
    return {source: `mapae-${mode}` as const, ticket: {
        id: ticket.id, game: ticket.game, status: ticket.status, runId: ticket.runId,
        amount: ARCADE_TICKET_PRICE, unit: MOCK_USDC.symbol, transaction: order.txHash, payer: order.payer,
    }};
}
/** The seller/client/payment journal remain real code in both modes; only the simulation's facilitator is a fixture. */
export function createPayments(store: MapaeStore, admissions: ArcadeStore, options?: PaymentOptions) {
    const status = () => ({mode: options?.mode ?? "disabled", unit: MOCK_USDC.symbol, ticketPrice: ARCADE_TICKET_PRICE,
        broadcastEnabled: false, balanceSource: options?.mode === "fork" ? "payer-smart-account-on-local-fork" : "simulation-only"});
    const seller = new Hono<MapaeEnv>();
    if (options) {
        store.sellers.upsert({slug: SLUG, kind: "hosted", name: "Mapae Arcade", payTo: options.payTo, internal: true, createdAt: Date.now()});
        const mapae = createMapae({facilitator: options.facilitator, baseUrl: BASE, fetch: options.facilitatorFetch});
        const identifiers: PaymentIdentifierBinding = {
            bind(input) {
                const bound = store.paymentIdentifiers.bind({...input, at: Date.now()});
                if (bound.kind === "new") return bound;
                const receipt = (o: {payer: string; txHash: Hex | null}) => ({payer: getAddress(o.payer), ...(o.txHash ? {transaction: o.txHash} : {})});
                if (bound.kind === "settled") return {kind: "settled", settled: receipt(bound.settled)};
                return {kind: "conflict", reason: bound.reason, settled: bound.settled ? receipt(bound.settled) : null};
            },
            record(input) {store.paymentIdentifiers.record({id: input.id, payer: input.payer, txHash: input.transaction, at: Date.now()});},
        };
        for (const game of GAMES) {
            store.items.upsert({sellerSlug: SLUG, key: game, name: `${game} admission`, description: game === "race" ? "Three-race season ticket" : "One game ticket", priceBase: ARCADE_TICKET_AMOUNT, createdAt: Date.now()});
            seller.get(`/tickets/${game}`, mapae.paywall({payTo: options.payTo, price: ARCADE_TICKET_PRICE, description: `Mapae Arcade ${game} ticket`, paymentIdentifiers: identifiers,
                onSettled: (receipt) => {store.orders.createOnce({sellerSlug: SLUG, itemKey: game, paymentIntentId: receipt.intent, payer: receipt.payer,
                    amountBase: toTokenAmount(receipt.amount), txHash: receipt.transaction, status: "paid", createdAt: Date.now()});},
            }), (c) => {
                const receipt = c.get("mapaeReceipt");
                const order = store.orders.getByIntent(receipt.intent);
                if (!order) return c.json({error: "order_not_recorded"}, 500);
                return c.json({order: {intent: order.paymentIntentId, item: order.itemKey}, receipt});
            });
        }
    }
    function recover(ticket: Admission) {
        let order = ticket.intent ? store.orders.getByIntent(ticket.intent as Hex) : null;
        // Crash after the facilitator journal committed, before the seller callback: the same confirmed intent can finish delivery without signing or sending again.
        const journal = ticket.intent ? store.settlements.get(ticket.intent as Hex) : null;
        if (!order && journal?.terminal?.outcome === "settled" && options && journal.payTo.toLowerCase() === options.payTo.toLowerCase() && journal.amountBase === ARCADE_TICKET_AMOUNT) {
            order = store.orders.createOnce({sellerSlug: SLUG, itemKey: ticket.game, paymentIntentId: journal.paymentIntentId,
                payer: journal.payer, amountBase: journal.amountBase, txHash: journal.txHash, status: "paid", createdAt: journal.terminal.at});
        }
        if (order) {
            if (order.sellerSlug !== SLUG || order.itemKey !== ticket.game || order.amountBase !== ARCADE_TICKET_AMOUNT) {
                throw new ArcadeError("payment_conflict", 409, "The recorded payment belongs to a different ticket. No new payment was attempted.");
            }
            return {ticket: admissions.ready(ticket.id, order.paymentIntentId), order};
        }
        return null;
    }
    return {
        status,
        async buy(game: ArcadeGame, requestId: string) {
            if (!options) throw new ArcadeError("payments_disabled", 503, "Mapae payment admission is disabled. Use demo credits or configure a local simulation/fork.");
            const reserved = admissions.reserve(requestId, game);
            if (reserved.admission.intent && ["pending", "unknown"].includes(reserved.admission.status) && options.reconcile) {
                try {await options.reconcile(reserved.admission.intent as Hex);} catch {
                    throw new ArcadeError("payment_unresolved", 409, "The original receipt could not be confirmed. No new charge was attempted.");
                }
            }
            const recovered = recover(reserved.admission);
            if (recovered) return ticketBody(recovered.ticket, recovered.order, options.mode);
            if (reserved.admission.status === "rejected") throw new ArcadeError("payment_rejected", 409, "The recorded payment was refused. No ticket or charge was issued.");
            if (!reserved.created) throw new ArcadeError("payment_unresolved", 409, "This attempt has no confirmed ticket. Do not pay again; reconcile the recorded payment.");
            const ticket = reserved.admission;
            try {
                const result = await payForDelegatedResource(new URL(`/tickets/${game}`, BASE), {
                    ...options.client,
                    provider: async (requirements) => {
                        const leaf = await options.client.provider(requirements);
                        const intent = derivePaymentIntentId({delegationManager: leaf.delegationManager, permissionContext: leaf.permissionContext,
                            network: GIWA_SEPOLIA_CAIP2, asset: MOCK_USDC.address, payTo: options.payTo, amount: ARCADE_TICKET_AMOUNT});
                        // Durable request→intent binding precedes submission. A lost HTTP answer never authorizes a fresh leaf.
                        admissions.bindIntent(ticket.id, intent);
                        return leaf;
                    },
                    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
                        const url = new URL(input instanceof Request ? input.url : String(input));
                        if (url.origin !== BASE || url.pathname !== `/tickets/${game}`) throw new Error("unexpected payment target");
                        return seller.request(url, init);
                    }) as typeof fetch,
                });
                const confirmed = recover(admissions.get(ticket.id)!);
                if (confirmed) return ticketBody(confirmed.ticket, confirmed.order, options.mode);
                if (!result.ok) {
                    const unknown = result.code === "SETTLEMENT_UNKNOWN" || result.code === "MALFORMED_RESOURCE";
                    admissions.fail(ticket.id, unknown ? "unknown" : "rejected", result.code);
                    throw new ArcadeError(unknown ? "payment_unresolved" : "payment_rejected", 409,
                        unknown ? "Settlement is unresolved. No admission or new charge is allowed until reconciliation." : "The delegated payment was refused. No ticket was issued.");
                }
                admissions.fail(ticket.id, "unknown", "ORDER_MISSING");
                throw new ArcadeError("payment_unresolved", 409, "The payment response has no durable order. Reconcile before retrying.");
            } catch (error) {
                if (error instanceof ArcadeError) throw error;
                admissions.fail(ticket.id, "unknown", "PAYMENT_INTERRUPTED");
                throw new ArcadeError("payment_unresolved", 409, "The payment was interrupted. No new charge is allowed until reconciliation.");
            }
        },
        get(id: string) {
            if (!options) throw new ArcadeError("payments_disabled", 503, "Payments are disabled.");
            const ticket = admissions.get(id);
            if (!ticket) throw new AdmissionError("ticket_not_found");
            const recovered = recover(ticket);
            if (!recovered) throw new ArcadeError("payment_unresolved", 409, "This ticket has no confirmed order.");
            return ticketBody(recovered.ticket, recovered.order, options.mode);
        },
        consume(id: string, runId: string) {
            this.get(id);
            admissions.consume(id, runId);
            return this.get(id);
        },
    };
}
