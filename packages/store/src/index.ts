/**
 * `@mapae/store` — the one place a Mapae service keeps state across a restart.
 *
 * bun:sqlite, one file per service, a versioned schema (`schema.ts`). Every method is
 * synchronous and every statement is parameterised; the only SQL assembled at runtime is
 * `PRAGMA user_version = <SCHEMA_VERSION>`, from a module constant.
 *
 * Time is always the caller's: events carry `at`, rows carry `createdAt`, and summaries
 * take a `sinceMs`. The store never reads the clock, which is what makes the summary
 * math and the reopen tests exact.
 */
import {Database} from "bun:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {SCHEMA_SQL, SCHEMA_VERSION} from "./schema.js";

export {SCHEMA_SQL, SCHEMA_VERSION} from "./schema.js";

/** Pass as the path to keep the store in memory — tests and dry runs. */
export const IN_MEMORY = ":memory:";

export type HexString = `0x${string}`;
export type SettlementOutcome = "settled" | "rejected" | "error";
export type ItemKind = "hosted" | "external";

export interface SettlementEventInput {
    /** Epoch milliseconds. */
    at: number;
    /** Which flow produced the event — the facilitator writes `"settle"`. */
    kind: string;
    payer: HexString;
    payTo: HexString;
    amountBase: bigint;
    outcome: SettlementOutcome;
    txHash?: HexString | null;
    gasUsed?: bigint | null;
    errorCode?: string | null;
}

export interface SettlementEvent {
    id: number;
    at: number;
    kind: string;
    payer: HexString;
    payTo: HexString;
    amountBase: bigint;
    outcome: SettlementOutcome;
    txHash: HexString | null;
    gasUsed: bigint | null;
    errorCode: string | null;
}

export interface LedgerSummary {
    total: number;
    succeeded: number;
    failed: number;
    /** Sum of `amountBase` over settled events, keyed by `payTo`. */
    volumeByPayTo: Record<string, bigint>;
    /** Distinct payers with at least one settled event. */
    uniquePayers: number;
}

export interface Ledger {
    record(event: SettlementEventInput): SettlementEvent;
    /** Newest first. */
    list(options?: {limit?: number}): SettlementEvent[];
    /** Events with `at >= sinceMs`; pass `0` for all time. */
    summary(window: {sinceMs: number}): LedgerSummary;
}

export interface Budget {
    /** Wei spent on `day` (`YYYY-MM-DD`), `0n` when nothing was recorded. */
    load(day: string): bigint;
    save(day: string, spentWei: bigint): void;
}

export interface SellerInput {
    slug: string;
    name: string;
    payTo: HexString;
    createdAt: number;
}

export interface Seller {
    slug: string;
    name: string;
    payTo: HexString;
    createdAt: number;
}

export interface Sellers {
    /** Insert, or update `name` and `payTo` of an existing slug — `createdAt` is kept. */
    upsert(seller: SellerInput): Seller;
    get(slug: string): Seller | null;
    /** Oldest first, slug as the tiebreak. */
    list(): Seller[];
}

export interface ItemInput {
    sellerSlug: string;
    name: string;
    priceBase: bigint;
    kind: ItemKind;
    /** Where an `external` item is served from; `null` for a hosted one. */
    resourceUrl?: string | null;
    createdAt: number;
}

export interface Item {
    id: number;
    sellerSlug: string;
    name: string;
    priceBase: bigint;
    kind: ItemKind;
    resourceUrl: string | null;
    createdAt: number;
}

export interface Items {
    create(item: ItemInput): Item;
    /** In insertion order. */
    listBySeller(slug: string): Item[];
}

export interface OrderInput {
    itemId: number;
    paymentIntentId: HexString;
    payer: HexString;
    amountBase: bigint;
    txHash?: HexString | null;
    status: string;
    createdAt: number;
}

export interface Order {
    id: number;
    itemId: number;
    paymentIntentId: HexString;
    payer: HexString;
    amountBase: bigint;
    txHash: HexString | null;
    status: string;
    createdAt: number;
}

export interface Orders {
    /**
     * Insert the order, or return the one already stored for this `paymentIntentId`.
     * The second delivery of one payment is the same ticket, never a new row.
     */
    createOnce(order: OrderInput): Order;
}

export interface MapaeStore {
    readonly path: string;
    readonly ledger: Ledger;
    readonly budget: Budget;
    readonly sellers: Sellers;
    readonly items: Items;
    readonly orders: Orders;
    /** Idempotent. */
    close(): void;
}

/** What a bound parameter may be here — every amount is already text by this point. */
type Params = Record<string, string | number | null>;

// ── Validation ──────────────────────────────────────────────────────────────────────
// Validate, never cast. The `SpendBudget` in @mapae/delegation once turned into a string
// because a receipt field typed as bigint arrived as hex text; a TEXT column would accept
// that garbage silently and `BigInt()` would throw on the read, days later. Refusing at
// the write is the cheap end.

function amountText(value: unknown, name: string): string {
    if (typeof value !== "bigint") throw new TypeError(`${name} must be a bigint`);
    if (value < 0n) throw new RangeError(`${name} must not be negative`);
    return value.toString();
}

function optionalAmountText(value: bigint | null | undefined, name: string): string | null {
    return value === null || value === undefined ? null : amountText(value, name);
}

function millis(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer of epoch milliseconds`);
    }
    return value;
}

function positiveInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
    }
    return value;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayKey(value: unknown): string {
    if (typeof value !== "string" || !DAY.test(value)) {
        throw new TypeError("day must be YYYY-MM-DD");
    }
    return value;
}

/** URL-safe: the slug is a route segment for the hosted shop. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function slugKey(value: unknown): string {
    if (typeof value !== "string" || !SLUG.test(value)) {
        throw new TypeError("slug must be 1–64 lowercase letters, digits or hyphens");
    }
    return value;
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────

interface SettlementEventRow {
    id: number;
    at: number;
    kind: string;
    payer: string;
    pay_to: string;
    amount_base: string;
    tx_hash: string | null;
    outcome: string;
    gas_used: string | null;
    error_code: string | null;
}

function toSettlementEvent(row: SettlementEventRow): SettlementEvent {
    return {
        id: row.id,
        at: row.at,
        kind: row.kind,
        payer: row.payer as HexString,
        payTo: row.pay_to as HexString,
        amountBase: BigInt(row.amount_base),
        outcome: row.outcome as SettlementOutcome,
        txHash: row.tx_hash as HexString | null,
        gasUsed: row.gas_used === null ? null : BigInt(row.gas_used),
        errorCode: row.error_code,
    };
}

function createLedger(db: Database): Ledger {
    const insert = db.query<SettlementEventRow, Params>(
        `INSERT INTO settlement_events
            (at, kind, payer, pay_to, amount_base, tx_hash, outcome, gas_used, error_code)
         VALUES ($at, $kind, $payer, $payTo, $amountBase, $txHash, $outcome, $gasUsed, $errorCode)
         RETURNING *`,
    );
    const newest = db.query<SettlementEventRow, Params>(
        `SELECT * FROM settlement_events ORDER BY at DESC, id DESC LIMIT $limit`,
    );
    const counts = db.query<{total: number; succeeded: number; payers: number}, Params>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE outcome = 'settled') AS succeeded,
                COUNT(DISTINCT payer) FILTER (WHERE outcome = 'settled') AS payers
         FROM settlement_events
         WHERE at >= $since`,
    );
    // Summed in JavaScript: SQLite's SUM over TEXT goes through a double and loses
    // precision past 2^53, which a base-unit total reaches.
    const settledAmounts = db.query<{pay_to: string; amount_base: string}, Params>(
        `SELECT pay_to, amount_base FROM settlement_events
         WHERE outcome = 'settled' AND at >= $since`,
    );

    return {
        record(event) {
            const row = insert.get({
                at: millis(event.at, "at"),
                kind: event.kind,
                payer: event.payer,
                payTo: event.payTo,
                amountBase: amountText(event.amountBase, "amountBase"),
                txHash: event.txHash ?? null,
                outcome: event.outcome,
                gasUsed: optionalAmountText(event.gasUsed, "gasUsed"),
                errorCode: event.errorCode ?? null,
            });
            if (!row) throw new Error("settlement_events insert returned no row");
            return toSettlementEvent(row);
        },
        list({limit = 100} = {}) {
            return newest.all({limit: positiveInteger(limit, "limit")}).map(toSettlementEvent);
        },
        summary({sinceMs}) {
            const since = millis(sinceMs, "sinceMs");
            const tally = counts.get({since}) ?? {total: 0, succeeded: 0, payers: 0};
            const volumeByPayTo: Record<string, bigint> = {};
            for (const {pay_to, amount_base} of settledAmounts.all({since})) {
                volumeByPayTo[pay_to] = (volumeByPayTo[pay_to] ?? 0n) + BigInt(amount_base);
            }
            return {
                total: tally.total,
                succeeded: tally.succeeded,
                failed: tally.total - tally.succeeded,
                volumeByPayTo,
                uniquePayers: tally.payers,
            };
        },
    };
}

// ── Budget ──────────────────────────────────────────────────────────────────────────

function createBudget(db: Database): Budget {
    const select = db.query<{spent_wei: string}, Params>(
        `SELECT spent_wei FROM budget_days WHERE day = $day`,
    );
    const upsert = db.query<never, Params>(
        `INSERT INTO budget_days (day, spent_wei) VALUES ($day, $spentWei)
         ON CONFLICT (day) DO UPDATE SET spent_wei = excluded.spent_wei`,
    );
    return {
        load(day) {
            const row = select.get({day: dayKey(day)});
            return row ? BigInt(row.spent_wei) : 0n;
        },
        save(day, spentWei) {
            upsert.run({day: dayKey(day), spentWei: amountText(spentWei, "spentWei")});
        },
    };
}

// ── Sellers ─────────────────────────────────────────────────────────────────────────

interface SellerRow {
    slug: string;
    name: string;
    pay_to: string;
    created_at: number;
}

function toSeller(row: SellerRow): Seller {
    return {
        slug: row.slug,
        name: row.name,
        payTo: row.pay_to as HexString,
        createdAt: row.created_at,
    };
}

function createSellers(db: Database): Sellers {
    const upsert = db.query<SellerRow, Params>(
        `INSERT INTO sellers (slug, name, pay_to, created_at)
         VALUES ($slug, $name, $payTo, $createdAt)
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name, pay_to = excluded.pay_to
         RETURNING *`,
    );
    const select = db.query<SellerRow, Params>(`SELECT * FROM sellers WHERE slug = $slug`);
    const all = db.query<SellerRow, []>(`SELECT * FROM sellers ORDER BY created_at, slug`);
    return {
        upsert(seller) {
            const row = upsert.get({
                slug: slugKey(seller.slug),
                name: seller.name,
                payTo: seller.payTo,
                createdAt: millis(seller.createdAt, "createdAt"),
            });
            if (!row) throw new Error("sellers upsert returned no row");
            return toSeller(row);
        },
        get(slug) {
            const row = select.get({slug: slugKey(slug)});
            return row ? toSeller(row) : null;
        },
        list() {
            return all.all().map(toSeller);
        },
    };
}

// ── Items ───────────────────────────────────────────────────────────────────────────

interface ItemRow {
    id: number;
    seller_slug: string;
    name: string;
    price_base: string;
    kind: string;
    resource_url: string | null;
    created_at: number;
}

function toItem(row: ItemRow): Item {
    return {
        id: row.id,
        sellerSlug: row.seller_slug,
        name: row.name,
        priceBase: BigInt(row.price_base),
        kind: row.kind as ItemKind,
        resourceUrl: row.resource_url,
        createdAt: row.created_at,
    };
}

function createItems(db: Database): Items {
    const insert = db.query<ItemRow, Params>(
        `INSERT INTO items (seller_slug, name, price_base, kind, resource_url, created_at)
         VALUES ($sellerSlug, $name, $priceBase, $kind, $resourceUrl, $createdAt)
         RETURNING *`,
    );
    const bySeller = db.query<ItemRow, Params>(
        `SELECT * FROM items WHERE seller_slug = $slug ORDER BY id`,
    );
    return {
        create(item) {
            const row = insert.get({
                sellerSlug: slugKey(item.sellerSlug),
                name: item.name,
                priceBase: amountText(item.priceBase, "priceBase"),
                kind: item.kind,
                resourceUrl: item.resourceUrl ?? null,
                createdAt: millis(item.createdAt, "createdAt"),
            });
            if (!row) throw new Error("items insert returned no row");
            return toItem(row);
        },
        listBySeller(slug) {
            return bySeller.all({slug: slugKey(slug)}).map(toItem);
        },
    };
}

// ── Orders ──────────────────────────────────────────────────────────────────────────

interface OrderRow {
    id: number;
    item_id: number;
    payment_intent_id: string;
    payer: string;
    amount_base: string;
    tx_hash: string | null;
    status: string;
    created_at: number;
}

function toOrder(row: OrderRow): Order {
    return {
        id: row.id,
        itemId: row.item_id,
        paymentIntentId: row.payment_intent_id as HexString,
        payer: row.payer as HexString,
        amountBase: BigInt(row.amount_base),
        txHash: row.tx_hash as HexString | null,
        status: row.status,
        createdAt: row.created_at,
    };
}

function createOrders(db: Database): Orders {
    const insert = db.query<OrderRow, Params>(
        `INSERT INTO orders
            (item_id, payment_intent_id, payer, amount_base, tx_hash, status, created_at)
         VALUES ($itemId, $paymentIntentId, $payer, $amountBase, $txHash, $status, $createdAt)
         ON CONFLICT (payment_intent_id) DO NOTHING
         RETURNING *`,
    );
    const byIntent = db.query<OrderRow, Params>(
        `SELECT * FROM orders WHERE payment_intent_id = $paymentIntentId`,
    );
    return {
        createOnce(order) {
            const inserted = insert.get({
                itemId: positiveInteger(order.itemId, "itemId"),
                paymentIntentId: order.paymentIntentId,
                payer: order.payer,
                amountBase: amountText(order.amountBase, "amountBase"),
                txHash: order.txHash ?? null,
                status: order.status,
                createdAt: millis(order.createdAt, "createdAt"),
            });
            if (inserted) return toOrder(inserted);
            // DO NOTHING returned no row, so the intent is already on file. The store
            // is single-process and synchronous; nothing can delete it in between.
            const existing = byIntent.get({paymentIntentId: order.paymentIntentId});
            if (!existing) throw new Error("orders: duplicate intent vanished before read");
            return toOrder(existing);
        },
    };
}

// ── Open ────────────────────────────────────────────────────────────────────────────

function migrate(db: Database, path: string): void {
    const version = db.query<{user_version: number}, []>("PRAGMA user_version").get();
    const current = version?.user_version ?? 0;
    if (current === SCHEMA_VERSION) return;
    if (current > SCHEMA_VERSION) {
        throw new Error(
            `store ${path} is schema version ${current}; this build supports up to ${SCHEMA_VERSION}`,
        );
    }
    // Version 0 is an empty file. Creation and the version stamp land together or not
    // at all, so a crash mid-way leaves a file the next start treats as fresh.
    db.transaction(() => {
        db.exec(SCHEMA_SQL);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
}

/**
 * Open (creating if needed) the store at `path`, or an in-memory one for `":memory:"`.
 * Refuses a file written by a newer schema version rather than guessing at it.
 */
export function openStore(path: string): MapaeStore {
    if (typeof path !== "string" || path.length === 0) {
        throw new TypeError(`store path must be a file path or ${IN_MEMORY}`);
    }
    const inMemory = path === IN_MEMORY;
    if (!inMemory) mkdirSync(dirname(path), {recursive: true});
    const db = new Database(path, {create: true, readwrite: true, strict: true});
    try {
        db.exec("PRAGMA foreign_keys = ON");
        // WAL keeps a reader (an operator's sqlite3 shell) from blocking the service's
        // writes; it is a property of the file, so it is set once and persists.
        if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
        migrate(db, path);
    } catch (error) {
        db.close();
        throw error;
    }
    let closed = false;
    return {
        path,
        ledger: createLedger(db),
        budget: createBudget(db),
        sellers: createSellers(db),
        items: createItems(db),
        orders: createOrders(db),
        close() {
            if (closed) return;
            closed = true;
            db.close();
        },
    };
}
