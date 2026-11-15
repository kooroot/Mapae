/**
 * Incremental on-chain indexer for the three events the metrics are built from, kept in
 * the collector's own sqlite file — never in a service's store.
 *
 * Idempotency is structural: every row is keyed by `(tx_hash, log_index)` and inserted
 * with `OR IGNORE`, and the cursor advances in the same transaction as the rows of the
 * chunk it covers. A run that dies mid-way resumes at the first chunk not committed; a
 * run that is repeated over a committed range writes nothing twice.
 */
import {Database} from "bun:sqlite";
import {ROOT_AUTHORITY} from "@mapae/delegation/delegation-status";
import {decodeEventLog, erc20Abi, getAddress, isAddress, type Address, type Hex} from "viem";
import type {ChainEvents} from "./metrics";

/**
 * Bumped whenever the tables below change shape. A file at another version is dropped and
 * re-indexed from the start block rather than migrated: every row is derived from the
 * chain, so a rebuild loses nothing and a migration would only be a second way to be wrong.
 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_block INTEGER NOT NULL,
    next_block INTEGER NOT NULL
);
CREATE TABLE chain_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('redemption', 'revocation', 'deployment')),
    block_number INTEGER NOT NULL,
    at INTEGER NOT NULL,
    subject TEXT NOT NULL,
    pay_to TEXT,
    tx_from TEXT NOT NULL,
    redeemer TEXT,
    PRIMARY KEY (tx_hash, log_index),
    CHECK ((kind = 'redemption') = (redeemer IS NOT NULL))
);
`;

export interface Head {
    number: bigint;
    hash: Hex;
    timestamp: bigint;
}

export interface RawLink {
    transactionHash: Hex;
    logIndex: number;
    blockNumber: bigint;
}
export interface RedeemedLink extends RawLink {
    rootDelegator: Address;
    redeemer: Address;
    authority: Hex;
}
export interface DisabledLink extends RawLink {
    delegator: Address;
}
export interface DeployedLink extends RawLink {
    account: Address;
}
export interface ReceiptLog {
    address: Address;
    topics: readonly Hex[];
    data: Hex;
}
export interface Receipt {
    from: Address;
    blockNumber: bigint;
    logs: readonly ReceiptLog[];
}

/**
 * The chain as the indexer needs it. `viem-source.ts` adapts a viem client; tests fake it.
 * Kept at this level — decoded event fields rather than raw `getLogs` — so a fake cannot
 * drift from viem's generic overloads and the decode lives in exactly one adapter.
 */
export interface ChainSource {
    finalizedHead(): Promise<Head>;
    blockTimestamp(block: bigint): Promise<bigint>;
    receipt(hash: Hex): Promise<Receipt>;
    redeemed(fromBlock: bigint, toBlock: bigint): Promise<RedeemedLink[]>;
    disabled(fromBlock: bigint, toBlock: bigint): Promise<DisabledLink[]>;
    deployed(fromBlock: bigint, toBlock: bigint): Promise<DeployedLink[]>;
}

export function openMetricsDb(path: string): Database {
    const db = new Database(path, {create: true});
    const {user_version: version} = db.query<{user_version: number}, []>("PRAGMA user_version").get()!;
    if (version !== SCHEMA_VERSION) {
        db.exec("DROP TABLE IF EXISTS cursor; DROP TABLE IF EXISTS chain_events;");
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return db;
}

/**
 * The payee of one redemption: the recipient of the token transfer out of the payer.
 *
 * `RedeemedDelegation` names the payer and the redeemer but not the recipient — that sits
 * in the execution calldata — so the receipt's own `Transfer` log is the authority. Any
 * ERC-20 counts, not only MockUSDC: the question is who was paid, not in what.
 */
export function payeeFromReceipt(receipt: Receipt, payer: Address): Address | null {
    for (const log of receipt.logs) {
        try {
            const decoded = decodeEventLog({abi: erc20Abi, eventName: "Transfer", topics: log.topics as [Hex, ...Hex[]], data: log.data});
            if (getAddress(decoded.args.from) === getAddress(payer)) return getAddress(decoded.args.to);
        } catch {
            // Not a Transfer, or an ERC-721 Transfer whose indexed layout does not decode.
        }
    }
    return null;
}

type Row = [txHash: string, logIndex: number, kind: string, block: number, at: number, subject: string, payTo: string | null, txFrom: string, redeemer: string | null];

export interface IndexResult {
    fromBlock: bigint;
    head: Head;
    chunks: number;
    inserted: number;
}

/**
 * Index up to the finalized head. `startBlock` is asked for only on the very first run —
 * the Framework's deployment block — and pinned in the cursor row from then on.
 *
 * Only root links are kept: every payment re-emits its root beside its leaf, so counting
 * all links would double every payment. Every root is kept whoever redeemed it, with the
 * redeemer beside it. Which of them is a Mapae settlement is decided when the rows are
 * read ({@link readChainEvents}); dropping the others here would also drop the only
 * redemptions the payer-gas metric exists to find.
 *
 * `span` is the most blocks one `eth_getLogs` call may cover, both ends included. It is
 * the endpoint's limit, not the chain's, which is why the caller supplies it.
 */
export async function indexChain(db: Database, source: ChainSource, startBlock: () => Promise<bigint>, span: bigint): Promise<IndexResult> {
    const head = await source.finalizedHead();
    let cursor = db.query<{start_block: number; next_block: number}, []>("SELECT start_block, next_block FROM cursor WHERE id = 1").get();
    if (!cursor) {
        const start = await startBlock();
        db.query("INSERT INTO cursor (id, start_block, next_block) VALUES (1, ?, ?)").run(Number(start), Number(start));
        cursor = {start_block: Number(start), next_block: Number(start)};
    }
    const insert = db.query("INSERT OR IGNORE INTO chain_events (tx_hash, log_index, kind, block_number, at, subject, pay_to, tx_from, redeemer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const advance = db.query("UPDATE cursor SET next_block = ? WHERE id = 1");

    let inserted = 0;
    let chunks = 0;
    for (let from = BigInt(cursor.next_block); from <= head.number; from += span) {
        const to = from + span - 1n < head.number ? from + span - 1n : head.number;
        const [redeemed, disabled, deployed] = await Promise.all([source.redeemed(from, to), source.disabled(from, to), source.deployed(from, to)]);
        const times = new Map<bigint, number>();
        const at = async (block: bigint) => {
            if (!times.has(block)) times.set(block, Number(await source.blockTimestamp(block)) * 1000);
            return times.get(block)!;
        };
        const receipts = new Map<Hex, Receipt>();
        const receipt = async (hash: Hex) => {
            if (!receipts.has(hash)) receipts.set(hash, await source.receipt(hash));
            return receipts.get(hash)!;
        };

        const rows: Row[] = [];
        for (const link of redeemed) {
            if (link.authority.toLowerCase() !== ROOT_AUTHORITY) continue;
            const r = await receipt(link.transactionHash);
            const payTo = payeeFromReceipt(r, link.rootDelegator);
            rows.push([link.transactionHash, link.logIndex, "redemption", Number(link.blockNumber), await at(link.blockNumber),
                link.rootDelegator.toLowerCase(), payTo?.toLowerCase() ?? null, r.from.toLowerCase(), link.redeemer.toLowerCase()]);
        }
        for (const link of disabled) {
            const r = await receipt(link.transactionHash);
            rows.push([link.transactionHash, link.logIndex, "revocation", Number(link.blockNumber), await at(link.blockNumber),
                link.delegator.toLowerCase(), null, r.from.toLowerCase(), null]);
        }
        for (const link of deployed) {
            const r = await receipt(link.transactionHash);
            rows.push([link.transactionHash, link.logIndex, "deployment", Number(link.blockNumber), await at(link.blockNumber),
                link.account.toLowerCase(), null, r.from.toLowerCase(), null]);
        }
        db.transaction(() => {
            for (const row of rows) inserted += insert.run(...row).changes;
            advance.run(Number(to + 1n));
        })();
        chunks++;
    }
    return {fromBlock: BigInt(cursor.start_block), head, chunks, inserted};
}

/**
 * A root redemption is a Mapae settlement when the settlement signer redeemed it; a
 * redeemer other than our signer is somebody else's facilitator, or the payer's own side,
 * on the same DelegationManager. Those are handed over apart, as `foreignRedemptions`, so
 * no settlement figure can count one.
 */
export function readChainEvents(db: Database, signer: Address): ChainEvents {
    const rows = db.query<{kind: string; at: number; subject: string; pay_to: string | null; tx_from: string; redeemer: string | null}, []>(
        "SELECT kind, at, subject, pay_to, tx_from, redeemer FROM chain_events ORDER BY block_number, log_index").all();
    const signerKey = signer.toLowerCase();
    const events: {[K in keyof ChainEvents]: ChainEvents[K][number][]} = {settlements: [], foreignRedemptions: [], revocations: [], deployments: []};
    for (const row of rows) {
        if (!isAddress(row.subject)) throw new Error("metrics db holds a malformed address");
        if (row.kind === "redemption") {
            const redemption = {payer: row.subject, payTo: row.pay_to, txFrom: row.tx_from, at: row.at};
            (row.redeemer === signerKey ? events.settlements : events.foreignRedemptions).push(redemption);
        } else if (row.kind === "revocation") events.revocations.push({delegator: row.subject, at: row.at});
        else events.deployments.push({account: row.subject, txFrom: row.tx_from, at: row.at});
    }
    return events;
}
