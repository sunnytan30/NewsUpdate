-- NewsUpdate schema. Applied idempotently on boot.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Subscribers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT    NOT NULL,
  email_normalised    TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'unsubscribed')),
  -- NULL means "use the global default from settings".
  source_limit        INTEGER,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  verified_at         TEXT,
  unsubscribed_at     TEXT,
  last_digest_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status);

-- ---------------------------------------------------------------------------
-- Email verification PINs. Only the hash is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_pins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  pin_hash      TEXT    NOT NULL,
  purpose       TEXT    NOT NULL DEFAULT 'verify'
                        CHECK (purpose IN ('verify', 'manage')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pins_subscriber ON verification_pins (subscriber_id, purpose, consumed_at);

-- ---------------------------------------------------------------------------
-- Per-subscriber news sources. HTTPS is enforced in application code and
-- re-asserted here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id   INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  url             TEXT    NOT NULL CHECK (url LIKE 'https://%'),
  host            TEXT    NOT NULL,
  label           TEXT,
  -- Resolved feed URL, when the page advertises an RSS/Atom feed.
  feed_url        TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT,
  last_status     TEXT,
  last_error      TEXT,
  UNIQUE (subscriber_id, url)
);

CREATE INDEX IF NOT EXISTS idx_sources_subscriber ON sources (subscriber_id, active);

-- ---------------------------------------------------------------------------
-- Admin. A single bound account; password stored as a scrypt hash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT
);

-- Server-side sessions. The cookie carries an opaque token; only its hash
-- is stored, so a database leak does not yield usable sessions.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT    PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Admin-editable settings (key/value).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Digest runs and the articles/clusters they produced.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS digest_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT,
  status           TEXT    NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'completed', 'failed')),
  sources_fetched  INTEGER NOT NULL DEFAULT 0,
  sources_failed   INTEGER NOT NULL DEFAULT 0,
  articles_found   INTEGER NOT NULL DEFAULT 0,
  emails_sent      INTEGER NOT NULL DEFAULT 0,
  emails_failed    INTEGER NOT NULL DEFAULT 0,
  summariser       TEXT,
  error            TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES digest_runs (id) ON DELETE CASCADE,
  source_id      INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  host           TEXT    NOT NULL,
  url            TEXT    NOT NULL,
  canonical_url  TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  excerpt        TEXT,
  published_at   TEXT,
  -- Rank within the source feed; a proxy for editorial prominence.
  feed_position  INTEGER,
  fetched_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_run ON articles (run_id);
CREATE INDEX IF NOT EXISTS idx_articles_canonical ON articles (run_id, canonical_url);

-- ---------------------------------------------------------------------------
-- What each subscriber has already been sent, so stories are not repeated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sent_stories (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  story_key     TEXT    NOT NULL,
  sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subscriber_id, story_key)
);

CREATE INDEX IF NOT EXISTS idx_sent_stories_sent_at ON sent_stories (sent_at);

-- ---------------------------------------------------------------------------
-- Delivery log, for the admin console.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES digest_runs (id) ON DELETE SET NULL,
  subscriber_id INTEGER REFERENCES subscribers (id) ON DELETE SET NULL,
  subject       TEXT    NOT NULL,
  story_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deliveries_run ON deliveries (run_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscriber ON deliveries (subscriber_id, created_at);
