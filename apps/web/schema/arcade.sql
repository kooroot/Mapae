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
