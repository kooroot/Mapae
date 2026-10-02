CREATE TABLE IF NOT EXISTS arcade_profiles (
    owner TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS arcade_login_challenges (
    token_hash TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    origin TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arcade_challenge_expiry ON arcade_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS arcade_sessions (
    token_hash TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    origin TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arcade_session_expiry ON arcade_sessions(expires_at);
CREATE TABLE IF NOT EXISTS arcade_auth_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arcade_auth_limit_expiry ON arcade_auth_limits(expires_at);
CREATE TABLE IF NOT EXISTS arcade_checkouts (
    request_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    character_id TEXT NOT NULL,
    game TEXT NOT NULL CHECK(game IN ('stamp','race','shop')),
    payer TEXT NOT NULL,
    intent TEXT NOT NULL UNIQUE,
    receipt TEXT,
    admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN (0,1)),
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS arcade_checkout_active ON arcade_checkouts(owner) WHERE admitted=0;
