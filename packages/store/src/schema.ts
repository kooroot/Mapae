/**
 * Schema for `user_version` 1.
 *
 * The schema is the allowlist. Every column is something an operator may read back
 * later — identifiers, addresses, amounts, hashes, outcomes — and there is no column a
 * raw payment payload, a signature or a key could land in. The same line
 * `apps/web/src/lib/grant-store.ts` holds for the browser is held here for disk.
 *
 * Amounts (token base units, wei, gas) are TEXT, not INTEGER. SQLite's INTEGER is a
 * signed 64-bit and wei balances exceed it; a value that truncates on the way to disk
 * is worse than one that refuses. `index.ts` writes `String(bigint)` and reads
 * `BigInt(text)`, so the column never holds anything but a decimal integer.
 *
 * Constraints are named so the error a caller sees says which rule fired
 * (`CHECK constraint failed: items_kind`) instead of echoing the expression.
 */
export const SCHEMA_VERSION = 1;

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
