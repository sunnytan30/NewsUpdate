import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { hashSecret, randomToken, safeEqual, verifySecret } from '../util/crypto.js';
import { log } from '../util/logger.js';

const SESSION_TTL_HOURS = 8;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 14;

export type AdminUser = {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  failed_logins: number;
  locked_until: string | null;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function findAdmin(): AdminUser | null {
  const row = db
    .prepare('SELECT * FROM admin_users WHERE email = ?')
    .get(config.ADMIN_EMAIL) as AdminUser | undefined;
  return row ?? null;
}

export function adminExists(): boolean {
  return findAdmin() !== null;
}

/**
 * Create or replace the admin password. The account is bound to
 * config.ADMIN_EMAIL; no other address can be given admin access.
 */
export function setAdminPassword(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const hash = hashSecret(password);
  const existing = findAdmin();
  if (existing) {
    db.prepare(
      `UPDATE admin_users
       SET password_hash = ?, updated_at = datetime('now'), failed_logins = 0, locked_until = NULL
       WHERE id = ?`,
    ).run(hash, existing.id);
  } else {
    db.prepare('INSERT INTO admin_users (email, password_hash) VALUES (?, ?)').run(
      config.ADMIN_EMAIL,
      hash,
    );
  }
  // Any existing sessions are invalidated when the password changes.
  db.prepare('DELETE FROM admin_sessions').run();
  return { ok: true };
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: string };

/**
 * Authenticate the admin. The email must match the bound address exactly, and
 * repeated failures lock the account for a cool-down period.
 */
export function login(email: string, password: string, userAgent?: string): LoginResult {
  const generic = 'Those credentials are not valid.';
  const admin = findAdmin();

  // Compare in constant time, and still do the work when the account is
  // missing or the email is wrong, so timing does not reveal which it was.
  const emailMatches = safeEqual(email.trim().toLowerCase(), config.ADMIN_EMAIL);
  if (!admin) {
    hashSecret(password);
    return { ok: false, reason: generic };
  }

  if (admin.locked_until) {
    const locked = db
      .prepare("SELECT (locked_until > datetime('now')) AS locked FROM admin_users WHERE id = ?")
      .get(admin.id) as { locked: number };
    if (locked.locked === 1) {
      return {
        ok: false,
        reason: `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`,
      };
    }
  }

  const passwordMatches = verifySecret(password, admin.password_hash);
  if (!emailMatches || !passwordMatches) {
    const failures = admin.failed_logins + 1;
    if (failures >= MAX_FAILED_LOGINS) {
      db.prepare(
        `UPDATE admin_users SET failed_logins = 0, locked_until = datetime('now', ?) WHERE id = ?`,
      ).run(`+${LOCKOUT_MINUTES} minutes`, admin.id);
      log.warn('admin account locked after repeated failures');
      return {
        ok: false,
        reason: `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`,
      };
    }
    db.prepare('UPDATE admin_users SET failed_logins = ? WHERE id = ?').run(failures, admin.id);
    return { ok: false, reason: generic };
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
  db.prepare(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, user_agent)
     VALUES (?, ?, datetime('now', ?), ?)`,
  ).run(hashToken(token), admin.id, `+${SESSION_TTL_HOURS} hours`, userAgent?.slice(0, 200) ?? null);

  db.prepare(
    `UPDATE admin_users
     SET last_login_at = datetime('now'), failed_logins = 0, locked_until = NULL
     WHERE id = ?`,
  ).run(admin.id);

  log.info('admin signed in');
  return { ok: true, token, expiresAt };
}

export function sessionIsValid(token: string | undefined): boolean {
  if (!token) return false;
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM admin_sessions
       WHERE token_hash = ? AND expires_at > datetime('now')`,
    )
    .get(hashToken(token)) as { ok: number } | undefined;
  return row !== undefined;
}

export function logout(token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(): void {
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
}
