import 'dotenv/config';
import { z } from 'zod';
import crypto from 'node:crypto';
import { isValidTimeZone } from './util/timezone.js';
import { initFieldEncryption } from './util/encryption.js';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const Schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  INSECURE_COOKIES: bool(false),
  TRUST_PROXY: bool(false),

  DATABASE_PATH: z.string().default('./data/newsupdate.sqlite'),

  SESSION_SECRET: z.string().min(1).optional(),
  TOKEN_SECRET: z.string().min(1).optional(),
  // Encrypts subscriber email addresses at rest. 32 bytes, hex or base64.
  // Losing it makes every stored address unreadable and unrecoverable.
  ENCRYPTION_KEY: z.string().min(1).optional(),

  ADMIN_PATH: z.string().default('/console-dev-only-change-me'),
  // Deliberately has no default: the admin identity is deployment
  // configuration, not a source constant. Set it in .env.
  ADMIN_EMAIL: z.string().email(),

  MAIL_PROVIDER: z.enum(['smtp', 'resend', 'console']).default('console'),
  MAIL_FROM: z.string().default('News Update <no-reply@localhost>'),
  MAIL_REPLY_TO: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  SUMMARISER: z.enum(['anthropic', 'extractive']).default('extractive'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),

  // Process timezone, used for log timestamps and the housekeeping schedule.
  TZ: z.string().default('Asia/Singapore'),
  // Timezone assigned to a new subscriber who does not pick one.
  DEFAULT_TIMEZONE: z.string().optional(),
  // Local hour (0-23) at which each subscriber receives their digest, in their
  // own timezone. Admin-editable at runtime; this is only the seed value.
  DEFAULT_SEND_HOUR: int(7),
  // How often to check whether any subscriber has reached their send hour.
  // A sweep with nobody due costs one query and fetches nothing.
  DIGEST_SWEEP_CRON: z.string().default('*/15 * * * *'),
  // Replaced by DIGEST_SWEEP_CRON + DEFAULT_SEND_HOUR; warned about below.
  DIGEST_CRON: z.string().optional(),
  ENABLE_SCHEDULER: bool(true),
  DEFAULT_SOURCE_LIMIT: int(5),
  MAX_STORIES_PER_EMAIL: int(8),

  FETCH_TIMEOUT_MS: int(15000),
  FETCH_MAX_BYTES: int(3_000_000),
  FETCH_CONCURRENCY: int(4),
  FETCH_HOST_DELAY_MS: int(1500),
  RESPECT_ROBOTS: bool(true),
  ALLOW_PRIVATE_NETWORK: bool(false),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:\n' + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';

/**
 * In production both secrets must be supplied. In development we derive
 * ephemeral ones so the app boots, at the cost of invalidating sessions and
 * unsubscribe links on every restart.
 */
function secret(name: 'SESSION_SECRET' | 'TOKEN_SECRET', value: string | undefined): string {
  if (value && value.length >= 32) return value;
  if (isProd) {
    console.error(
      `${name} must be set to at least 32 characters in production.\n` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }
  if (value) {
    console.warn(`[config] ${name} is shorter than 32 characters; acceptable in development only.`);
    return value;
  }
  console.warn(`[config] ${name} is unset; using an ephemeral development secret.`);
  return crypto.randomBytes(32).toString('hex');
}

if (!raw.ADMIN_PATH.startsWith('/')) {
  console.error('ADMIN_PATH must start with "/".');
  process.exit(1);
}
if (isProd && raw.ADMIN_PATH.length < 16) {
  console.error('ADMIN_PATH must be at least 16 characters in production so it cannot be guessed.');
  process.exit(1);
}
if (isProd && raw.SUMMARISER === 'anthropic' && !raw.ANTHROPIC_API_KEY) {
  console.error('SUMMARISER=anthropic requires ANTHROPIC_API_KEY.');
  process.exit(1);
}
if (isProd && raw.MAIL_PROVIDER === 'console') {
  console.error('MAIL_PROVIDER=console does not deliver mail and must not be used in production.');
  process.exit(1);
}

if (raw.DIGEST_CRON) {
  console.warn(
    '[config] DIGEST_CRON is no longer used and is being ignored. Digests are now sent at ' +
      'DEFAULT_SEND_HOUR in each subscriber\'s own timezone; DIGEST_SWEEP_CRON controls how ' +
      'often the service checks who is due.',
  );
}

if (raw.DEFAULT_SEND_HOUR < 0 || raw.DEFAULT_SEND_HOUR > 23) {
  console.error('DEFAULT_SEND_HOUR must be between 0 and 23.');
  process.exit(1);
}

/**
 * Key for encrypting stored email addresses.
 *
 * Required in production. In development a fixed, well-known key is used so a
 * local database stays readable across restarts — it is not a secret, and the
 * warning says so.
 */
const DEV_ENCRYPTION_KEY = '00'.repeat(32);

const encryptionKey = (() => {
  const supplied = raw.ENCRYPTION_KEY?.trim();
  if (supplied) return supplied;
  if (isProd) {
    console.error(
      'ENCRYPTION_KEY must be set in production; subscriber email addresses are encrypted with it.\n' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'Back it up before going live: without it, stored addresses cannot be recovered.',
    );
    process.exit(1);
  }
  console.warn(
    '[config] ENCRYPTION_KEY is unset; using a fixed development key. ' +
      'Stored addresses are NOT protected. Never run this way in production.',
  );
  return DEV_ENCRYPTION_KEY;
})();

try {
  initFieldEncryption(encryptionKey);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const FALLBACK_TIMEZONE = 'Asia/Singapore';

/**
 * Resolve a timezone setting, failing loudly in production.
 *
 * TZ is validated as well as DEFAULT_TIMEZONE, because the scheduler passes it
 * to node-cron, which rejects an unrecognised zone by throwing. Catching it
 * here gives a clear message at startup instead of an opaque crash.
 */
function resolveConfiguredTimezone(field: string, candidate: string): string {
  if (isValidTimeZone(candidate)) return candidate;
  if (isProd) {
    console.error(`${field} is not a recognised IANA timezone: ${candidate}`);
    process.exit(1);
  }
  console.warn(
    `[config] ${field} ("${candidate}") is not recognised; falling back to ${FALLBACK_TIMEZONE}.`,
  );
  return FALLBACK_TIMEZONE;
}

/** Process timezone, used for log timestamps and the housekeeping schedule. */
const processTimezone = resolveConfiguredTimezone('TZ', raw.TZ.trim());

/** The timezone given to a subscriber who does not choose one. */
const defaultTimezone = raw.DEFAULT_TIMEZONE?.trim()
  ? resolveConfiguredTimezone('DEFAULT_TIMEZONE', raw.DEFAULT_TIMEZONE.trim())
  : processTimezone;

export const config = {
  ...raw,
  isProd,
  SESSION_SECRET: secret('SESSION_SECRET', raw.SESSION_SECRET),
  TOKEN_SECRET: secret('TOKEN_SECRET', raw.TOKEN_SECRET),
  /** Normalised admin mount path, without a trailing slash. */
  ADMIN_PATH: raw.ADMIN_PATH.replace(/\/+$/, '') || '/console',
  ADMIN_EMAIL: raw.ADMIN_EMAIL.trim().toLowerCase(),
  // Both validated above, so the scheduler can hand them to node-cron safely.
  TZ: processTimezone,
  DEFAULT_TIMEZONE: defaultTimezone,
};

export type Config = typeof config;
