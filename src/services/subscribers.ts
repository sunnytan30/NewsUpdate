import { db, getSettingInt, SETTING_KEYS } from '../db/index.js';
import { hashSecret, randomPin, verifySecret, signedToken, verifySignedToken } from '../util/crypto.js';
import { config } from '../config.js';

export const PIN_TTL_MINUTES = 15;
export const PIN_MAX_ATTEMPTS = 5;
/** Most PINs that may be issued to one address within the TTL window. */
const PIN_MAX_ISSUES_PER_WINDOW = 3;

export type SubscriberStatus = 'pending' | 'active' | 'unsubscribed';

export type Subscriber = {
  id: number;
  email: string;
  email_normalised: string;
  name: string;
  status: SubscriberStatus;
  source_limit: number | null;
  created_at: string;
  verified_at: string | null;
  unsubscribed_at: string | null;
  last_digest_sent_at: string | null;
};

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Trim and collapse a display name; it ends up in the email subject line. */
export function cleanName(name: string): string {
  return name.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findByEmail(email: string): Subscriber | null {
  const row = db
    .prepare('SELECT * FROM subscribers WHERE email_normalised = ?')
    .get(normaliseEmail(email)) as Subscriber | undefined;
  return row ?? null;
}

export function findById(id: number): Subscriber | null {
  const row = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id) as Subscriber | undefined;
  return row ?? null;
}

export function listSubscribers(): Subscriber[] {
  return db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all() as Subscriber[];
}

export function activeSubscribers(): Subscriber[] {
  return db
    .prepare("SELECT * FROM subscribers WHERE status = 'active' ORDER BY id")
    .all() as Subscriber[];
}

/** The effective source limit: the per-subscriber override, else the global default. */
export function effectiveSourceLimit(subscriber: Subscriber): number {
  if (subscriber.source_limit !== null) return subscriber.source_limit;
  return getSettingInt(SETTING_KEYS.defaultSourceLimit, config.DEFAULT_SOURCE_LIMIT);
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

export type PinPurpose = 'verify' | 'manage';

type PinRow = {
  id: number;
  subscriber_id: number;
  pin_hash: string;
  purpose: PinPurpose;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

/**
 * Issue a PIN, invalidating any outstanding one for the same purpose.
 * Returns null when the address has already been sent too many PINs recently,
 * which stops the endpoint being used to send mail repeatedly to a third party.
 */
export function issuePin(subscriberId: number, purpose: PinPurpose): string | null {
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM verification_pins
       WHERE subscriber_id = ? AND purpose = ?
         AND created_at > datetime('now', ?)`,
    )
    .get(subscriberId, purpose, `-${PIN_TTL_MINUTES} minutes`) as { n: number };
  if (recent.n >= PIN_MAX_ISSUES_PER_WINDOW) return null;

  const pin = randomPin(6);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE verification_pins SET consumed_at = datetime('now')
       WHERE subscriber_id = ? AND purpose = ? AND consumed_at IS NULL`,
    ).run(subscriberId, purpose);

    db.prepare(
      `INSERT INTO verification_pins (subscriber_id, pin_hash, purpose, expires_at)
       VALUES (?, ?, ?, datetime('now', ?))`,
    ).run(subscriberId, hashSecret(pin), purpose, `+${PIN_TTL_MINUTES} minutes`);
  });
  tx();
  return pin;
}

export type PinCheck =
  | { ok: true; subscriber: Subscriber }
  | { ok: false; reason: string };

/**
 * Check a submitted PIN. Attempts are counted in the database so the limit
 * cannot be bypassed by reconnecting, and a wrong PIN never says whether the
 * address exists.
 */
export function checkPin(email: string, pin: string, purpose: PinPurpose): PinCheck {
  const generic = 'That code is not valid. Request a new one.';
  const subscriber = findByEmail(email);
  if (!subscriber) return { ok: false, reason: generic };

  const row = db
    .prepare(
      `SELECT * FROM verification_pins
       WHERE subscriber_id = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(subscriber.id, purpose) as PinRow | undefined;
  if (!row) return { ok: false, reason: generic };

  const expired =
    (db.prepare('SELECT (expires_at < datetime(\'now\')) AS expired FROM verification_pins WHERE id = ?')
      .get(row.id) as { expired: number }).expired === 1;
  if (expired) {
    db.prepare("UPDATE verification_pins SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }

  if (row.attempts >= PIN_MAX_ATTEMPTS) {
    db.prepare("UPDATE verification_pins SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: false, reason: 'Too many incorrect attempts. Request a new code.' };
  }

  db.prepare('UPDATE verification_pins SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  if (!verifySecret(pin.trim(), row.pin_hash)) {
    const remaining = PIN_MAX_ATTEMPTS - (row.attempts + 1);
    if (remaining <= 0) {
      // Burn the code as soon as the budget is spent, rather than waiting for
      // another attempt: otherwise the correct PIN stays usable for a while
      // after the limit has been reached.
      db.prepare("UPDATE verification_pins SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
      return { ok: false, reason: 'Too many incorrect attempts. Request a new code.' };
    }
    return {
      ok: false,
      reason: `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    };
  }

  db.prepare("UPDATE verification_pins SET consumed_at = datetime('now') WHERE id = ?").run(row.id);

  if (purpose === 'verify') {
    db.prepare(
      `UPDATE subscribers
       SET status = 'active', verified_at = COALESCE(verified_at, datetime('now')),
           unsubscribed_at = NULL
       WHERE id = ?`,
    ).run(subscriber.id);
  }

  const refreshed = findById(subscriber.id);
  return refreshed ? { ok: true, subscriber: refreshed } : { ok: false, reason: generic };
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export type SignupOutcome =
  | { kind: 'pin-sent'; subscriber: Subscriber; pin: string; purpose: PinPurpose }
  | { kind: 'throttled' };

/**
 * Register or re-register an address. The caller always shows the same
 * message regardless of the outcome, so the form cannot be used to discover
 * whether an address is already signed up.
 */
export function startSignup(name: string, email: string): SignupOutcome {
  const normalised = normaliseEmail(email);
  const display = cleanName(name);
  const existing = findByEmail(normalised);

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO subscribers (email, email_normalised, name, status)
         VALUES (?, ?, ?, 'pending')`,
      )
      .run(email.trim(), normalised, display);
    const created = findById(Number(info.lastInsertRowid));
    if (!created) return { kind: 'throttled' };
    const pin = issuePin(created.id, 'verify');
    return pin ? { kind: 'pin-sent', subscriber: created, pin, purpose: 'verify' } : { kind: 'throttled' };
  }

  // Keep the name fresh, since it appears in the subject line.
  db.prepare('UPDATE subscribers SET name = ? WHERE id = ?').run(display, existing.id);

  // An already-verified subscriber gets a manage code rather than being
  // re-verified; an unsubscribed one is returned to pending.
  const purpose: PinPurpose = existing.status === 'active' ? 'manage' : 'verify';
  if (existing.status === 'unsubscribed') {
    db.prepare("UPDATE subscribers SET status = 'pending' WHERE id = ?").run(existing.id);
  }

  const pin = issuePin(existing.id, purpose);
  const refreshed = findById(existing.id);
  if (!pin || !refreshed) return { kind: 'throttled' };
  return { kind: 'pin-sent', subscriber: refreshed, pin, purpose };
}

// ---------------------------------------------------------------------------
// Admin actions and lifecycle
// ---------------------------------------------------------------------------

export function setSourceLimit(subscriberId: number, limit: number | null): void {
  db.prepare('UPDATE subscribers SET source_limit = ? WHERE id = ?').run(limit, subscriberId);
}

export function setStatus(subscriberId: number, status: SubscriberStatus): void {
  if (status === 'unsubscribed') {
    db.prepare(
      "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?",
    ).run(subscriberId);
    return;
  }
  db.prepare('UPDATE subscribers SET status = ?, unsubscribed_at = NULL WHERE id = ?').run(
    status,
    subscriberId,
  );
}

export function deleteSubscriber(subscriberId: number): void {
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(subscriberId);
}

export function markDigestSent(subscriberId: number): void {
  db.prepare("UPDATE subscribers SET last_digest_sent_at = datetime('now') WHERE id = ?").run(
    subscriberId,
  );
}

// ---------------------------------------------------------------------------
// Signed links for email footers
// ---------------------------------------------------------------------------

export function manageToken(subscriber: Subscriber): string {
  return signedToken(`manage:${subscriber.id}:${subscriber.email_normalised}`);
}

export function unsubscribeToken(subscriber: Subscriber): string {
  return signedToken(`unsub:${subscriber.id}:${subscriber.email_normalised}`);
}

/** Resolve a signed link token back to a subscriber, verifying the purpose. */
export function subscriberFromToken(
  token: string,
  expected: 'manage' | 'unsub',
): Subscriber | null {
  const payload = verifySignedToken(token);
  if (!payload) return null;
  const [purpose, idPart, emailPart] = payload.split(':');
  if (purpose !== expected) return null;
  const id = Number(idPart);
  if (!Number.isInteger(id)) return null;
  const subscriber = findById(id);
  if (!subscriber) return null;
  // Binding the email means the link stops working if the address changes.
  if (subscriber.email_normalised !== emailPart) return null;
  return subscriber;
}

export function manageUrl(subscriber: Subscriber): string {
  return `${config.BASE_URL.replace(/\/+$/, '')}/manage/${manageToken(subscriber)}`;
}

export function unsubscribeUrl(subscriber: Subscriber): string {
  return `${config.BASE_URL.replace(/\/+$/, '')}/unsubscribe/${unsubscribeToken(subscriber)}`;
}
