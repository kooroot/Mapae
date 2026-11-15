-- D1 database `mapae-ops`. Apply with:
--   wrangler d1 execute mapae-ops --remote --file schema.sql
-- Every timestamp is epoch milliseconds, taken from the Worker's clock, never the sender's.

-- One row per named check (public probe, collector heartbeat, `hourly:<item>`).
-- The alert state machine reads and writes this; see src/alerts.ts.
CREATE TABLE IF NOT EXISTS alert_state (
    name TEXT PRIMARY KEY,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    since INTEGER NOT NULL,
    last_notified INTEGER
);

-- Last accepted ingest per collector kind; the cron alerts when one goes quiet.
CREATE TABLE IF NOT EXISTS heartbeats (
    kind TEXT PRIMARY KEY CHECK (kind IN ('hourly', 'daily')),
    at INTEGER NOT NULL
);

-- One snapshot per KST day; a re-run of the same day replaces it.
CREATE TABLE IF NOT EXISTS snapshots (
    day TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- The KST Sunday ending each week whose report was delivered. Written only after
-- Telegram accepted it, so a failed send is retried by the next daily ingest, and a
-- re-run does not send the week twice.
CREATE TABLE IF NOT EXISTS weekly_reports (
    week TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
);
