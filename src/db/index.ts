import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { blindIndex, encryptField, FIELD, keyFingerprint } from '../util/encryption.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function openDatabase(): Database.Database {
  const file = path.resolve(config.DATABASE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  /*
   * Overwrite deleted content instead of leaving it on the freelist. Without
   * this, an unsubscribe or a housekeeping delete leaves the old row readable
   * in the file, which would undo much of the point of encrypting the address
   * in the first place. It costs a little write throughput.
   */
  database.pragma('secure_delete = ON');
  return database;
}

export const db = openDatabase();

/** True when `table` already has a column called `column`. */
function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Add a column to an existing table if it is missing.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which silently does nothing when
 * a table already exists — so columns added to the schema after a database was
 * first created need an explicit ALTER here.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  if (hasColumn(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info('added missing column', { table, column });
}

/**
 * Replace the plaintext email columns with an encrypted value plus a blind
 * index, re-encrypting whatever is already stored.
 *
 * This is a table rebuild rather than ALTER TABLE, because SQLite cannot drop
 * a column that carries a UNIQUE constraint — and leaving `email_normalised`
 * behind would defeat the point of encrypting the address.
 */
function encryptEmailColumns(): void {
  if (!hasColumn('subscribers', 'email_normalised')) return;

  type LegacyRow = {
    id: number;
    email: string;
    email_normalised: string;
    name: string;
    status: string;
    source_limit: number | null;
    send_hour: number | null;
    timezone: string;
    created_at: string;
    verified_at: string | null;
    unsubscribed_at: string | null;
    last_digest_sent_at: string | null;
    last_digest_local_date: string | null;
  };

  const rows = db.prepare('SELECT * FROM subscribers').all() as LegacyRow[];

  log.warn('migrating subscriber email addresses to encrypted storage', { rows: rows.length });

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE subscribers_new (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        email_enc              TEXT    NOT NULL,
        email_index            TEXT    NOT NULL UNIQUE,
        name                   TEXT    NOT NULL,
        status                 TEXT    NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending', 'active', 'unsubscribed')),
        source_limit           INTEGER,
        send_hour              INTEGER CHECK (send_hour IS NULL OR (send_hour BETWEEN 0 AND 23)),
        timezone               TEXT    NOT NULL DEFAULT 'Asia/Singapore',
        created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
        verified_at            TEXT,
        unsubscribed_at        TEXT,
        last_digest_sent_at    TEXT,
        last_digest_local_date TEXT
      );
    `);

    // Each row is inserted with its address already transformed. Copying the
    // rows first and filling the address in afterwards is not an option: the
    // placeholder would collide on the UNIQUE index at the second row.
    const insert = db.prepare(
      `INSERT INTO subscribers_new
         (id, email_enc, email_index, name, status, source_limit, send_hour, timezone,
          created_at, verified_at, unsubscribed_at, last_digest_sent_at, last_digest_local_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const normalised = row.email_normalised.trim().toLowerCase();
      insert.run(
        row.id,
        encryptField(row.email, FIELD.subscriberEmail),
        blindIndex(normalised, FIELD.subscriberEmail),
        row.name,
        row.status,
        row.source_limit,
        row.send_hour,
        row.timezone,
        row.created_at,
        row.verified_at,
        row.unsubscribed_at,
        row.last_digest_sent_at,
        row.last_digest_local_date,
      );
    }

    // Child tables reference subscribers(id), which is preserved, so the swap
    // is safe. Foreign keys are disabled for the duration to allow the drop.
    db.exec('DROP TABLE subscribers');
    db.exec('ALTER TABLE subscribers_new RENAME TO subscribers');
    db.exec('CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status)');
  });

  // A table swap cannot run with foreign keys enforced mid-transaction.
  db.pragma('foreign_keys = OFF');
  try {
    rebuild();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const check = db.pragma('foreign_key_check') as unknown[];
  if (check.length > 0) {
    throw new Error('email encryption migration left foreign keys inconsistent; database not changed');
  }

  /*
   * Dropping the old table frees its pages but does not erase them: SQLite
   * leaves the old bytes on the freelist, so the plaintext addresses are still
   * readable in the file with a hex editor. VACUUM rewrites the database from
   * scratch and discards those pages.
   *
   * VACUUM cannot run inside a transaction, which is why it is out here.
   */
  db.exec('VACUUM');

  log.info('subscriber email addresses are now encrypted at rest', {
    rows: rows.length,
    note: 'database vacuumed; destroy or re-create any backup taken before this point',
  });
  log.warn(
    'backups made before this migration still contain plaintext email addresses; ' +
      'replace them and delete the old copies',
  );
}

function applyMigrations(): void {
  // Per-subscriber send timezone, and the local date guard that goes with it.
  ensureColumn('subscribers', 'timezone', `TEXT NOT NULL DEFAULT 'Asia/Singapore'`);
  ensureColumn('subscribers', 'last_digest_local_date', 'TEXT');
  // Per-subscriber send hour; NULL falls back to the global default.
  ensureColumn('subscribers', 'send_hour', 'INTEGER');
  // Must run after the columns above exist, since it copies them forward.
  encryptEmailColumns();
}

/**
 * Refuse to run against a database written with a different encryption key.
 *
 * Carrying on would be worse than stopping: every blind-index lookup would
 * miss, so sign-ups would create duplicate rows alongside unreadable originals.
 */
function assertEncryptionKeyMatches(): void {
  const fingerprint = keyFingerprint();
  const stored = getSetting(SETTING_KEYS.encryptionKeyFingerprint);

  if (stored === null) {
    setSetting(SETTING_KEYS.encryptionKeyFingerprint, fingerprint);
    return;
  }
  if (stored === fingerprint) return;

  throw new Error(
    'ENCRYPTION_KEY does not match the key this database was written with.\n' +
      'Stored email addresses cannot be decrypted with the current key, and continuing ' +
      'would create duplicate subscriber records.\n' +
      'Restore the original key, or, if the data is genuinely expendable, delete the ' +
      `database file and start again. Expected fingerprint ${stored}, got ${fingerprint}.`,
  );
}

/** Apply the schema and any follow-up migrations. Safe to re-run. */
export function migrate(): void {
  const schemaPath = path.join(here, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  applyMigrations();
  seedSettings();
  // After seeding, so a brand-new database records its key on first boot.
  assertEncryptionKeyMatches();
  log.info('database ready', { path: path.resolve(config.DATABASE_PATH) });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  defaultSourceLimit: 'default_source_limit',
  maxStoriesPerEmail: 'max_stories_per_email',
  signupsOpen: 'signups_open',
  minSourcesForTrending: 'min_sources_for_trending',
  /** Fingerprint of the ENCRYPTION_KEY this database was written with. */
  encryptionKeyFingerprint: 'encryption_key_fingerprint',
  /** Local hour (0-23) at which each subscriber's digest is sent. */
  sendHour: 'send_hour',
} as const;

function seedSettings(): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insert.run(SETTING_KEYS.defaultSourceLimit, String(config.DEFAULT_SOURCE_LIMIT));
  insert.run(SETTING_KEYS.maxStoriesPerEmail, String(config.MAX_STORIES_PER_EMAIL));
  insert.run(SETTING_KEYS.signupsOpen, 'true');
  insert.run(SETTING_KEYS.minSourcesForTrending, '2');
  insert.run(SETTING_KEYS.sendHour, String(config.DEFAULT_SEND_HOUR));
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function getSettingInt(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettingBool(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  return raw === 'true' || raw === '1';
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
