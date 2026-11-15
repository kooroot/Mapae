import {Database} from "bun:sqlite";
import {describe, expect, test} from "bun:test";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Address} from "viem";
import {ARCADE_PAY_TO} from "../packages/arcade/src/tickets";
import {dapReport, liveChainClient, loadFundingFile, parseDapArgs, type ChainClient} from "./dap-report";

const SHOP = "0x00000000000000000000000000000000000000aa";
const acct = (n: number) => `0x${n.toString(16).padStart(40, "a")}`.toLowerCase();
const eoa = (n: number) => `0x${n.toString(16).padStart(40, "e")}`.toLowerCase();
const funder = (n: number) => `0x${n.toString(16).padStart(40, "f")}`.toLowerCase();
/** Unix ms at noon on a Korean day. */
const kst = (day: string) => Date.parse(`${day}T12:00:00+09:00`);

function facilitator(rows: {payer: string; payTo: string; day: string; outcome: "settled" | "rejected" | "error" | null}[]) {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE settlement_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payer TEXT NOT NULL,
                pay_to TEXT NOT NULL, amount_base TEXT NOT NULL, tx_hash TEXT, outcome TEXT NOT NULL, gas_used TEXT, error_code TEXT);
             CREATE TABLE settlement_intents (payment_intent_id TEXT PRIMARY KEY, tx_hash TEXT NOT NULL UNIQUE, payer TEXT NOT NULL,
                pay_to TEXT NOT NULL, chain_id INTEGER NOT NULL, amount_base TEXT NOT NULL, created_at INTEGER NOT NULL,
                terminal_event_id INTEGER REFERENCES settlement_events (id))`);
    rows.forEach((r, i) => {
        const tx = `0x${(i + 1).toString(16).padStart(64, "0")}`;
        let event: number | null = null;
        if (r.outcome) {
            db.query("INSERT INTO settlement_events (id, at, kind, payer, pay_to, amount_base, tx_hash, outcome) VALUES (?,?,?,?,?,?,?,?)")
                .run(i + 1, kst(r.day), "erc7710", r.payer, r.payTo, "1000000", tx, r.outcome);
            event = i + 1;
        }
        db.query("INSERT INTO settlement_intents VALUES (?,?,?,?,?,?,?,?)").run(`pi-${i}`, tx, r.payer, r.payTo, 91342, "1000000", kst(r.day), event);
    });
    return db;
}

const fakeChain = (owners: Record<string, string>, funding: Record<string, {firstFunder: string; firstTxAt: number}>, calls: string[] = []): ChainClient => ({
    async ownerOf(account) {
        calls.push(`owner:${account}`);
        return (owners[account] as Address | undefined) ?? null;
    },
    async firstFunding(owner) {
        calls.push(`funding:${owner}`);
        const f = funding[owner];
        return f ? {firstFunder: f.firstFunder as Address, firstTxAt: f.firstTxAt} : null;
    },
});

describe("dapReport", () => {
    test("only intents whose terminal event is settled count", async () => {
        const db = facilitator([
            {payer: acct(1), payTo: SHOP, day: "2026-10-20", outcome: "settled"},
            {payer: acct(2), payTo: SHOP, day: "2026-10-20", outcome: "rejected"},
            {payer: acct(3), payTo: SHOP, day: "2026-10-20", outcome: "error"},
            {payer: acct(4), payTo: SHOP, day: "2026-10-20", outcome: null},
        ]);
        const report = await dapReport({facilitator: db});
        expect(report.settledPayments).toBe(1);
        expect(report.rows).toEqual([{day: "2026-10-20", raw: 1, excluded: 0, dap: 1, arcadeDap: 0, agentDap: 1, excludedPayers: []}]);
    });

    test("payTo equal to ARCADE_PAY_TO is arcade, anything else agent", async () => {
        const db = facilitator([
            {payer: acct(1), payTo: ARCADE_PAY_TO.toLowerCase(), day: "2026-10-20", outcome: "settled"},
            {payer: acct(2), payTo: SHOP, day: "2026-10-20", outcome: "settled"},
            {payer: acct(3), payTo: ARCADE_PAY_TO, day: "2026-10-20", outcome: "settled"},
        ]);
        const [row] = (await dapReport({facilitator: db})).rows;
        expect(row).toMatchObject({raw: 3, dap: 3, arcadeDap: 2, agentDap: 1});
    });

    test("owners and funding load from a JSON file; a shared funder is excluded", async () => {
        const dir = mkdtempSync(join(tmpdir(), "dap-report-"));
        const file = join(dir, "funding.json");
        const owners = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [acct(n), eoa(n)]));
        const funding = [1, 2, 3, 4].map((n) => ({owner: eoa(n), firstFunder: funder(1), firstTxAt: kst(`2026-10-0${n}`) / 1000}));
        funding.push({owner: eoa(5), firstFunder: funder(2), firstTxAt: kst("2026-10-01") / 1000});
        writeFileSync(file, JSON.stringify({owners, funding}));
        const db = facilitator([1, 2, 3, 4, 5].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const report = await dapReport({facilitator: db, funding: loadFundingFile(file)});
        expect(report.ownerSource).toBe("funding-file");
        expect(report.unresolvedOwners).toBe(0);
        expect(report.rows[0]).toMatchObject({raw: 5, excluded: 4, dap: 1});
        expect(report.rows[0]!.excludedPayers.map((p) => p.owner)).toEqual([1, 2, 3, 4].map(eoa));
        expect(report.rows[0]!.excludedPayers[0]!.reasons).toEqual(["shared-funder"]);

        writeFileSync(file, JSON.stringify(funding));
        expect(loadFundingFile(file).funding).toHaveLength(5);
        writeFileSync(file, JSON.stringify([{owner: "nope", firstFunder: funder(1), firstTxAt: 1}]));
        expect(() => loadFundingFile(file)).toThrow("invalid_funding_file");
    });

    test("funding is built from the chain client; two smart accounts of one owner count once", async () => {
        const calls: string[] = [];
        const chain = fakeChain(
            {[acct(1)]: eoa(1), [acct(2)]: eoa(1), [acct(3)]: eoa(3)},
            {[eoa(1)]: {firstFunder: funder(9), firstTxAt: kst("2026-10-01") / 1000}, [eoa(3)]: {firstFunder: funder(9), firstTxAt: kst("2026-10-01") / 1000}},
            calls,
        );
        const db = facilitator([1, 2, 3].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const report = await dapReport({facilitator: db, chain});
        expect(report.ownerSource).toBe("chain");
        expect(report.fundingFacts).toBe(2);
        expect(calls.filter((c) => c.startsWith("funding:")).sort()).toEqual([`funding:${eoa(1)}`, `funding:${eoa(3)}`]);
        expect(report.rows[0]).toMatchObject({raw: 2, dap: 2});

    });

    test("a funder named in --public-funders (the faucet) does not make its owners a farm", async () => {
        const owners = Object.fromEntries([1, 2, 3, 4].map((n) => [acct(n), eoa(n)]));
        const funding = Object.fromEntries([1, 2, 3, 4].map((n) => [eoa(n), {firstFunder: funder(9), firstTxAt: kst(`2026-10-0${n}`) / 1000}]));
        const db = facilitator([1, 2, 3, 4].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        expect((await dapReport({facilitator: db, chain: fakeChain(owners, funding)})).rows[0]).toMatchObject({raw: 4, excluded: 4, dap: 0});
        const args = parseDapArgs(["fac.sqlite", "--chain", "--public-funders", funder(9)]);
        expect((await dapReport({facilitator: db, chain: fakeChain(owners, funding), publicFunders: args.publicFunders})).rows[0]).toMatchObject({raw: 4, excluded: 0, dap: 4});
    });

    test("--operators are excluded with reason operator", async () => {
        const db = facilitator([1, 2].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const chain = fakeChain({[acct(1)]: eoa(1), [acct(2)]: eoa(2)}, {});
        const args = parseDapArgs(["fac.sqlite", "--chain", "--operators", `${eoa(2).toUpperCase().replace("0X", "0x")}`]);
        const report = await dapReport({facilitator: db, chain, operators: args.operators});
        expect(report.rows[0]).toMatchObject({raw: 2, excluded: 1, dap: 1, excludedPayers: [{owner: eoa(2), reasons: ["operator"]}]});
        await expect(dapReport({facilitator: db, operators: ["0xnot"]})).rejects.toThrow("invalid_operator");
    });

    test("--from and --to keep only Korean days inside the window", async () => {
        const db = facilitator(
            ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].map((day, n) => ({payer: acct(n + 1), payTo: SHOP, day, outcome: "settled" as const})),
        );
        // 23:30 UTC on the 19th is the 20th in Korea.
        db.query("UPDATE settlement_events SET at = ? WHERE id = 1").run(Date.parse("2026-10-19T23:30:00Z"));
        const args = parseDapArgs(["fac.sqlite", "--from", "2026-10-20", "--to", "2026-10-21"]);
        const report = await dapReport({facilitator: db, from: args.from, to: args.to});
        expect(report.rows.map((r) => [r.day, r.raw])).toEqual([["2026-10-20", 2], ["2026-10-21", 1]]);
        await expect(dapReport({facilitator: db, from: "20-10-2026"})).rejects.toThrow("invalid_day");
    });

    test("an unresolved owner stays the payer and is flagged ownerResolved:false", async () => {
        const db = facilitator([1, 2].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const chain = fakeChain({[acct(1)]: eoa(1)}, {});
        chain.ownerOf = async (a) => (a === acct(1) ? (eoa(1) as Address) : Promise.reject(new Error("rpc down")));
        const report = await dapReport({facilitator: db, chain});
        expect(report.unresolvedOwners).toBe(1);
        expect(report.payers).toEqual([
            {payer: acct(1), owner: eoa(1), ownerResolved: true},
            {payer: acct(2), owner: acct(2), ownerResolved: false},
        ]);
        expect(report.rows[0]).toMatchObject({raw: 2, dap: 2});
    });

    test("a zero-address owner is unresolved: renounced accounts keep their own identities", async () => {
        const zero = "0x0000000000000000000000000000000000000000";
        const db = facilitator([1, 2, 3].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const chain = fakeChain({[acct(1)]: zero, [acct(2)]: zero, [acct(3)]: eoa(3)}, {});
        const report = await dapReport({facilitator: db, chain});
        expect(report.payers).toEqual([
            {payer: acct(1), owner: acct(1), ownerResolved: false},
            {payer: acct(2), owner: acct(2), ownerResolved: false},
            {payer: acct(3), owner: eoa(3), ownerResolved: true},
        ]);
        expect(report.rows[0]).toMatchObject({raw: 3, dap: 3});
        const fromFile = await dapReport({facilitator: db, funding: {owners: {[acct(1)]: zero, [acct(2)]: zero}}});
        expect(fromFile.unresolvedOwners).toBe(3);
        expect(fromFile.rows[0]).toMatchObject({raw: 3, dap: 3});
    });

    test("live client: a reverted incoming transfer is not the first funder", async () => {
        const owner = eoa(1) as Address;
        const txs = [
            {from: "0x2222222222222222222222222222222222222222", to: owner, value: "1000", timeStamp: "100", isError: "1", txreceipt_status: "0"},
            {from: "0x4444444444444444444444444444444444444444", to: owner, value: "1000", timeStamp: "150", isError: "0", txreceipt_status: "0"},
            {from: "0x3333333333333333333333333333333333333333", to: owner, value: "1000", timeStamp: "200", isError: "0", txreceipt_status: "1"},
        ];
        const urls: string[] = [];
        const fetcher = (async (url: string) => {
            urls.push(url);
            return new Response(JSON.stringify({result: txs}));
        }) as unknown as typeof fetch;
        expect(await liveChainClient(fetcher).firstFunding(owner)).toEqual({firstFunder: "0x3333333333333333333333333333333333333333", firstTxAt: 100});
        expect(urls[0]).toContain(`address=${owner}`);
        txs.pop();
        expect(await liveChainClient(fetcher).firstFunding(owner)).toBeNull();
    });

    test("seller orders cross-check counts settlements with no order", async () => {
        const db = facilitator([1, 2].map((n) => ({payer: acct(n), payTo: SHOP, day: "2026-10-20", outcome: "settled" as const})));
        const seller = new Database(":memory:");
        seller.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, payment_intent_id TEXT, payer TEXT, amount_base TEXT, tx_hash TEXT, status TEXT, created_at INTEGER)");
        seller.query("INSERT INTO orders (payment_intent_id, tx_hash, status) VALUES ('pi-0', ?, 'paid')").run(`0x${"1".padStart(64, "0")}`);
        expect((await dapReport({facilitator: db, seller})).seller).toEqual({settledWithoutOrder: 1});
    });

    test("CLI arguments: one database, --funding and --chain are exclusive", () => {
        expect(parseDapArgs(["fac.sqlite", "--seller", "s.sqlite", "--funding", "f.json"])).toMatchObject({facilitatorDb: "fac.sqlite", sellerDb: "s.sqlite", fundingFile: "f.json", chain: false});
        expect(() => parseDapArgs([])).toThrow("facilitator_db_required");
        expect(() => parseDapArgs(["fac.sqlite", "--funding", "f.json", "--chain"])).toThrow("funding_or_chain");
    });
});
