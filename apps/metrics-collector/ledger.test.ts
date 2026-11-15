import {afterEach, beforeEach, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SCHEMA_SQL} from "@mapae/store/schema";
import {internalPayees, ledgerDaily, ledgerInvariants} from "./ledger";
import {kstDayStart} from "./metrics";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const LIMIT = 1_000n;
let dir: string, seller: string, facilitator: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metrics-ledger-"));
    seller = join(dir, "seller.sqlite");
    facilitator = join(dir, "facilitator.sqlite");
    for (const path of [seller, facilitator]) {
        const db = new Database(path, {create: true});
        db.exec(SCHEMA_SQL);
        db.close();
    }
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const PAYER = `0x${"1".repeat(40)}`, PAY_TO = `0x${"2".repeat(40)}`;

function write(path: string, run: (db: Database) => void) {
    const db = new Database(path);
    run(db);
    db.close();
}

function event(db: Database, id: number, at: number, outcome: string, errorCode: string | null = null) {
    db.query("INSERT INTO settlement_events (id, at, kind, payer, pay_to, amount_base, tx_hash, outcome, error_code) VALUES (?, ?, 'settle', ?, ?, '1000000', ?, ?, ?)")
        .run(id, at, PAYER, PAY_TO, hash(id), outcome, errorCode);
}

function intent(db: Database, n: number, createdAt: number, terminal: number | null) {
    db.query(`INSERT INTO settlement_intents (payment_intent_id, tx_hash, signer, chain_id, nonce, gas, max_fee, priority_fee, payer, pay_to,
              amount_base, budget_day, reserved_wei, created_at, terminal_event_id) VALUES (?, ?, ?, 91342, ?, '1', '1', '1', ?, ?, '1000000', '2026-10-12', '1', ?, ?)`)
        .run(`intent-${n}`, hash(n), PAY_TO, n, PAYER, PAY_TO, createdAt, terminal);
}

function order(db: Database, n: number) {
    db.query("INSERT INTO sellers (slug, kind, name, pay_to, created_at) VALUES ('shop', 'hosted', 'Shop', ?, 0) ON CONFLICT DO NOTHING").run(PAY_TO);
    db.query("INSERT INTO items (seller_slug, key, name, description, price_base, created_at) VALUES ('shop', 'item', 'Item', '', '1000000', 0) ON CONFLICT DO NOTHING").run();
    db.query("INSERT INTO orders (seller_slug, item_key, payment_intent_id, ticket, payer, amount_base, tx_hash, status, created_at) VALUES ('shop', 'item', ?, ?, ?, '1000000', ?, 'paid', 0)")
        .run(`intent-${n}`, `TICKET${n}`, PAYER, hash(n));
}

const byName = (items: {name: string; ok: boolean; detail?: string}[]) => Object.fromEntries(items.map(i => [i.name, i]));

test("a clean ledger passes every invariant", async () => {
    write(facilitator, db => {
        event(db, 1, NOW - 60_000, "settled");
        intent(db, 1, NOW - 61_000, 1);
        db.query("INSERT INTO budget_days (scope, day, spent_wei) VALUES ('total', '2026-10-12', '100')").run();
    });
    write(seller, db => order(db, 1));
    const items = byName(await ledgerInvariants({seller, facilitator}, NOW, LIMIT));
    for (const name of ["pending-intents", "settled-without-order", "order-settlement-mismatch", "settlement-errors-24h", "relayer-budget"]) expect(items[name]!.ok).toBe(true);
    expect(items["relayer-budget"]!.detail).toBe("90% of today's relayer gas budget left");
    expect(items["pending-intents"]!.detail).toBeUndefined();
});

test("pending intents, orphaned settlements, recent errors and a spent budget each fail by name", async () => {
    write(facilitator, db => {
        event(db, 1, NOW - 60_000, "settled");
        intent(db, 1, NOW - 61_000, 1);              // settled, no seller order
        intent(db, 2, NOW - 301_000, null);          // pending past five minutes
        intent(db, 3, NOW - 299_000, null);          // pending, still young
        event(db, 4, NOW - 3_600_000, "error", "TransactionReverted");
        event(db, 5, NOW - 90_000_000, "error", "TransactionReverted"); // older than 24h
        db.query("INSERT INTO budget_days (scope, day, spent_wei) VALUES ('total', '2026-10-12', '950')").run();
    });
    const items = byName(await ledgerInvariants({seller, facilitator}, NOW, LIMIT));
    expect(items["pending-intents"]).toEqual({name: "pending-intents", ok: false, detail: "1 intent pending over 5m"});
    expect(items["settled-without-order"]).toEqual({name: "settled-without-order", ok: false, detail: "1 settled intent without a seller order"});
    expect(items["settlement-errors-24h"]).toEqual({name: "settlement-errors-24h", ok: false, detail: "1 broadcast ended in error in 24h"});
    expect(items["relayer-budget"]!.ok).toBe(false);
});

test("the stores are opened read-only: a missing file is an error, never a new empty ledger", async () => {
    await expect(ledgerInvariants({seller, facilitator: join(dir, "absent.sqlite")}, NOW, LIMIT)).rejects.toThrow();
    expect(() => ledgerDaily(join(dir, "absent.sqlite"), {startMs: 0, endMs: NOW})).toThrow();
});

test("daily ledger: success rate over broadcasts only, failure reasons, latency percentiles", () => {
    const start = kstDayStart("2026-10-12");
    write(facilitator, db => {
        event(db, 1, start + 10_000, "settled"); intent(db, 1, start + 8_000, 1);   // 2s
        event(db, 2, start + 20_000, "settled"); intent(db, 2, start + 16_000, 2);  // 4s
        event(db, 3, start + 30_000, "error", "TransactionReverted");
        event(db, 4, start + 40_000, "rejected", "InvalidSignature");
        event(db, 5, start + 50_000, "rejected", "InvalidSignature");
        event(db, 6, start - 1, "settled");                                          // previous KST day
    });
    expect(ledgerDaily(facilitator, {startMs: start, endMs: start + 86_400_000})).toEqual({
        settled: 2, error: 1, rejected: 2,
        broadcastSuccessRate: 2 / 3,
        failureReasons: {"error:TransactionReverted": 1, "rejected:InvalidSignature": 2},
        latencyMs: {n: 2, p50: 2_000, p95: 4_000},
    });
    expect(ledgerDaily(facilitator, {startMs: 0, endMs: 1}).broadcastSuccessRate).toBeNull();
});

test("the seller's own internal shops are internal payees", () => {
    write(seller, db => {
        db.query("INSERT INTO sellers (slug, kind, name, pay_to, internal, created_at) VALUES ('ours', 'hosted', 'Ours', ?, 1, 0)").run(PAY_TO);
        db.query("INSERT INTO sellers (slug, kind, name, pay_to, internal, created_at) VALUES ('theirs', 'hosted', 'Theirs', ?, 0, 0)").run(PAYER);
    });
    expect(internalPayees(seller)).toEqual([PAY_TO]);
});
