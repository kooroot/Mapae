import {Database} from "bun:sqlite";
import {isHash, createPublicClient, http} from "viem";
import {giwaSepolia} from "../../packages/shared/src/chain";

type Intent = {payment_intent_id: string; tx_hash: string; payer: string; amount_base: string; created_at: number; terminal_event_id: number | null; outcome: string | null};
type Order = {payment_intent_id: string; tx_hash: string; payer: string; amount_base: string};
/** Read-only: no settle/rebroadcast/refund, no budget edits and no ticket fabrication. */
export async function reconcile(sellerFile: string, facilitatorFile: string, now = Date.now(), receipt?: (hash: string) => Promise<string>, profileFile?: string) {
    const seller = new Database(sellerFile, {readonly: true}), facilitator = new Database(facilitatorFile, {readonly: true});
    try {
        const orders = seller.query<Order, []>("SELECT payment_intent_id, tx_hash, payer, amount_base FROM orders").all();
        const intents = facilitator.query<Intent, []>("SELECT i.payment_intent_id, i.tx_hash, i.payer, i.amount_base, i.created_at, i.terminal_event_id, e.outcome FROM settlement_intents i LEFT JOIN settlement_events e ON e.id=i.terminal_event_id").all();
        const byIntent = new Map(intents.map(v => [v.payment_intent_id, v]));
        const byOrder = new Map(orders.map(v => [v.payment_intent_id, v]));
        const issues: {code: string; intent: string; transaction: string; chain?: string}[] = [];
        for (const order of orders) {
            const intent = byIntent.get(order.payment_intent_id);
            if (!intent || intent.tx_hash !== order.tx_hash || intent.payer.toLowerCase() !== order.payer.toLowerCase() || intent.amount_base !== order.amount_base || intent.outcome !== "settled") issues.push({code: "order_settlement_mismatch", intent: order.payment_intent_id, transaction: order.tx_hash});
        }
        for (const intent of intents) {
            const missing = intent.outcome === "settled" && !byOrder.has(intent.payment_intent_id);
            if (missing || (!intent.terminal_event_id && now - intent.created_at > 300_000)) {
                const issue: typeof issues[number] = {code: missing ? "settled_without_order" : "pending_over_5m", intent: intent.payment_intent_id, transaction: intent.tx_hash};
                if (receipt) {try {issue.chain = await receipt(intent.tx_hash);} catch {issue.chain = "unresolved";}}
                issues.push(issue);
            }
        }
        if (profileFile) {
            const profiles = new Database(profileFile, {readonly: true});
            try {
                const checkouts = profiles.query<{intent: string; admitted: number; updated_at: number}, []>("SELECT intent, admitted, updated_at FROM arcade_checkouts").all();
                for (const checkout of checkouts) {
                    const order = byOrder.get(checkout.intent);
                    if (!checkout.admitted && now - checkout.updated_at > 300_000) issues.push({code: order ? "paid_ticket_waiting_admission" : "checkout_unresolved", intent: checkout.intent, transaction: order?.tx_hash ?? ""});
                    if (checkout.admitted && !order) issues.push({code: "admission_without_seller_order", intent: checkout.intent, transaction: ""});
                }
            } finally {profiles.close();}
        }
        return {ok: issues.length === 0, profilesChecked: !!profileFile, at: new Date(now).toISOString(), orders: orders.length, intents: intents.length, issues};
    } finally {seller.close(); facilitator.close();}
}
if (import.meta.main) {
    const [seller, facilitator, ...flags] = process.argv.slice(2);
    const chain = flags.includes("--chain"), profileAt = flags.indexOf("--profiles"), profileFile = profileAt < 0 ? undefined : flags[profileAt + 1];
    try {
        if (!seller || !facilitator || (profileAt >= 0 && !profileFile) || flags.some((f, i) => f !== "--chain" && f !== "--profiles" && (profileAt < 0 || i !== profileAt + 1))) throw new Error("usage");
        const client = createPublicClient({chain: giwaSepolia, transport: http(giwaSepolia.rpcUrls.default.http[0], {timeout: 10_000, retryCount: 0})});
        const receipt = async (hash: string) => {if (!isHash(hash)) throw new Error("Invalid hash"); return (await client.getTransactionReceipt({hash})).status;};
        const result = await reconcile(seller, facilitator, Date.now(), chain ? receipt : undefined, profileFile);
        console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
    } catch {console.error("Read-only reconciliation failed. Usage: bun scripts/ops/reconcile.ts SELLER_DB FACILITATOR_DB [--chain] [--profiles D1_EXPORT_SQLITE]"); process.exitCode = 1;}
}
