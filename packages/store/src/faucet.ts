import {Database} from "bun:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";

/**
 * The faucet's claim ledger: its own file and schema, like the arcade's admissions.
 *
 * The main store refuses any `user_version` but its own, and a bump would force every
 * seller and facilitator operator to move their store aside for a table they never use.
 *
 * A claim walks `reserved → signed → sent → confirmed`, or ends `failed` or `skipped`.
 * Each step is written before the action it names can be observed by anyone else, so a
 * crash at any point leaves a row the reconciler can finish:
 *
 * - `reserved`: counted against every limit, nothing signed. A crash here costs nothing;
 *   the reconciler fails the row after two minutes.
 * - `signed`: the nonce, hash and raw transaction are on disk *before* the broadcast. A
 *   crash between the two is recovered by rebroadcasting the same bytes — the same hash,
 *   so a second broadcast can never become a second payment.
 * - `sent`: the node accepted it; only the receipt is outstanding.
 *
 * `raw_tx` is the faucet's own funding transaction, which is public the moment it is
 * broadcast. It is the one signature-bearing column in any Mapae store, and it is here
 * because rebroadcasting the exact bytes is what makes recovery idempotent.
 *
 * "Active" claims — reserved, signed, sent or confirmed — are the ones every window and
 * limit counts. `skipped` (the recipient already held enough) and `failed` (nothing
 * landed) never consume a window: a refusal must not lock anyone out.
 */

export type FaucetClaimKind = "musdc" | "eth";
export type FaucetClaimState = "reserved" | "signed" | "sent" | "confirmed" | "failed" | "skipped";

export interface FaucetClaimRow {
    id: string;
    kind: FaucetClaimKind;
    owner: string;
    recipient: string;
    ip_key: string;
    subnet_key: string;
    /** Decimal base units or wei; `"0"` until the amount is decided. */
    amount: string;
    state: FaucetClaimState;
    nonce: number | null;
    tx_hash: string | null;
    raw_tx: string | null;
    created_at: number;
    updated_at: number;
}

export interface FaucetReserveInput {
    kind: FaucetClaimKind;
    owner: string;
    recipient: string;
    ipKey: string;
    subnetKey: string;
    /** Decided now (ETH) or `0n` until the recipient's balance is read (stablecoin). */
    amount: bigint;
}

/** What one kind is allowed, as of the call. */
export interface FaucetReserveLimits {
    /** Per owner: one counted claim per window. */
    windowMs: number;
    /** The rolling span the network limits and the daily caps count over. */
    dayMs: number;
    perIp: number;
    perSubnet: number;
    /** Counted claims of this kind per day, across everyone. */
    perDay?: number;
    /** Wei this kind may commit per day, across everyone, including this claim. */
    dailyAmount?: bigint;
}

export type FaucetAdmission =
    | {kind: "inflight"; claim: FaucetClaimRow}
    | {kind: "cooldown"; nextAt: number}
    | {kind: "rate_limited"}
    | {kind: "budget_exhausted"};

export type FaucetReservation = {ok: true; claim: FaucetClaimRow; created: boolean} | {ok: false; refusal: Exclude<FaucetAdmission, {kind: "inflight"}>};

const ACTIVE = "('reserved','signed','sent','confirmed')";
const INFLIGHT = "('reserved','signed','sent')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS faucet_claims (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('musdc','eth')),
    owner TEXT NOT NULL CHECK (owner GLOB '0x[0-9a-f]*' AND length(owner) = 42),
    recipient TEXT NOT NULL CHECK (recipient GLOB '0x[0-9a-f]*' AND length(recipient) = 42),
    ip_key TEXT NOT NULL,
    subnet_key TEXT NOT NULL,
    amount TEXT NOT NULL CHECK (amount GLOB '[0-9]*' AND amount <> ''),
    state TEXT NOT NULL CHECK (state IN ('reserved','signed','sent','confirmed','failed','skipped')),
    nonce INTEGER,
    tx_hash TEXT,
    raw_tx TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (state IN ('reserved','skipped','failed') OR (nonce IS NOT NULL AND tx_hash IS NOT NULL AND raw_tx IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS faucet_claims_one_inflight ON faucet_claims (kind, owner) WHERE state IN ('reserved','signed','sent');
CREATE INDEX IF NOT EXISTS faucet_claims_kind_created ON faucet_claims (kind, created_at);
CREATE INDEX IF NOT EXISTS faucet_claims_ip ON faucet_claims (ip_key, kind, created_at);
CREATE INDEX IF NOT EXISTS faucet_claims_subnet ON faucet_claims (subnet_key, kind, created_at);
CREATE INDEX IF NOT EXISTS faucet_claims_owner ON faucet_claims (owner, kind, created_at);
`;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const KEY = /^[0-9a-f]{64}$/;

function assertReserveInput(input: FaucetReserveInput, now: number): void {
    if (input.kind !== "musdc" && input.kind !== "eth") throw new TypeError("kind must be musdc or eth");
    if (!ADDRESS.test(input.owner) || !ADDRESS.test(input.recipient)) throw new TypeError("owner and recipient must be lowercase addresses");
    if (!KEY.test(input.ipKey) || !KEY.test(input.subnetKey)) throw new TypeError("network keys must be 32-byte lowercase hex digests");
    if (input.amount < 0n) throw new TypeError("amount must be non-negative");
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
}

/** Opens (or creates) the faucet ledger. `:memory:` is for tests; the service refuses it when enabled. */
export function openFaucetStore(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
    const db = new Database(path, {create: true, strict: true});
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    db.exec(SCHEMA);

    const byId = db.query<FaucetClaimRow, [string]>("SELECT * FROM faucet_claims WHERE id = ?");
    const inflight = db.query<FaucetClaimRow, [string, string]>(
        `SELECT * FROM faucet_claims WHERE kind = ? AND owner = ? AND state IN ${INFLIGHT}`,
    );
    const lastActive = db.query<{created_at: number}, [string, string, number]>(
        `SELECT created_at FROM faucet_claims WHERE kind = ? AND owner = ? AND state IN ${ACTIVE} AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    );
    const countIp = db.query<{n: number}, [string, string, number]>(
        `SELECT count(*) AS n FROM faucet_claims WHERE ip_key = ? AND kind = ? AND created_at > ? AND state IN ${ACTIVE}`,
    );
    const countSubnet = db.query<{n: number}, [string, string, number]>(
        `SELECT count(*) AS n FROM faucet_claims WHERE subnet_key = ? AND kind = ? AND created_at > ? AND state IN ${ACTIVE}`,
    );
    const dayRows = db.query<{amount: string}, [string, number]>(
        `SELECT amount FROM faucet_claims WHERE kind = ? AND created_at > ? AND state IN ${ACTIVE}`,
    );
    const latest = db.query<FaucetClaimRow, [string, string]>(
        "SELECT * FROM faucet_claims WHERE kind = ? AND owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    );
    const insert = db.query(
        `INSERT INTO faucet_claims (id, kind, owner, recipient, ip_key, subnet_key, amount, state, nonce, tx_hash, raw_tx, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?)`,
    );

    /**
     * The checks `reserve` runs, in its order, without writing. The service calls this
     * first so a wallet on cooldown never costs an eligibility read on another chain.
     */
    function admission(input: FaucetReserveInput, now: number, limits: FaucetReserveLimits): FaucetAdmission | undefined {
        const existing = inflight.get(input.kind, input.owner);
        if (existing) return {kind: "inflight", claim: existing};
        const last = lastActive.get(input.kind, input.owner, now - limits.windowMs);
        if (last) return {kind: "cooldown", nextAt: last.created_at + limits.windowMs};
        const since = now - limits.dayMs;
        if (countIp.get(input.ipKey, input.kind, since)!.n >= limits.perIp) return {kind: "rate_limited"};
        if (countSubnet.get(input.subnetKey, input.kind, since)!.n >= limits.perSubnet) return {kind: "rate_limited"};
        if (limits.perDay !== undefined || limits.dailyAmount !== undefined) {
            const rows = dayRows.all(input.kind, since);
            if (limits.perDay !== undefined && rows.length >= limits.perDay) return {kind: "budget_exhausted"};
            if (limits.dailyAmount !== undefined) {
                const committed = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
                if (committed + input.amount > limits.dailyAmount) return {kind: "budget_exhausted"};
            }
        }
        return undefined;
    }

    /**
     * Admit and record a claim in one immediate transaction.
     *
     * bun:sqlite is synchronous and the transaction takes the write lock before its first
     * read, so two concurrent claims — in this process or another on the same file —
     * cannot both pass a limit with one slot left. A retry for an owner whose claim is in
     * flight gets that claim back (`created: false`), so the client needs no idempotency key.
     */
    const reserveTx = db.transaction((input: FaucetReserveInput, now: number, limits: FaucetReserveLimits): FaucetReservation => {
        const refusal = admission(input, now, limits);
        if (refusal?.kind === "inflight") return {ok: true, claim: refusal.claim, created: false};
        if (refusal) return {ok: false, refusal};
        const id = crypto.randomUUID();
        insert.run(id, input.kind, input.owner, input.recipient, input.ipKey, input.subnetKey, String(input.amount), now, now);
        return {ok: true, claim: byId.get(id)!, created: true};
    });

    /** Move `id` from one of `from` to `to`; false when the row was elsewhere (another path finished it first). */
    function transition(id: string, from: readonly FaucetClaimState[], to: FaucetClaimState, now: number, set = "", params: (string | number)[] = []): boolean {
        const marks = from.map(() => "?").join(",");
        return db
            .query(`UPDATE faucet_claims SET state = ?, updated_at = ?${set} WHERE id = ? AND state IN (${marks})`)
            .run(to, now, ...params, id, ...from).changes === 1;
    }

    return {
        admission(input: FaucetReserveInput, now: number, limits: FaucetReserveLimits): FaucetAdmission | undefined {
            assertReserveInput(input, now);
            return admission(input, now, limits);
        },
        reserve(input: FaucetReserveInput, now: number, limits: FaucetReserveLimits): FaucetReservation {
            assertReserveInput(input, now);
            return reserveTx.immediate(input, now, limits);
        },
        get: (id: string) => byId.get(id) ?? undefined,
        /** Persist the signed transaction before it is broadcast. Only a `reserved` row can be signed. */
        markSigned(id: string, signed: {amount: bigint; nonce: number; txHash: string; rawTx: string}, now: number): boolean {
            if (signed.amount <= 0n || !Number.isSafeInteger(signed.nonce) || signed.nonce < 0) throw new TypeError("a signed claim needs a positive amount and a nonce");
            if (!/^0x[0-9a-f]{64}$/.test(signed.txHash) || !/^0x[0-9a-f]+$/.test(signed.rawTx)) throw new TypeError("a signed claim needs its lowercase hash and raw bytes");
            return transition(id, ["reserved"], "signed", now, ", amount = ?, nonce = ?, tx_hash = ?, raw_tx = ?", [
                String(signed.amount), signed.nonce, signed.txHash, signed.rawTx,
            ]);
        },
        /** The node accepted the bytes (or accepted them again on a rebroadcast). */
        markSent: (id: string, now: number) => transition(id, ["signed", "sent"], "sent", now),
        markConfirmed: (id: string, now: number) => transition(id, ["signed", "sent"], "confirmed", now),
        /** Nothing landed. A signed row keeps its hash as the record of what was tried. */
        markFailed: (id: string, now: number) => transition(id, ["reserved", "signed", "sent"], "failed", now),
        /** The recipient already held enough; nothing was or will be sent. */
        markSkipped: (id: string, now: number) => transition(id, ["reserved"], "skipped", now, ", amount = '0'"),
        latest: (kind: FaucetClaimKind, owner: string) => latest.get(kind, owner) ?? undefined,
        /**
         * What signed and sent claims will still take from the faucet once mined: the ETH
         * they carry and how many transactions there are. The service subtracts both from
         * the last block's balance before it signs another.
         */
        inflight(): {wei: bigint; count: number} {
            const rows = db.query<{kind: FaucetClaimKind; amount: string}, []>("SELECT kind, amount FROM faucet_claims WHERE state IN ('signed','sent')").all();
            return {wei: rows.reduce((sum, row) => (row.kind === "eth" ? sum + BigInt(row.amount) : sum), 0n), count: rows.length};
        },
        /** Rows the reconciler still owes an outcome. */
        unsettled: () => db.query<FaucetClaimRow, []>(`SELECT * FROM faucet_claims WHERE state IN ${INFLIGHT} ORDER BY nonce, created_at`).all(),
        /**
         * One past the highest nonce this ledger has spent or holds signed, or 0. The
         * service takes the larger of this and the chain's pending count, so a transaction
         * signed but not yet seen by the node is never overwritten by the next claim.
         */
        nextNonce(): number {
            const row = db.query<{n: number | null}, []>("SELECT max(nonce) AS n FROM faucet_claims WHERE state IN ('signed','sent','confirmed')").get();
            return row?.n === null || row?.n === undefined ? 0 : row.n + 1;
        },
        /** Drop finished rows created before `before`. In-flight rows are never pruned. */
        prune(before: number): number {
            return db.query("DELETE FROM faucet_claims WHERE created_at < ? AND state IN ('confirmed','failed','skipped')").run(before).changes;
        },
        close() {
            db.close();
        },
    };
}
export type FaucetStore = ReturnType<typeof openFaucetStore>;
