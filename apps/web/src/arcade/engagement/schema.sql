-- First-party aggregate telemetry, isolated from wallet profiles and NFT progression.
CREATE TABLE IF NOT EXISTS arcade_engagement_visitors (
  hash TEXT PRIMARY KEY, first_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL, session TEXT NOT NULL, session_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS arcade_engagement_events (
  id TEXT PRIMARY KEY, visitor TEXT NOT NULL, session TEXT NOT NULL,
  owner TEXT, event TEXT NOT NULL, game TEXT, run_id TEXT, result TEXT,
  locale TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('client_reported', 'server_authenticated'))
);
CREATE UNIQUE INDEX IF NOT EXISTS arcade_engagement_run_event ON arcade_engagement_events(visitor, run_id, event) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arcade_engagement_session_entry ON arcade_engagement_events(visitor, session, day) WHERE event='arcade_entered';
CREATE UNIQUE INDEX IF NOT EXISTS arcade_engagement_session_login ON arcade_engagement_events(visitor, session, day, owner) WHERE event='profile_authenticated';
CREATE INDEX IF NOT EXISTS arcade_engagement_at ON arcade_engagement_events(at);
CREATE INDEX IF NOT EXISTS arcade_engagement_visitor_day ON arcade_engagement_events(visitor, day);
CREATE TABLE IF NOT EXISTS arcade_engagement_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS arcade_engagement_daily (day TEXT NOT NULL, event TEXT NOT NULL, trust TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, event, trust));
CREATE TRIGGER IF NOT EXISTS arcade_engagement_count AFTER INSERT ON arcade_engagement_events BEGIN
  INSERT INTO arcade_engagement_daily(day,event,trust,count) VALUES (NEW.day,NEW.event,NEW.trust,1)
  ON CONFLICT(day,event,trust) DO UPDATE SET count=count+1;
END;
