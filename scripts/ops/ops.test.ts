import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {backup, restoreDrill} from "./backup";
import {validProbe} from "./check";
import {reconcile} from "./reconcile";
import {openStore} from "../../packages/store/src/index";

test("encrypted snapshot includes WAL commits; drill is isolated and never overwrites existing output", () => {
    const directory = mkdtempSync(join(tmpdir(), "mapae-ops-test-"));
    const source = join(directory, "live.sqlite"), key = join(directory, "key"), archive = join(directory, "backup.enc");
    const db = new Database(source); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO evidence VALUES (1, 'committed');");
    writeFileSync(key, "ab".repeat(32), {mode: 0o600});
    try {
        const result = backup(source, archive, key);
        expect(readFileSync(archive).toString()).not.toContain("committed");
        expect(restoreDrill(archive, key).sha256).toBe(result.sha256);
        expect(() => backup(source, archive, key)).toThrow();
        expect(restoreDrill(archive, key, join(directory, "restored.sqlite")).sha256).toBe(result.sha256);
        expect(() => restoreDrill(archive, key, source)).toThrow();
        expect(db.query("SELECT value FROM evidence").get()).toEqual({value: "committed"});
        const damaged = readFileSync(archive); damaged[damaged.length - 1]! ^= 1; writeFileSync(join(directory, "bad.enc"), damaged);
        expect(() => restoreDrill(join(directory, "bad.enc"), key)).toThrow();
        expect(existsSync(source)).toBe(true);
    } finally {db.close(); rmSync(directory, {recursive: true, force: true});}
});
test("backup rejects a world-readable key and does not create a missing source database", () => {
    const directory = mkdtempSync(join(tmpdir(), "mapae-ops-test-"));
    try {
        const key = join(directory, "key"); writeFileSync(key, "ab".repeat(32), {mode: 0o644});
        expect(() => backup(join(directory, "missing.sqlite"), join(directory, "backup"), key)).toThrow();
        expect(existsSync(join(directory, "missing.sqlite"))).toBe(false);
    } finally {rmSync(directory, {recursive: true, force: true});}
});
test("HTTP 200 with unhealthy body is never green; profile data must remain private", () => {
    expect(validProbe("health", Response.json({}), {ok: false})).toBe(false);
    expect(validProbe("health", Response.json({}), {ok: true})).toBe(true);
    expect(validProbe("health", Response.json({}, {status: 503}), {ok: true})).toBe(false);
    expect(validProbe("profile", Response.json({}), {characters: []})).toBe(false);
    expect(validProbe("profile", Response.json({}, {status: 401}), {error: {code: "login_required"}})).toBe(true);
});
test("store readiness rejects closed or externally write-locked databases", () => {
    const directory = mkdtempSync(join(tmpdir(), "mapae-ops-test-")), file = join(directory, "store.sqlite");
    const store = openStore(file), blocker = new Database(file);
    try {
        store.probe(); blocker.exec("BEGIN IMMEDIATE");
        expect(() => store.probe()).toThrow(); blocker.exec("ROLLBACK");
        store.probe(); store.close(); expect(() => store.probe()).toThrow();
    } finally {store.close(); blocker.close(); rmSync(directory, {recursive: true, force: true});}
}, 10_000);
test("reconciliation flags unresolved journal rows without writing or broadcasting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mapae-ops-test-"));
    const seller = join(directory, "seller.sqlite"), facilitator = join(directory, "facilitator.sqlite");
    openStore(seller).close(); openStore(facilitator).close();
    const db = new Database(facilitator);
    try {
        const before = await reconcile(seller, facilitator); expect(before.ok).toBe(true);
        const tx = `0x${"b".repeat(64)}`, intent = `0x${"a".repeat(64)}`, address = `0x${"1".repeat(40)}`;
        db.query("INSERT INTO settlement_intents (payment_intent_id, tx_hash, signer, chain_id, nonce, gas, max_fee, priority_fee, payer, pay_to, amount_base, budget_day, reserved_wei, created_at) VALUES (?, ?, ?, 91342, 0, '1', '1', '1', ?, ?, '1000000', '2026-10-02', '1', 0)").run(intent, tx, address, address, address);
        const result = await reconcile(seller, facilitator, 900_000, async () => "success");
        expect(result.ok).toBe(false); expect(result.issues).toMatchObject([{code: "pending_over_5m", transaction: tx, chain: "success"}]);
        expect(db.query("SELECT terminal_event_id FROM settlement_intents").get()).toEqual({terminal_event_id: null});
        const cloudFile = join(directory, "cloud.sqlite"), cloud = new Database(cloudFile);
        cloud.exec("CREATE TABLE arcade_checkouts (intent TEXT, admitted INTEGER, updated_at INTEGER)");
        cloud.query("INSERT INTO arcade_checkouts VALUES (?, 0, 0)").run(intent); cloud.close();
        const joined = await reconcile(seller, facilitator, 900_000, undefined, cloudFile);
        expect(joined.profilesChecked).toBe(true); expect(joined.issues.some(v => v.code === "checkout_unresolved")).toBe(true);
    } finally {db.close(); rmSync(directory, {recursive: true, force: true});}
});
