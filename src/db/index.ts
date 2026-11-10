import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../util/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function openDatabase(): Database.Database {
  const file = path.resolve(config.DATABASE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
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

function applyMigrations(): void {
  // Per-subscriber send timezone, and the local date guard that goes with it.
  ensureColumn('subscribers', 'timezone', `TEXT NOT NULL DEFAULT 'Asia/Singapore'`);
  ensureColumn('subscribers', 'last_digest_local_date', 'TEXT');
}

/** Apply the schema and any follow-up migrations. Safe to re-run. */
export function migrate(): void {
  const schemaPath = path.join(here, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  applyMigrations();
  seedSettings();
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
