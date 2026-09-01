import {afterEach, describe, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {createHash} from "node:crypto";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {IN_MEMORY, SCHEMA_VERSION, openStore, type MapaeStore, type SellerInput} from "./index.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CAFE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = `0x${"c".repeat(64)}` as const;
const INTENT = `0x${"d".repeat(64)}` as const;
const OTHER_INTENT = `0x${"e".repeat(64)}` as const;
const THIRD_INTENT = `0x${"f".repeat(64)}` as const;

const HOUR = 3_600_000;
const T0 = 1_787_961_600_000;

const sha256 = (token: string): string => createHash("sha256").update(token).digest("hex");
const CAFE_TOKEN_HASH = sha256("cafe-manage-token");
const SHOP_TOKEN_HASH = sha256("shop-manage-token");

const HOSTED_CAFE: SellerInput = {
    slug: "cafe",
    kind: "hosted",
    name: "카페",
    payTo: CAFE,
    internal: false,
    createdAt: T0,
};
const EXTERNAL_SHOP: SellerInput = {
    slug: "shop",
    kind: "external",
    name: "가게",
    payTo: SHOP,
    baseUrl: "https://shop.example",
    internal: false,
    createdAt: T0,
};

/**
 * The version-2 schema exactly as `schema.ts` shipped it, kept here so the refusal test
 * runs against a genuine v2 file — the tables, the `items.kind` column and the
 * `orders.item_id` reference that version 3 no longer has — rather than against a stub
 * that merely carries the number.
 */
const SCHEMA_V2_SQL = `
CREATE TABLE settlement_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payer TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    amount_base TEXT NOT NULL,
    tx_hash TEXT,
    outcome TEXT NOT NULL
        CONSTRAINT settlement_events_outcome CHECK (outcome IN ('settled', 'rejected', 'error')),
    gas_used TEXT,
    error_code TEXT
);
CREATE INDEX settlement_events_at ON settlement_events (at);
CREATE INDEX settlement_events_pay_to ON settlement_events (pay_to);
CREATE TABLE budget_days (day TEXT PRIMARY KEY, spent_wei TEXT NOT NULL);
CREATE TABLE faucet_windows (account TEXT PRIMARY KEY, minted_at INTEGER NOT NULL);
CREATE INDEX faucet_windows_minted_at ON faucet_windows (minted_at);
CREATE TABLE sellers (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    seller_slug TEXT NOT NULL REFERENCES sellers (slug),
    name TEXT NOT NULL,
    price_base TEXT NOT NULL,
    kind TEXT NOT NULL CONSTRAINT items_kind CHECK (kind IN ('hosted', 'external')),
    resource_url TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX items_seller_slug ON items (seller_slug);
CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    payment_intent_id TEXT NOT NULL UNIQUE,
    payer TEXT NOT NULL,
    amount_base TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX orders_item_id ON orders (item_id);
`;

const dirs: string[] = [];
const stores: MapaeStore[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mapae-store-"));
    dirs.push(dir);
    return dir;
}

function open(path = IN_MEMORY): MapaeStore {
    const store = openStore(path);
    stores.push(store);
    return store;
}

function rawUserVersion(path: string): number {
    const db = new Database(path, {readonly: true});
    try {
        return (db.query("PRAGMA user_version").get() as {user_version: number}).user_version;
    } finally {
        db.close();
    }
}

function rawTableNames(path: string): string[] {
    const db = new Database(path, {readonly: true});
    try {
        return (
            db
                .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .all() as {name: string}[]
        ).map((row) => row.name);
    } finally {
        db.close();
    }
}

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("openStore", () => {
    test("creates the current schema version on a fresh file and leaves it alone on reopen", () => {
        const path = join(tempDir(), "store.sqlite");
        open(path).close();
        expect(rawUserVersion(path)).toBe(SCHEMA_VERSION);
        expect(rawTableNames(path)).toEqual([
            "budget_days",
            "faucet_windows",
            "items",
            "orders",
            "sellers",
            "settlement_events",
        ]);

        open(path).close();
        expect(rawUserVersion(path)).toBe(SCHEMA_VERSION);
    });

    test("persists ledger, budget, seller, item and order across close and reopen", () => {
        const path = join(tempDir(), "store.sqlite");
        const first = open(path);
        const event = first.ledger.record({
            at: T0,
            kind: "settle",
            payer: ALICE,
            payTo: SHOP,
            amountBase: 100_000n,
            outcome: "settled",
            txHash: TX,
            gasUsed: 333_523n,
        });
        first.budget.save("2026-08-29", 42n);
        const seller = first.sellers.upsert({
            ...HOSTED_CAFE,
            manageTokenHash: CAFE_TOKEN_HASH,
            contact: "owner@cafe.example",
        });
        const item = first.items.upsert({
            sellerSlug: "cafe",
            key: "americano",
            name: "아메리카노",
            description: "따뜻한 한 잔",
            priceBase: 10_000n,
            createdAt: T0,
        });
        const order = first.orders.createOnce({
            sellerSlug: "cafe",
            itemKey: "americano",
            paymentIntentId: INTENT,
            payer: BOB,
            amountBase: 10_000n,
            txHash: TX,
            status: "settled",
            createdAt: T0 + 1,
        });
        first.close();

        const second = open(path);
        expect(second.ledger.list()).toEqual([event]);
        expect(second.budget.load("2026-08-29")).toBe(42n);
        expect(second.sellers.get("cafe")).toEqual(seller);
        expect(second.sellers.getByManageTokenHash(CAFE_TOKEN_HASH)).toEqual(seller);
        expect(second.items.listBySeller("cafe")).toEqual([item]);
        expect(second.orders.listBySeller("cafe")).toEqual([order]);
        expect(second.orders.createOnce({...order, payer: CAROL})).toEqual(order);
        expect(second.orders.summary({sinceMs: 0})).toEqual({total: 1, bySeller: {cafe: 1}});
    });

    test("refuses a genuine version-2 file rather than half-using it, and leaves it untouched", () => {
        const path = join(tempDir(), "stale.sqlite");
        const db = new Database(path, {create: true, readwrite: true});
        db.exec(SCHEMA_V2_SQL);
        db.exec(
            `INSERT INTO sellers (slug, name, pay_to, created_at) VALUES ('cafe', '카페', '${CAFE}', ${T0})`,
        );
        db.exec(
            `INSERT INTO items (seller_slug, name, price_base, kind, created_at)
             VALUES ('cafe', '라떼', '20000', 'hosted', ${T0})`,
        );
        db.exec("PRAGMA user_version = 2");
        db.close();

        expect(() => openStore(path)).toThrow(/schema version 2.*does not migrate/);

        // Nothing was created, dropped or re-stamped: the v2-only column is still there
        // with its row, and the version still says 2, so the operator can move the file
        // aside with its contents intact.
        expect(rawUserVersion(path)).toBe(2);
        const stale = new Database(path, {readonly: true});
        try {
            expect(stale.query("SELECT kind FROM items").all()).toEqual([{kind: "hosted"}]);
            expect(stale.query("SELECT item_id FROM orders").all()).toEqual([]);
        } finally {
            stale.close();
        }
    });

    test("refuses a store whose schema version is newer than this build", () => {
        const path = join(tempDir(), "future.sqlite");
        const db = new Database(path, {create: true, readwrite: true});
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        db.close();

        expect(() => openStore(path)).toThrow(
            new RegExp(`schema version ${SCHEMA_VERSION + 1}.*supports up to ${SCHEMA_VERSION}`),
        );
        expect(rawUserVersion(path)).toBe(SCHEMA_VERSION + 1);
    });

    test("uses WAL journaling on a file store", () => {
        const path = join(tempDir(), "store.sqlite");
        const store = open(path);
        store.budget.save("2026-08-29", 1n);
        store.close();

        const db = new Database(path, {readonly: true});
        const mode = db.query("PRAGMA journal_mode").get() as {journal_mode: string};
        db.close();
        expect(mode.journal_mode).toBe("wal");
    });

    test("creates missing parent directories for a file store", () => {
        const path = join(tempDir(), "data", "nested", "store.sqlite");
        open(path).close();
        expect(existsSync(path)).toBe(true);
    });

    test("refuses an empty path and closes idempotently", () => {
        expect(() => openStore("")).toThrow(TypeError);
        const store = open();
        store.close();
        expect(() => store.close()).not.toThrow();
    });
});

describe("ledger", () => {
    test("record returns the stored row and round-trips bigints above 2^63", () => {
        const store = open();
        const event = store.ledger.record({
            at: T0,
            kind: "settle",
            payer: ALICE,
            payTo: SHOP,
            amountBase: 2n ** 70n,
            outcome: "error",
            txHash: TX,
            gasUsed: 2n ** 64n,
            errorCode: "settlement_unconfirmed",
        });
        expect(event).toEqual({
            id: 1,
            at: T0,
            kind: "settle",
            payer: ALICE,
            payTo: SHOP,
            amountBase: 2n ** 70n,
            outcome: "error",
            txHash: TX,
            gasUsed: 2n ** 64n,
            errorCode: "settlement_unconfirmed",
        });
        expect(store.ledger.list()).toEqual([event]);

        const rejected = store.ledger.record({
            at: T0,
            kind: "settle",
            payer: ALICE,
            payTo: SHOP,
            amountBase: 1n,
            outcome: "rejected",
        });
        expect(rejected.txHash).toBeNull();
        expect(rejected.gasUsed).toBeNull();
        expect(rejected.errorCode).toBeNull();
    });

    test("record refuses non-bigint amounts, negative amounts and unknown outcomes", () => {
        const store = open();
        const base = {at: T0, kind: "settle", payer: ALICE, payTo: SHOP, outcome: "settled"} as const;
        expect(() => store.ledger.record({...base, amountBase: 1 as never})).toThrow(TypeError);
        expect(() => store.ledger.record({...base, amountBase: "1" as never})).toThrow(TypeError);
        expect(() => store.ledger.record({...base, amountBase: -1n})).toThrow(RangeError);
        expect(() => store.ledger.record({...base, amountBase: 1n, gasUsed: 1 as never})).toThrow(
            TypeError,
        );
        expect(() => store.ledger.record({...base, amountBase: 1n, at: 1.5})).toThrow(TypeError);
        expect(() =>
            store.ledger.record({...base, amountBase: 1n, outcome: "maybe" as never}),
        ).toThrow(/settlement_events_outcome/);
        expect(store.ledger.list()).toEqual([]);
    });

    test("list returns newest first, id as the tiebreak, and honours limit", () => {
        const store = open();
        const base = {kind: "settle", payer: ALICE, payTo: SHOP, amountBase: 1n, outcome: "settled"} as const;
        store.ledger.record({...base, at: T0});
        store.ledger.record({...base, at: T0 + 2 * HOUR});
        store.ledger.record({...base, at: T0 + HOUR});
        store.ledger.record({...base, at: T0 + 2 * HOUR});

        expect(store.ledger.list().map((event) => event.id)).toEqual([4, 2, 3, 1]);
        expect(store.ledger.list({limit: 2}).map((event) => event.id)).toEqual([4, 2]);
        expect(() => store.ledger.list({limit: 0})).toThrow(TypeError);
    });

    test("summary counts outcomes, sums settled volume per pay_to and distinct payers", () => {
        const store = open();
        const at = T0;
        store.ledger.record({at, kind: "settle", payer: ALICE, payTo: SHOP, amountBase: 100n, outcome: "settled"});
        store.ledger.record({at, kind: "settle", payer: ALICE, payTo: SHOP, amountBase: 50n, outcome: "settled"});
        store.ledger.record({at, kind: "settle", payer: BOB, payTo: CAFE, amountBase: 30n, outcome: "settled"});
        store.ledger.record({at, kind: "settle", payer: ALICE, payTo: CAFE, amountBase: 999n, outcome: "rejected"});
        store.ledger.record({at, kind: "settle", payer: BOB, payTo: SHOP, amountBase: 5n, outcome: "error"});
        store.ledger.record({at, kind: "settle", payer: CAROL, payTo: SHOP, amountBase: 7n, outcome: "rejected"});

        expect(store.ledger.summary({sinceMs: 0})).toEqual({
            total: 6,
            succeeded: 3,
            failed: 3,
            volumeByPayTo: {[SHOP]: 150n, [CAFE]: 30n},
            uniquePayers: 2,
        });
    });

    test("summary sums exactly past 2^53 and honours an inclusive since window", () => {
        const store = open();
        const base = {kind: "settle", payer: ALICE, payTo: SHOP, outcome: "settled"} as const;
        store.ledger.record({...base, at: T0, amountBase: 2n ** 60n});
        store.ledger.record({...base, at: T0 + 2 * HOUR, amountBase: 1n});

        expect(store.ledger.summary({sinceMs: 0}).volumeByPayTo[SHOP]).toBe(2n ** 60n + 1n);
        expect(store.ledger.summary({sinceMs: T0 + HOUR})).toEqual({
            total: 1,
            succeeded: 1,
            failed: 0,
            volumeByPayTo: {[SHOP]: 1n},
            uniquePayers: 1,
        });
        expect(store.ledger.summary({sinceMs: T0 + 2 * HOUR}).total).toBe(1);
        expect(store.ledger.summary({sinceMs: T0 + 2 * HOUR + 1}).total).toBe(0);
        expect(() => store.ledger.summary({sinceMs: -1})).toThrow(TypeError);
    });

    test("summary on an empty store is all zeros", () => {
        expect(open().ledger.summary({sinceMs: 0})).toEqual({
            total: 0,
            succeeded: 0,
            failed: 0,
            volumeByPayTo: {},
            uniquePayers: 0,
        });
    });
});

describe("budget", () => {
    test("load returns 0n for an unknown day and round-trips what save wrote", () => {
        const store = open();
        expect(store.budget.load("2026-08-29")).toBe(0n);

        store.budget.save("2026-08-29", 123n);
        expect(store.budget.load("2026-08-29")).toBe(123n);

        store.budget.save("2026-08-29", 2n ** 80n);
        expect(store.budget.load("2026-08-29")).toBe(2n ** 80n);
        expect(store.budget.load("2026-08-30")).toBe(0n);
    });

    test("refuses a day that is not YYYY-MM-DD and a spend that is not a bigint", () => {
        const store = open();
        expect(() => store.budget.load("2026-8-29")).toThrow(TypeError);
        expect(() => store.budget.save("today", 1n)).toThrow(TypeError);
        expect(() => store.budget.save("2026-08-29", 1 as never)).toThrow(TypeError);
        expect(() => store.budget.save("2026-08-29", -1n)).toThrow(RangeError);
    });
});

describe("sellers", () => {
    test("upsert stores every column with nulls for the optional ones; get is null for unknown", () => {
        const store = open();
        expect(store.sellers.upsert(HOSTED_CAFE)).toEqual({
            slug: "cafe",
            kind: "hosted",
            name: "카페",
            payTo: CAFE,
            baseUrl: null,
            manageTokenHash: null,
            contact: null,
            internal: false,
            createdAt: T0,
        });
        expect(
            store.sellers.upsert({
                ...EXTERNAL_SHOP,
                manageTokenHash: SHOP_TOKEN_HASH,
                contact: "@shop",
                internal: true,
            }),
        ).toEqual({
            slug: "shop",
            kind: "external",
            name: "가게",
            payTo: SHOP,
            baseUrl: "https://shop.example",
            manageTokenHash: SHOP_TOKEN_HASH,
            contact: "@shop",
            internal: true,
            createdAt: T0,
        });
        expect(store.sellers.get("shop")?.internal).toBe(true);
        expect(store.sellers.get("nope")).toBeNull();
    });

    test("upsert overwrites every column but created_at", () => {
        const store = open();
        store.sellers.upsert({...HOSTED_CAFE, manageTokenHash: CAFE_TOKEN_HASH, contact: "old"});

        const updated = store.sellers.upsert({
            slug: "cafe",
            kind: "external",
            name: "카페 마패",
            payTo: SHOP,
            baseUrl: "https://cafe.example",
            manageTokenHash: SHOP_TOKEN_HASH,
            contact: "new",
            internal: true,
            createdAt: T0 + HOUR,
        });
        expect(updated).toEqual({
            slug: "cafe",
            kind: "external",
            name: "카페 마패",
            payTo: SHOP,
            baseUrl: "https://cafe.example",
            manageTokenHash: SHOP_TOKEN_HASH,
            contact: "new",
            internal: true,
            createdAt: T0,
        });
        expect(store.sellers.get("cafe")).toEqual(updated);
        expect(store.sellers.getByManageTokenHash(CAFE_TOKEN_HASH)).toBeNull();
        expect(store.sellers.getByManageTokenHash(SHOP_TOKEN_HASH)).toEqual(updated);

        // Dropping the token and the contact writes nulls back, not the old values.
        const cleared = store.sellers.upsert({
            ...HOSTED_CAFE,
            createdAt: T0 + 2 * HOUR,
        });
        expect(cleared.manageTokenHash).toBeNull();
        expect(cleared.contact).toBeNull();
        expect(cleared.baseUrl).toBeNull();
        expect(cleared.createdAt).toBe(T0);
        expect(store.sellers.list()).toHaveLength(1);
    });

    test("list orders by created_at then slug, and hides internal sellers only when asked", () => {
        const store = open();
        store.sellers.upsert({...HOSTED_CAFE, slug: "zeta", createdAt: T0});
        store.sellers.upsert({...HOSTED_CAFE, slug: "alpha", createdAt: T0 + HOUR});
        store.sellers.upsert({...HOSTED_CAFE, slug: "mid", createdAt: T0, internal: true});

        const slugs = (sellers: {slug: string}[]) => sellers.map((seller) => seller.slug);
        expect(slugs(store.sellers.list())).toEqual(["mid", "zeta", "alpha"]);
        expect(slugs(store.sellers.list({includeInternal: true}))).toEqual(["mid", "zeta", "alpha"]);
        expect(slugs(store.sellers.list({includeInternal: false}))).toEqual(["zeta", "alpha"]);
    });

    test("getByManageTokenHash finds the seller and refuses anything but lowercase sha256 hex", () => {
        const store = open();
        const seller = store.sellers.upsert({...HOSTED_CAFE, manageTokenHash: CAFE_TOKEN_HASH});
        expect(store.sellers.getByManageTokenHash(CAFE_TOKEN_HASH)).toEqual(seller);
        expect(store.sellers.getByManageTokenHash(SHOP_TOKEN_HASH)).toBeNull();

        for (const bad of [
            CAFE_TOKEN_HASH.toUpperCase(),
            CAFE_TOKEN_HASH.slice(1),
            `0x${CAFE_TOKEN_HASH}`,
            "cafe-manage-token",
            "",
        ]) {
            expect(() => store.sellers.getByManageTokenHash(bad)).toThrow(TypeError);
            expect(() => store.sellers.upsert({...HOSTED_CAFE, manageTokenHash: bad})).toThrow(
                TypeError,
            );
        }
        // A seller without a token is not "a seller whose token hashes to null".
        store.sellers.upsert(EXTERNAL_SHOP);
        expect(store.sellers.list()).toHaveLength(2);
    });

    test("two sellers cannot share a manage token hash", () => {
        const store = open();
        store.sellers.upsert({...HOSTED_CAFE, manageTokenHash: CAFE_TOKEN_HASH});
        expect(() =>
            store.sellers.upsert({...EXTERNAL_SHOP, manageTokenHash: CAFE_TOKEN_HASH}),
        ).toThrow(/UNIQUE constraint failed: sellers.manage_token_hash/);
        expect(store.sellers.get("shop")).toBeNull();
        // Two sellers without a token are fine: NULLs are distinct under UNIQUE.
        store.sellers.upsert(EXTERNAL_SHOP);
        store.sellers.upsert({...HOSTED_CAFE, slug: "other"});
        expect(store.sellers.list()).toHaveLength(3);
    });

    test("exactly the external sellers carry a base_url (sellers_base_url)", () => {
        const store = open();
        expect(() =>
            store.sellers.upsert({...HOSTED_CAFE, baseUrl: "https://cafe.example"}),
        ).toThrow(/sellers_base_url/);
        expect(() => store.sellers.upsert({...EXTERNAL_SHOP, baseUrl: null})).toThrow(
            /sellers_base_url/,
        );
        expect(() => store.sellers.upsert({...EXTERNAL_SHOP, baseUrl: undefined})).toThrow(
            /sellers_base_url/,
        );
        expect(store.sellers.list()).toEqual([]);

        // The rule holds on update too: a hosted seller cannot be flipped to external
        // without a base_url, nor the other way round while keeping one.
        store.sellers.upsert(HOSTED_CAFE);
        expect(() => store.sellers.upsert({...HOSTED_CAFE, kind: "external"})).toThrow(
            /sellers_base_url/,
        );
        expect(store.sellers.get("cafe")?.kind).toBe("hosted");
    });

    test("refuses an unknown kind (sellers_kind) and a non-boolean internal flag", () => {
        const store = open();
        expect(() => store.sellers.upsert({...HOSTED_CAFE, kind: "other" as never})).toThrow(
            /sellers_kind/,
        );
        expect(() => store.sellers.upsert({...HOSTED_CAFE, internal: 1 as never})).toThrow(
            TypeError,
        );
        expect(() => store.sellers.upsert({...HOSTED_CAFE, internal: undefined as never})).toThrow(
            TypeError,
        );
        expect(store.sellers.list()).toEqual([]);
    });

    test("refuses a slug that is not URL-safe", () => {
        const store = open();
        for (const slug of ["", "Bad Slug", "café", "-lead", "a".repeat(65)]) {
            expect(() => store.sellers.upsert({...HOSTED_CAFE, slug})).toThrow(TypeError);
        }
        expect(() => store.sellers.get("Bad Slug")).toThrow(TypeError);
        expect(store.sellers.list()).toEqual([]);
    });
});

describe("items", () => {
    const LATTE = {
        sellerSlug: "cafe",
        key: "latte",
        name: "라떼",
        description: "우유 듬뿍",
        priceBase: 20_000n,
        createdAt: T0,
    } as const;

    test("upsert inserts, then updates the seller's key in place keeping id and created_at", () => {
        const store = open();
        store.sellers.upsert(HOSTED_CAFE);
        store.sellers.upsert(EXTERNAL_SHOP);
        const latte = store.items.upsert(LATTE);
        expect(latte).toEqual({
            id: 1,
            sellerSlug: "cafe",
            key: "latte",
            name: "라떼",
            description: "우유 듬뿍",
            priceBase: 20_000n,
            resourceUrl: null,
            createdAt: T0,
        });

        const updated = store.items.upsert({
            ...LATTE,
            name: "바닐라 라떼",
            description: "시럽 추가",
            priceBase: 25_000n,
            resourceUrl: "https://cafe.example/latte",
            createdAt: T0 + HOUR,
        });
        expect(updated).toEqual({
            ...latte,
            name: "바닐라 라떼",
            description: "시럽 추가",
            priceBase: 25_000n,
            resourceUrl: "https://cafe.example/latte",
        });
        expect(store.items.get("cafe", "latte")).toEqual(updated);
        expect(store.items.listBySeller("cafe")).toEqual([updated]);

        // The key is scoped to the seller: another seller's "latte" is another row.
        const other = store.items.upsert({...LATTE, sellerSlug: "shop"});
        expect(other.id).toBe(2);
        expect(store.items.get("shop", "latte")).toEqual(other);
    });

    test("get returns null for an unknown key and refuses a key that is not URL-safe", () => {
        const store = open();
        store.sellers.upsert(HOSTED_CAFE);
        store.items.upsert(LATTE);
        expect(store.items.get("cafe", "mocha")).toBeNull();
        expect(store.items.get("shop", "latte")).toBeNull();
        for (const key of ["", "Latte", "라떼", "-x", "a".repeat(65)]) {
            expect(() => store.items.get("cafe", key)).toThrow(TypeError);
            expect(() => store.items.upsert({...LATTE, key})).toThrow(TypeError);
        }
        expect(store.items.listBySeller("cafe")).toHaveLength(1);
    });

    test("listBySeller returns the seller's items in insertion order, same-price items included", () => {
        const store = open();
        store.sellers.upsert(HOSTED_CAFE);
        store.sellers.upsert(EXTERNAL_SHOP);
        const latte = store.items.upsert({...LATTE, createdAt: T0 + HOUR});
        store.items.upsert({...LATTE, sellerSlug: "shop", key: "elsewhere"});
        const mocha = store.items.upsert({...LATTE, key: "mocha", name: "모카"});
        const api = store.items.upsert({
            sellerSlug: "cafe",
            key: "api",
            name: "API",
            description: "월간 호출권",
            priceBase: 10_000n,
            resourceUrl: "https://builder.example/api",
            createdAt: T0,
        });

        expect(store.items.listBySeller("cafe")).toEqual([latte, mocha, api]);
        expect(mocha.priceBase).toBe(latte.priceBase);
        expect(api.id).toBe(4);
        expect(api.resourceUrl).toBe("https://builder.example/api");
        expect(store.items.listBySeller("nobody")).toEqual([]);
    });

    test("rejects an unknown seller (FK) and a negative price", () => {
        const store = open();
        store.sellers.upsert(HOSTED_CAFE);
        expect(() => store.items.upsert({...LATTE, sellerSlug: "ghost"})).toThrow(/FOREIGN KEY/);
        expect(() => store.items.upsert({...LATTE, priceBase: -1n})).toThrow(RangeError);
        expect(() => store.items.upsert({...LATTE, priceBase: 1 as never})).toThrow(TypeError);
        expect(store.items.listBySeller("cafe")).toEqual([]);
    });
});

describe("orders", () => {
    const PAID = {
        sellerSlug: "cafe",
        itemKey: "latte",
        paymentIntentId: INTENT,
        payer: ALICE,
        amountBase: 20_000n,
        txHash: TX,
        status: "settled",
        createdAt: T0,
    } as const;

    function seedCafe(store: MapaeStore): void {
        store.sellers.upsert(HOSTED_CAFE);
        store.items.upsert({
            sellerSlug: "cafe",
            key: "latte",
            name: "라떼",
            description: "우유 듬뿍",
            priceBase: 20_000n,
            createdAt: T0,
        });
    }

    test("createOnce returns the existing order on a duplicate payment intent", () => {
        const store = open();
        seedCafe(store);
        const first = store.orders.createOnce(PAID);
        expect(first).toEqual({
            id: 1,
            sellerSlug: "cafe",
            itemKey: "latte",
            paymentIntentId: INTENT,
            payer: ALICE,
            amountBase: 20_000n,
            txHash: TX,
            status: "settled",
            createdAt: T0,
        });

        const replay = store.orders.createOnce({
            ...PAID,
            payer: BOB,
            amountBase: 1n,
            txHash: null,
            status: "delivered",
            createdAt: T0 + HOUR,
        });
        expect(replay).toEqual(first);

        const next = store.orders.createOnce({
            ...PAID,
            paymentIntentId: OTHER_INTENT,
            payer: BOB,
            txHash: undefined,
            createdAt: T0 + HOUR,
        });
        expect(next.id).toBe(2);
        expect(next.txHash).toBeNull();
        expect(store.orders.listBySeller("cafe")).toHaveLength(2);
    });

    test("createOnce rejects an order whose (seller, key) names no item", () => {
        const store = open();
        seedCafe(store);
        // The composite FOREIGN KEY is enforced — `PRAGMA foreign_keys = ON` is set per
        // connection in openStore, and the parent pair is UNIQUE on items.
        expect(() => store.orders.createOnce({...PAID, itemKey: "mocha"})).toThrow(/FOREIGN KEY/);
        expect(() => store.orders.createOnce({...PAID, sellerSlug: "shop"})).toThrow(
            /FOREIGN KEY/,
        );
        expect(() => store.orders.createOnce({...PAID, itemKey: "Latte"})).toThrow(TypeError);
        expect(() => store.orders.createOnce({...PAID, amountBase: -1n})).toThrow(RangeError);
        expect(store.orders.listBySeller("cafe")).toEqual([]);
        expect(store.orders.summary({sinceMs: 0})).toEqual({total: 0, bySeller: {}});
    });

    test("listBySeller returns newest first, id as the tiebreak, and honours limit", () => {
        const store = open();
        seedCafe(store);
        store.sellers.upsert(EXTERNAL_SHOP);
        store.items.upsert({
            sellerSlug: "shop",
            key: "widget",
            name: "위젯",
            description: "외부 상품",
            priceBase: 1n,
            createdAt: T0,
        });
        store.orders.createOnce({...PAID, createdAt: T0});
        store.orders.createOnce({...PAID, paymentIntentId: OTHER_INTENT, createdAt: T0 + 2 * HOUR});
        store.orders.createOnce({...PAID, paymentIntentId: THIRD_INTENT, createdAt: T0 + 2 * HOUR});
        store.orders.createOnce({
            ...PAID,
            sellerSlug: "shop",
            itemKey: "widget",
            paymentIntentId: `0x${"1".repeat(64)}`,
            createdAt: T0 + 3 * HOUR,
        });

        const ids = (orders: {id: number}[]) => orders.map((order) => order.id);
        expect(ids(store.orders.listBySeller("cafe"))).toEqual([3, 2, 1]);
        expect(ids(store.orders.listBySeller("cafe", {limit: 2}))).toEqual([3, 2]);
        expect(ids(store.orders.listBySeller("shop"))).toEqual([4]);
        expect(store.orders.listBySeller("nobody")).toEqual([]);
        expect(() => store.orders.listBySeller("cafe", {limit: 0})).toThrow(TypeError);
    });

    test("summary counts orders per seller within an inclusive since window", () => {
        const store = open();
        seedCafe(store);
        store.sellers.upsert(EXTERNAL_SHOP);
        store.items.upsert({
            sellerSlug: "shop",
            key: "widget",
            name: "위젯",
            description: "외부 상품",
            priceBase: 1n,
            createdAt: T0,
        });
        store.orders.createOnce({...PAID, createdAt: T0});
        store.orders.createOnce({...PAID, paymentIntentId: OTHER_INTENT, createdAt: T0 + 2 * HOUR});
        store.orders.createOnce({
            ...PAID,
            sellerSlug: "shop",
            itemKey: "widget",
            paymentIntentId: THIRD_INTENT,
            createdAt: T0 + HOUR,
        });

        expect(store.orders.summary({sinceMs: 0})).toEqual({total: 3, bySeller: {cafe: 2, shop: 1}});
        expect(store.orders.summary({sinceMs: T0 + HOUR})).toEqual({
            total: 2,
            bySeller: {cafe: 1, shop: 1},
        });
        expect(store.orders.summary({sinceMs: T0 + 2 * HOUR})).toEqual({total: 1, bySeller: {cafe: 1}});
        expect(store.orders.summary({sinceMs: T0 + 2 * HOUR + 1})).toEqual({total: 0, bySeller: {}});
        expect(() => store.orders.summary({sinceMs: -1})).toThrow(TypeError);
    });
});

describe("faucet windows", () => {
    const LOWER = ALICE.toLowerCase();

    test("round-trips a window and reports nothing for an account that never drew", () => {
        const store = open();
        expect(store.faucetWindows.lastMintedAt(LOWER)).toBeUndefined();

        store.faucetWindows.record(LOWER, T0);
        expect(store.faucetWindows.lastMintedAt(LOWER)).toBe(T0);
        expect(store.faucetWindows.count()).toBe(1);

        // A second mint moves the window rather than adding a row.
        store.faucetWindows.record(LOWER, T0 + HOUR);
        expect(store.faucetWindows.lastMintedAt(LOWER)).toBe(T0 + HOUR);
        expect(store.faucetWindows.count()).toBe(1);
    });

    test("sweep drops windows at or before the cutoff and keeps the rest", () => {
        const store = open();
        store.faucetWindows.record(ALICE.toLowerCase(), T0);
        store.faucetWindows.record(BOB.toLowerCase(), T0 + HOUR);
        expect(store.faucetWindows.count()).toBe(2);

        store.faucetWindows.sweep(T0);
        expect(store.faucetWindows.count()).toBe(1);
        expect(store.faucetWindows.lastMintedAt(ALICE.toLowerCase())).toBeUndefined();
        expect(store.faucetWindows.lastMintedAt(BOB.toLowerCase())).toBe(T0 + HOUR);
    });

    /**
     * The whole reason the windows are on disk: a restart used to hand every account a
     * fresh day, which made the operator's own redeploy the cheapest way to drain the
     * faucet.
     */
    test("a window survives closing and reopening the file", () => {
        const path = join(tempDir(), "faucet.sqlite");
        const first = open(path);
        first.faucetWindows.record(LOWER, T0);
        first.close();

        expect(open(path).faucetWindows.lastMintedAt(LOWER)).toBe(T0);
    });

    test("refuses a key that is not a lowercase address, and a timestamp that is not epoch ms", () => {
        const store = open();
        // The gate lowercases before it gets here; a checksummed key means an upstream bug.
        const mixed = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
        expect(() => store.faucetWindows.lastMintedAt(mixed)).toThrow(TypeError);
        expect(() => store.faucetWindows.record(mixed, T0)).toThrow(TypeError);
        expect(() => store.faucetWindows.record("0x1234", T0)).toThrow(TypeError);
        expect(() => store.faucetWindows.record("alice", T0)).toThrow(TypeError);
        expect(() => store.faucetWindows.record(LOWER, -1)).toThrow(TypeError);
        expect(() => store.faucetWindows.record(LOWER, 1.5)).toThrow(TypeError);
        expect(() => store.faucetWindows.sweep(-1)).toThrow(TypeError);
    });
});
