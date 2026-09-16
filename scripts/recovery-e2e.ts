import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
const dir = mkdtempSync(join(tmpdir(), "mapae-recovery-"));
const reserve = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response()});
const port = reserve.port!;
reserve.stop(true);
const node = Bun.spawn(["anvil", "--host", "127.0.0.1", "--port", String(port), "--silent"], {stdout: "ignore", stderr: "pipe"});
let worker: ReturnType<typeof Bun.spawn> | undefined;
let mode: "normal" | "block-send" | "lose-answer" | "hide-receipt" = "normal";
let sendSeen = false;
const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
    const json = await response.json() as {result?: unknown; error?: unknown};
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
};
const proxy = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as {id: number; method: string; params: unknown[]};
    const fail = () => Response.json({jsonrpc: "2.0", id: body.id, error: {code: -32000, message: "injected outage"}});
    if (body.method === "eth_sendRawTransaction") {
        sendSeen = true;
        if (mode === "block-send") return fail();
    }
    if (body.method === "eth_getTransactionReceipt" && mode === "hide-receipt") {
        return Response.json({jsonrpc: "2.0", id: body.id, result: null});
    }
    const response = await fetch(`http://127.0.0.1:${port}`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
    if (body.method === "eth_sendRawTransaction" && mode === "lose-answer") return fail();
    return new Response(await response.text(), {headers: {"content-type": "application/json"}});
}});
const dbPath = join(dir, "state.sqlite");
const beforeMidnight = Date.parse("2026-09-13T23:59:00Z");
async function start(now = beforeMidnight) {
    worker = Bun.spawn([process.execPath, "apps/facilitator-erc7710/e2e-worker.ts"], {
        env: {PATH: process.env.PATH, RECOVERY_RPC: `http://127.0.0.1:${proxy.port}`, RECOVERY_DB: dbPath, RECOVERY_NOW: String(now)},
        stdout: "pipe", stderr: "ignore",
    });
    const reader = (worker.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await Promise.race([reader.read(), Bun.sleep(10000).then(() => {throw new Error("worker start timeout");})]);
    const match = new TextDecoder().decode(ready.value).match(/READY (\d+)/);
    assert(match, "worker must announce HTTP port");
    reader.releaseLock();
    return `http://127.0.0.1:${match[1]}/settle`;
}
async function stop() {worker?.kill("SIGKILL"); await worker?.exited; worker = undefined;}
const body = (n: number, to = "0x0000000000000000000000000000000000001234") => ({id: `0x${n.toString(16).padStart(64, "0")}`, to});
const post = async (url: string, value: ReturnType<typeof body>) => (await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(value)})).json() as Promise<{success: boolean; transaction: string; errorReason?: string}>;
async function until(check: () => Promise<boolean>) {
    for (let n = 0; n < 100; n++) {if (await check()) return; await Bun.sleep(30);}
    throw new Error("condition timeout");
}
try {
    await until(async () => {try {return await rpc("eth_chainId") === "0x7a69";} catch {return false;}});
    let url = await start();
    mode = "block-send";
    const interrupted = post(url, body(1)).catch(() => null);
    await until(async () => sendSeen);
    await stop(); await interrupted;
    assert.equal(await rpc("eth_getBalance", [body(1).to, "latest"]), "0x0");
    mode = "normal";
    url = await start(beforeMidnight + 120000);
    const recovered = await post(url, body(1));
    assert.equal(recovered.success, true);
    assert.equal(await rpc("eth_getBalance", [body(1).to, "latest"]), "0x7b");
    assert.deepEqual(await post(url, body(1)), recovered);
    mode = "lose-answer";
    assert.equal((await post(url, body(2))).success, true);
    mode = "hide-receipt";
    const unknown = await post(url, body(3));
    assert.equal(unknown.success, false);
    assert.equal(unknown.errorReason, "settlement_unconfirmed");
    await stop(); mode = "normal"; url = await start(beforeMidnight + 120000);
    const found = await post(url, body(3));
    assert.equal(found.success, true); assert.equal(found.transaction, unknown.transaction);
    const duplicate = await Promise.all(Array.from({length: 8}, () => post(url, body(4))));
    assert(duplicate.every(r => r.success && r.transaction === duplicate[0]!.transaction));
    const distinct = await Promise.all([post(url, body(5)), post(url, body(6))]);
    assert(distinct.every(r => r.success)); assert.notEqual(distinct[0]!.transaction, distinct[1]!.transaction);
    const revertTo = "0x0000000000000000000000000000000000005678";
    await rpc("anvil_setCode", [revertTo, "0x60006000fd"]);
    const reverted = await post(url, body(7, revertTo));
    assert.equal(reverted.errorReason, "settlement_reverted"); assert(reverted.transaction);
    assert.deepEqual(await post(url, body(7, revertTo)), reverted);
    assert.equal(BigInt(await rpc("eth_getBalance", [body(1).to, "latest"]) as string), 6n * 123n);
    const db = new Database(dbPath, {readonly: true});
    const rows = db.query<{nonce: number; actual_cost: string; budget_day: string}, []>("SELECT nonce, actual_cost, budget_day FROM settlement_intents ORDER BY nonce").all();
    assert.deepEqual(rows.map(r => r.nonce), [0, 1, 2, 3, 4, 5, 6]);
    assert(rows.every(r => BigInt(r.actual_cost) > 0n));
    assert.equal(rows[0]!.budget_day, "2026-09-13");
    const costs = db.query<{day: string; spent_wei: string}, []>("SELECT day, spent_wei FROM budget_days WHERE scope = 'total'").all();
    for (const day of costs) assert.equal(BigInt(day.spent_wei), rows.filter(r => r.budget_day === day.day).reduce((n, r) => n + BigInt(r.actual_cost), 0n));
    assert.equal(db.query<{n: number}, []>("SELECT COUNT(*) AS n FROM settlement_events").get()!.n, 7);
    assert.equal(db.query<{n: number}, []>("SELECT COUNT(*) AS n FROM settlement_events WHERE outcome = 'error' AND gas_used IS NOT NULL AND tx_hash IS NOT NULL").get()!.n, 1);
    db.close();
    console.log("recovery E2E PASS: process kill, lost answer, delayed receipt, restart, concurrency, revert, balances and durable accounting");
} finally {
    await stop(); proxy.stop(true); node.kill(); await node.exited; rmSync(dir, {recursive: true, force: true});
}
