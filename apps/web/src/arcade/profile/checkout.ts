import type {D1Database} from "@cloudflare/workers-types";
import {getAddress, isAddress, isHex, type Address} from "viem";
import {decodePaymentHeader, GIWA_SEPOLIA_CAIP2, MOCK_USDC} from "@mapae/shared";
import {derivePaymentIntentId} from "@mapae/delegation/facilitator-contract";
import {ARCADE_PAY_TO, ARCADE_TICKET_AMOUNT, ARCADE_SELLER} from "@mapae/arcade/tickets";
import type {GameId} from "@mapae/arcade";
import type {GiwaReceipt} from "../giwa-store";
import type {ProfileRepository} from "./repository";
import {PROFILE_GENERATION} from "./model";

type Checkout = {requestId: string; owner: Address; characterId: string; game: GameId; payer: Address; intent: string; receipt: GiwaReceipt | null; admitted: boolean};
type Row = Omit<Checkout, "receipt" | "admitted"> & {receipt: string | null; admitted: number};
const select = "SELECT request_id AS requestId, owner, character_id AS characterId, game, payer, intent, receipt, admitted FROM arcade_checkouts";
const convert = (v: Row | null): Checkout | null => v ? {...v, receipt: v.receipt ? JSON.parse(v.receipt) : null, admitted: v.admitted === 1} : null;
export function checkoutRepository(db: Pick<D1Database, "prepare">) {
    return {
        async active(owner: string) {return convert(await db.prepare(`${select} WHERE owner=? AND admitted=0`).bind(owner).first<Row>());},
        async register(v: Checkout) {
            await db.prepare("INSERT INTO arcade_checkouts (request_id, owner, character_id, game, payer, intent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(v.requestId, v.owner, v.characterId, v.game, v.payer, v.intent, Date.now()).run();
            return convert(await db.prepare(`${select} WHERE request_id=? AND owner=?`).bind(v.requestId, v.owner).first<Row>());
        },
        async paid(owner: string, id: string, receipt: GiwaReceipt) {await db.prepare("UPDATE arcade_checkouts SET receipt=?, updated_at=? WHERE request_id=? AND owner=? AND admitted=0").bind(JSON.stringify(receipt), Date.now(), id, owner).run();},
        async admit(owner: string, id: string) {return !!await db.prepare("UPDATE arcade_checkouts SET admitted=1, updated_at=? WHERE owner=? AND request_id=? AND admitted=0 AND receipt IS NOT NULL RETURNING request_id").bind(Date.now(), owner, id).first();},

    };
}
export type CheckoutRepository = ReturnType<typeof checkoutRepository>;
const json = (v: unknown, status = 200) => Response.json(v, {status, headers: {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}});
const error = (code: string, status: number) => json({error: {code}}, status);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function checkoutIntent(header: string, payer: Address, manager: Address) {
    const value: unknown = decodePaymentHeader(header);
    if (!object(value) || !object(value.payload)) throw new Error("invalid_payment");
    const p = value.payload;
    if (typeof p.delegator !== "string" || !isAddress(p.delegator) || getAddress(p.delegator) !== getAddress(payer) ||
        typeof p.delegationManager !== "string" || !isAddress(p.delegationManager) || getAddress(p.delegationManager) !== getAddress(manager) ||
        typeof p.permissionContext !== "string" || !isHex(p.permissionContext) || p.permissionContext.length <= 2) throw new Error("invalid_payment");
    return derivePaymentIntentId({network: GIWA_SEPOLIA_CAIP2, asset: MOCK_USDC.address, amount: ARCADE_TICKET_AMOUNT, payTo: ARCADE_PAY_TO, delegationManager: manager, permissionContext: p.permissionContext});
}
export type CheckoutDependencies = {repo: CheckoutRepository; profiles: ProfileRepository; payer: (owner: Address) => Promise<Address>; manager: Address; receiptToken?: string; fetcher?: typeof fetch};
/** Called only after the profile API has authenticated the wallet and enforced its rate limit. */
export async function checkoutApi(request: Request, owner: Address, input: unknown, deps: CheckoutDependencies) {
    const {repo, profiles} = deps, upstream = deps.fetcher ?? fetch;
    const path = new URL(request.url).pathname;
    if (!deps.receiptToken || deps.receiptToken.length < 32) return error("checkout_unavailable", 503);
    async function recover(v: Checkout) {
        if (v.receipt) return v;
        const response = await upstream(`${ARCADE_SELLER}/settlements/${v.intent}`, {headers: {Authorization: `Bearer ${deps.receiptToken}`}, redirect: "manual", signal: AbortSignal.timeout(15_000)});
        if (response.status === 404) return v; // Unknown is not evidence that no funds moved.
        if (!response.ok) throw new Error("seller_unavailable");
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65_536) {await reader.cancel(); throw new Error("receipt_too_large");} chunks.push(next.value);}
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!object(value) || value.game !== v.game || value.payer !== v.payer.toLowerCase() || value.intent !== v.intent ||
            value.network !== GIWA_SEPOLIA_CAIP2 || value.asset !== MOCK_USDC.address.toLowerCase() || value.payTo !== ARCADE_PAY_TO.toLowerCase() ||
            value.amount !== ARCADE_TICKET_AMOUNT.toString() || typeof value.transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.transaction)) throw new Error("receipt_mismatch");
        const receipt: GiwaReceipt = {code: v.intent, payer: v.payer, transaction: value.transaction as `0x${string}`};
        await repo.paid(owner, v.requestId, receipt);
        return {...v, receipt};
    }
    if (request.method === "GET" && !path.endsWith("/ack")) {
        const active = await repo.active(owner);
        return json({pending: active ? await recover(active) : null});
    }
    if (request.method !== "POST" || !object(input)) return error("invalid_request", 400);
    if (input.generation !== PROFILE_GENERATION) return error("server_restored", 409);
    if (path.endsWith("/ack")) {
        const active = await repo.active(owner);
        if (!active || active.requestId !== input.requestId) return json({admitted: false});
        const snapshot = await profiles.read(owner);
        const recorded = snapshot.profile.activities.some(a => a.id === active.requestId && a.characterId === active.characterId && a.game === active.game && a.ticketId === active.receipt?.transaction);
        if (!recorded) return error("admission_not_saved", 409);
        return json({admitted: await repo.admit(owner, active.requestId)});
    }
    const {requestId, characterId, game, header} = input;
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId) || typeof characterId !== "string" || characterId.length > 64 ||
        (game !== "race" && game !== "shop" && game !== "stamp") || typeof header !== "string" || header.length > 24_000 || !/^[A-Za-z0-9+/=]+$/.test(header)) return error("invalid_request", 400);
    const profile = await profiles.read(owner);
    if (!profile.profile.characters.some(c => c.id === characterId)) return error("character_missing", 409);
    const payer = await deps.payer(owner);
    let intent: string;
    try {intent = checkoutIntent(header, payer, deps.manager);} catch {return error("invalid_payment", 400);}
    // Refuse an old/offline mini BEFORE recording or submitting a fresh purchase.
    // Recovery of an existing receipt remains available while readiness is red.
    const existing = await repo.active(owner);
    if (!existing) {
        const health = await upstream(new URL("/health", ARCADE_SELLER), {redirect: "manual", signal: AbortSignal.timeout(15_000)});
        const value: unknown = health.ok ? await health.json() : null;
        if (!object(value) || value.ok !== true || value.arcadeRecovery !== true) return error("seller_unavailable", 503);
    }
    const active = await repo.register({requestId, owner, characterId, game, payer, intent, receipt: null, admitted: false});
    if (!active || active.intent !== intent || active.game !== game || active.characterId !== characterId || active.admitted) return error("checkout_conflict", 409);
    const recovered = await recover(active);
    if (recovered.receipt) return json({pending: recovered});
    // Only identifiers reach D1. Signed headers and session keys never do.
    const response = await upstream(`${ARCADE_SELLER}/${game}`, {headers: {"Payment-Signature": header, Accept: "application/json"}, redirect: "manual", signal: AbortSignal.timeout(50_000)});
    if (!response.ok) {
        // Retain ambiguity, including 402: exact intent retries and operator reconciliation are safe.
        await response.body?.cancel();
        return error("settlement_unknown", 409);
    }
    await response.body?.cancel();
    return json({pending: await recover(active)});
}
