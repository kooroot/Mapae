/**
 * Schema for `user_version` 3.
 *
 * The schema is the allowlist. Every column is something an operator may read back
 * later — identifiers, addresses, amounts, hashes, outcomes — and there is no column a
 * raw payment payload, a signature or a key could land in. The same line
 * `apps/web/src/lib/grant-store.ts` holds for the browser is held here for disk. The
 * seller's manage token is kept only as its sha256 (`manage_token_hash`), the same way
 * `/metrics` compares its bearer: the token is presented, hashed and looked up, never
 * written.
 *
 * Amounts (token base units, wei, gas) are TEXT, not INTEGER. SQLite's INTEGER is a
 * signed 64-bit and wei balances exceed it; a value that truncates on the way to disk
 * is worse than one that refuses. `index.ts` writes `String(bigint)` and reads
 * `BigInt(text)`, so the column never holds anything but a decimal integer.
 *
 * Constraints are named so the error a caller sees says which rule fired
 * (`CHECK constraint failed: sellers_kind`) instead of echoing the expression.
 *
 * The slug is the seller's identity everywhere the hosted shop reads it — the route
 * segment, the item's owner, the order's owner. Items are keyed by `(seller_slug, key)`
 * rather than a surrogate id for the same reason: a URL names an item by its key, and
 * an order that records the same pair can be read back without a join.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
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

CREATE TABLE budget_days (
    day TEXT PRIMARY KEY,
    spent_wei TEXT NOT NULL
);

-- One row per account that drew from the faucet, dated from the mint that landed. The
-- window has to outlive the process: a bound a restart clears is not a bound.
CREATE TABLE faucet_windows (
    account TEXT PRIMARY KEY,
    minted_at INTEGER NOT NULL
);
CREATE INDEX faucet_windows_minted_at ON faucet_windows (minted_at);

-- kind is the seller's, not the item's: a hosted seller's items are all served by the
-- shop, an external seller's all by its own base_url. The two facts travel together —
-- exactly the external sellers have a base_url — and sellers_base_url makes SQLite
-- refuse a row where they do not.
CREATE TABLE sellers (
    slug TEXT PRIMARY KEY,
    kind TEXT NOT NULL CONSTRAINT sellers_kind CHECK (kind IN ('hosted', 'external')),
    name TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    base_url TEXT,
    manage_token_hash TEXT UNIQUE,
    contact TEXT,
    internal INTEGER NOT NULL DEFAULT 0 CONSTRAINT sellers_internal CHECK (internal IN (0, 1)),
    created_at INTEGER NOT NULL,
    CONSTRAINT sellers_base_url CHECK ((kind = 'external') = (base_url IS NOT NULL))
);

-- Two items of one seller may carry the same price: the payment intent differs per
-- leaf, and the orders table — not the price — is the double-delivery guard.
CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    seller_slug TEXT NOT NULL REFERENCES sellers (slug),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price_base TEXT NOT NULL,
    resource_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (seller_slug, key)
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    seller_slug TEXT NOT NULL,
    item_key TEXT NOT NULL,
    payment_intent_id TEXT NOT NULL UNIQUE,
    payer TEXT NOT NULL,
    amount_base TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (seller_slug, item_key) REFERENCES items (seller_slug, key)
);
CREATE INDEX orders_seller_created_at ON orders (seller_slug, created_at);
`;
