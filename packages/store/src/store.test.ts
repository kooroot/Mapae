import {afterEach, describe, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {IN_MEMORY, SCHEMA_VERSION, openStore, type MapaeStore} from "./index.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const SHOP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CAFE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = `0x${"c".repeat(64)}` as const;
const INTENT = `0x${"d".repeat(64)}` as const;
const OTHER_INTENT = `0x${"e".repeat(64)}` as const;

const HOUR = 3_600_000;
const T0 = 1_787_961_600_000;

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

afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("openStore", () => {
    test("creates the current schema version on a fresh file and leaves it alone on reopen", () => {
        const path = join(tempDir(), "store.sqlite");
        open(path).close();
        expect(rawUserVersion(path)).toBe(SCHEMA_VERSION);

        const db = new Database(path, {readonly: true});
        const tables = db
            .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as {name: string}[];
        db.close();
        expect(tables.map((row) => row.name)).toEqual([
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
        const seller = first.sellers.upsert({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});
        const item = first.items.create({
            sellerSlug: "cafe",
            name: "아메리카노",
            priceBase: 10_000n,
            kind: "hosted",
            createdAt: T0,
        });
        const order = first.orders.createOnce({
            itemId: item.id,
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
        expect(second.items.listBySeller("cafe")).toEqual([item]);
        expect(second.orders.createOnce({...order, payer: CAROL})).toEqual(order);
    });

    test("refuses a store written by an older schema version rather than half-using it", () => {
        const path = join(tempDir(), "stale.sqlite");
        const db = new Database(path, {create: true, readwrite: true});
        db.exec("CREATE TABLE budget_days (day TEXT PRIMARY KEY, spent_wei TEXT NOT NULL)");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
        db.close();

        expect(() => openStore(path)).toThrow(
            new RegExp(`schema version ${SCHEMA_VERSION - 1}.*does not migrate`),
        );
        expect(rawUserVersion(path)).toBe(SCHEMA_VERSION - 1);
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
    test("upsert overwrites name and pay_to but keeps created_at; get is null for unknown", () => {
        const store = open();
        const created = store.sellers.upsert({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});
        expect(created).toEqual({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});

        const updated = store.sellers.upsert({
            slug: "cafe",
            name: "카페 마패",
            payTo: SHOP,
            createdAt: T0 + HOUR,
        });
        expect(updated).toEqual({slug: "cafe", name: "카페 마패", payTo: SHOP, createdAt: T0});
        expect(store.sellers.get("cafe")).toEqual(updated);
        expect(store.sellers.get("nope")).toBeNull();
        expect(store.sellers.list()).toHaveLength(1);
    });

    test("list orders by created_at then slug", () => {
        const store = open();
        store.sellers.upsert({slug: "zeta", name: "Z", payTo: SHOP, createdAt: T0});
        store.sellers.upsert({slug: "alpha", name: "A", payTo: SHOP, createdAt: T0 + HOUR});
        store.sellers.upsert({slug: "mid", name: "M", payTo: SHOP, createdAt: T0});
        expect(store.sellers.list().map((seller) => seller.slug)).toEqual(["mid", "zeta", "alpha"]);
    });

    test("refuses a slug that is not URL-safe", () => {
        const store = open();
        for (const slug of ["", "Bad Slug", "café", "-lead", "a".repeat(65)]) {
            expect(() => store.sellers.upsert({slug, name: "x", payTo: SHOP, createdAt: T0})).toThrow(
                TypeError,
            );
        }
        expect(() => store.sellers.get("Bad Slug")).toThrow(TypeError);
        expect(store.sellers.list()).toEqual([]);
    });
});

describe("items", () => {
    test("rejects an unknown kind (CHECK) and an unknown seller (FK)", () => {
        const store = open();
        store.sellers.upsert({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});
        const base = {sellerSlug: "cafe", name: "x", priceBase: 1n, createdAt: T0} as const;

        expect(() => store.items.create({...base, kind: "other" as never})).toThrow(/items_kind/);
        expect(() => store.items.create({...base, sellerSlug: "ghost", kind: "hosted"})).toThrow(
            /FOREIGN KEY/,
        );
        expect(() => store.items.create({...base, kind: "hosted", priceBase: -1n})).toThrow(
            RangeError,
        );
        expect(store.items.listBySeller("cafe")).toEqual([]);
    });

    test("listBySeller returns the seller's items in insertion order", () => {
        const store = open();
        store.sellers.upsert({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});
        store.sellers.upsert({slug: "shop", name: "가게", payTo: SHOP, createdAt: T0});
        const latte = store.items.create({
            sellerSlug: "cafe",
            name: "라떼",
            priceBase: 20_000n,
            kind: "hosted",
            createdAt: T0 + HOUR,
        });
        store.items.create({sellerSlug: "shop", name: "다른 가게", priceBase: 1n, kind: "hosted", createdAt: T0});
        const api = store.items.create({
            sellerSlug: "cafe",
            name: "API",
            priceBase: 10_000n,
            kind: "external",
            resourceUrl: "https://builder.example/api",
            createdAt: T0,
        });

        expect(store.items.listBySeller("cafe")).toEqual([latte, api]);
        expect(latte).toEqual({
            id: 1,
            sellerSlug: "cafe",
            name: "라떼",
            priceBase: 20_000n,
            kind: "hosted",
            resourceUrl: null,
            createdAt: T0 + HOUR,
        });
        expect(api.id).toBe(3);
        expect(api.resourceUrl).toBe("https://builder.example/api");
        expect(store.items.listBySeller("nobody")).toEqual([]);
    });
});

describe("orders", () => {
    test("createOnce returns the existing order on a duplicate payment intent", () => {
        const store = open();
        store.sellers.upsert({slug: "cafe", name: "카페", payTo: CAFE, createdAt: T0});
        const item = store.items.create({
            sellerSlug: "cafe",
            name: "라떼",
            priceBase: 20_000n,
            kind: "hosted",
            createdAt: T0,
        });
        const first = store.orders.createOnce({
            itemId: item.id,
            paymentIntentId: INTENT,
            payer: ALICE,
            amountBase: 20_000n,
            txHash: TX,
            status: "settled",
            createdAt: T0,
        });
        expect(first).toEqual({
            id: 1,
            itemId: item.id,
            paymentIntentId: INTENT,
            payer: ALICE,
            amountBase: 20_000n,
            txHash: TX,
            status: "settled",
            createdAt: T0,
        });

        const replay = store.orders.createOnce({
            itemId: item.id,
            paymentIntentId: INTENT,
            payer: BOB,
            amountBase: 1n,
            status: "delivered",
            createdAt: T0 + HOUR,
        });
        expect(replay).toEqual(first);

        const next = store.orders.createOnce({
            itemId: item.id,
            paymentIntentId: OTHER_INTENT,
            payer: BOB,
            amountBase: 20_000n,
            status: "settled",
            createdAt: T0 + HOUR,
        });
        expect(next.id).toBe(2);
        expect(next.txHash).toBeNull();
    });

    test("createOnce rejects an order for an item that does not exist", () => {
        const store = open();
        expect(() =>
            store.orders.createOnce({
                itemId: 99,
                paymentIntentId: INTENT,
                payer: ALICE,
                amountBase: 1n,
                status: "settled",
                createdAt: T0,
            }),
        ).toThrow(/FOREIGN KEY/);
        expect(() =>
            store.orders.createOnce({
                itemId: 0,
                paymentIntentId: INTENT,
                payer: ALICE,
                amountBase: 1n,
                status: "settled",
                createdAt: T0,
            }),
        ).toThrow(TypeError);
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
