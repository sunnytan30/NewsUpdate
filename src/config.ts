import 'dotenv/config';
import { z } from 'zod';
import crypto from 'node:crypto';

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

  TZ: z.string().default('Asia/Singapore'),
  DIGEST_CRON: z.string().default('0 7 * * *'),
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

export const config = {
  ...raw,
  isProd,
  SESSION_SECRET: secret('SESSION_SECRET', raw.SESSION_SECRET),
  TOKEN_SECRET: secret('TOKEN_SECRET', raw.TOKEN_SECRET),
  /** Normalised admin mount path, without a trailing slash. */
  ADMIN_PATH: raw.ADMIN_PATH.replace(/\/+$/, '') || '/console',
  ADMIN_EMAIL: raw.ADMIN_EMAIL.trim().toLowerCase(),
};

export type Config = typeof config;
