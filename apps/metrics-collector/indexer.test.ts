import {Database} from "bun:sqlite";
import {expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ROOT_AUTHORITY} from "@mapae/delegation/delegation-status";
import {encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex} from "viem";
import {indexChain, openMetricsDb, payeeFromReceipt, readChainEvents, type ChainSource, type Receipt} from "./indexer";

const SIGNER = getAddress("0x5ea109edc7e89b6a752032aa2b6f1092e081e7ec");
const OTHER_REDEEMER = getAddress(`0x${"7".repeat(40)}`);
const SPONSOR = getAddress(`0x${"5".repeat(40)}`);
const PAYER = getAddress(`0x${"1".repeat(40)}`);
const PAY_TO = getAddress(`0x${"2".repeat(40)}`);
const TOKEN = getAddress(`0x${"3".repeat(40)}`);
const LEAF_AUTHORITY = keccak256(toHex("parent"));
const SPAN = 100_000n;
const tx = (n: number): Hex => keccak256(toHex(`tx-${n}`));

function transferLog(from: Address, to: Address, value: bigint) {
    return {
        address: TOKEN,
        topics: encodeEventTopics({abi: erc20Abi, eventName: "Transfer", args: {from, to}}).filter((t): t is Hex => typeof t === "string"),
        data: encodeAbiParameters([{type: "uint256"}], [value]),
    };
}

/** A chain of 250_001 blocks with one payment (leaf + root), one foreign redemption, one revocation, one deployment. */
function fakeChain(head = 250_000n) {
    const calls: [bigint, bigint][] = [];
    let receiptCalls = 0;
    const receipts = new Map<Hex, Receipt>([
        [tx(1), {from: SIGNER, blockNumber: 120_000n, logs: [{address: TOKEN, topics: [keccak256(toHex("Other(uint256)"))], data: "0x"}, transferLog(PAYER, PAY_TO, 1_000_000n)]}],
        [tx(2), {from: OTHER_REDEEMER, blockNumber: 130_000n, logs: [transferLog(PAYER, PAY_TO, 1n)]}],
        [tx(3), {from: PAYER, blockNumber: 200_000n, logs: []}],
        [tx(4), {from: SPONSOR, blockNumber: 50_000n, logs: []}],
        [tx(0), {from: SIGNER, blockNumber: 10n, logs: []}],
    ]);
    const inRange = <T extends {blockNumber: bigint}>(rows: T[], from: bigint, to: bigint) => rows.filter(r => r.blockNumber >= from && r.blockNumber <= to);
    const source: ChainSource = {
        finalizedHead: async () => ({number: head, hash: keccak256(toHex("head")), timestamp: 1_760_000_000n}),
        blockTimestamp: async block => 1_759_000_000n + block,
        receipt: async hash => {
            receiptCalls++;
            const r = receipts.get(hash);
            if (!r) throw new Error("unknown tx");
            return r;
        },
        redeemed: async (from, to) => {
            calls.push([from, to]);
            return inRange([
                {transactionHash: tx(1), logIndex: 4, blockNumber: 120_000n, rootDelegator: PAYER, redeemer: SIGNER, authority: LEAF_AUTHORITY},
                {transactionHash: tx(1), logIndex: 5, blockNumber: 120_000n, rootDelegator: PAYER, redeemer: SIGNER, authority: ROOT_AUTHORITY},
                {transactionHash: tx(2), logIndex: 0, blockNumber: 130_000n, rootDelegator: PAYER, redeemer: OTHER_REDEEMER, authority: ROOT_AUTHORITY},
            ], from, to);
        },
        disabled: async (from, to) => inRange([{transactionHash: tx(3), logIndex: 1, blockNumber: 200_000n, delegator: PAYER}], from, to),
        deployed: async (from, to) => inRange([{transactionHash: tx(4), logIndex: 0, blockNumber: 50_000n, account: PAYER}], from, to),
    };
    return {source, calls, receiptCalls: () => receiptCalls};
}

test("chunks never exceed the given getLogs span and cover the range exactly", async () => {
    const db = openMetricsDb(":memory:");
    const chain = fakeChain();
    const result = await indexChain(db, chain.source, async () => 10n, SPAN);
    expect(result.chunks).toBe(3);
    for (const [from, to] of chain.calls) expect(to - from + 1n).toBeLessThanOrEqual(SPAN);
    expect(chain.calls).toEqual([[10n, 100_009n], [100_010n, 200_009n], [200_010n, 250_000n]]);
});

test("only root links redeemed by our signer become settlements; another redeemer's root is kept apart", async () => {
    const db = openMetricsDb(":memory:");
    await indexChain(db, fakeChain().source, async () => 0n, SPAN);
    const events = readChainEvents(db, SIGNER);
    expect(events.settlements).toEqual([{payer: PAYER.toLowerCase(), payTo: PAY_TO.toLowerCase(), txFrom: SIGNER.toLowerCase(), at: (1_759_000_000 + 120_000) * 1000}]);
    expect(events.foreignRedemptions).toEqual([{payer: PAYER.toLowerCase(), payTo: PAY_TO.toLowerCase(), txFrom: OTHER_REDEEMER.toLowerCase(), at: (1_759_000_000 + 130_000) * 1000}]);
    expect(db.query<{redeemer: string | null}, []>("SELECT redeemer FROM chain_events ORDER BY block_number").all().map(r => r.redeemer))
        .toEqual([null, SIGNER.toLowerCase(), OTHER_REDEEMER.toLowerCase(), null]);
    // Which redemptions are ours is decided on read, by whichever signer is asked about.
    expect(readChainEvents(db, OTHER_REDEEMER).settlements.map(s => s.txFrom)).toEqual([OTHER_REDEEMER.toLowerCase()]);
    expect(events.revocations).toEqual([{delegator: PAYER.toLowerCase(), at: (1_759_000_000 + 200_000) * 1000}]);
    expect(events.deployments).toEqual([{account: PAYER.toLowerCase(), txFrom: SPONSOR.toLowerCase(), at: (1_759_000_000 + 50_000) * 1000}]);
});

test("re-running is idempotent: the cursor resumes, and a replayed range inserts nothing", async () => {
    const db = openMetricsDb(":memory:");
    let starts = 0;
    const start = async () => (starts++, 0n);
    const first = await indexChain(db, fakeChain(150_000n).source, start, SPAN);
    expect(first.inserted).toBe(3); // the two redemptions at 120k and 130k and the deployment at 50k
    const second = await indexChain(db, fakeChain().source, start, SPAN);
    expect(second.inserted).toBe(1); // only the revocation at 200k is new
    expect(starts).toBe(1);
    expect(second.fromBlock).toBe(0n);

    // Rewind the cursor as a crash between fetch and commit would leave it: nothing doubles.
    db.query("UPDATE cursor SET next_block = 0").run();
    const replay = await indexChain(db, fakeChain().source, start, SPAN);
    expect(replay.inserted).toBe(0);
    expect(db.query<{n: number}, []>("SELECT COUNT(*) AS n FROM chain_events").get()!.n).toBe(4);

    // At the head already: no chunk, no receipt fetched.
    const idle = fakeChain();
    expect((await indexChain(db, idle.source, start, SPAN)).chunks).toBe(0);
    expect(idle.receiptCalls()).toBe(0);
});

test("a metrics file from an older schema is rebuilt from the start block, and a current one is kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-db-"));
    try {
        const path = join(dir, "metrics.sqlite");
        const old = new Database(path, {create: true});
        old.exec("CREATE TABLE cursor (id INTEGER PRIMARY KEY, start_block INTEGER NOT NULL, next_block INTEGER NOT NULL); INSERT INTO cursor VALUES (1, 0, 250001);"
            + "CREATE TABLE chain_events (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, kind TEXT NOT NULL, block_number INTEGER NOT NULL, at INTEGER NOT NULL, subject TEXT NOT NULL, pay_to TEXT, tx_from TEXT NOT NULL, PRIMARY KEY (tx_hash, log_index));");
        old.close();

        const rebuilt = openMetricsDb(path);
        expect((await indexChain(rebuilt, fakeChain().source, async () => 0n, SPAN)).inserted).toBe(4);
        rebuilt.close();

        const kept = openMetricsDb(path);
        expect(kept.query<{n: number}, []>("SELECT COUNT(*) AS n FROM chain_events").get()!.n).toBe(4);
        expect((await indexChain(kept, fakeChain().source, async () => 0n, SPAN)).chunks).toBe(0);
        kept.close();
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test("the payee is the recipient of a transfer out of the payer, or nothing", () => {
    const receipt: Receipt = {from: SIGNER, blockNumber: 1n, logs: [transferLog(PAY_TO, PAYER, 5n), transferLog(PAYER, PAY_TO, 7n)]};
    expect(payeeFromReceipt(receipt, PAYER)).toBe(PAY_TO);
    expect(payeeFromReceipt({...receipt, logs: [transferLog(PAY_TO, PAYER, 5n)]}, PAYER)).toBeNull();
});
