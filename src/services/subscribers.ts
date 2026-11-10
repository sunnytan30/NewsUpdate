import { db, getSettingInt, SETTING_KEYS } from '../db/index.js';
import { hashSecret, randomPin, verifySecret, signedToken, verifySignedToken } from '../util/crypto.js';
import { config } from '../config.js';
import { isValidTimeZone, localParts } from '../util/timezone.js';

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
  /** IANA timezone; the digest is sent at the configured local hour here. */
  timezone: string;
  created_at: string;
  verified_at: string | null;
  unsubscribed_at: string | null;
  last_digest_sent_at: string | null;
  /** Local date (YYYY-MM-DD in `timezone`) of the last digest sent. */
  last_digest_local_date: string | null;
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
// Timezone and send scheduling
// ---------------------------------------------------------------------------

/**
 * How many hours after the send hour a digest may still go out.
 *
 * Without a window, a service that was down at the send hour would skip the
 * day entirely. With one, it catches up as soon as it is back — but stops well
 * before the evening, so a long outage never results in a 2am email.
 */
export const SEND_CATCHUP_HOURS = 4;

/** The configured send hour, clamped to a valid hour of the day. */
export function sendHour(): number {
  const hour = getSettingInt(SETTING_KEYS.sendHour, config.DEFAULT_SEND_HOUR);
  return Math.min(23, Math.max(0, hour));
}

/** Resolve a user-supplied timezone, falling back to the configured default. */
export function resolveTimezone(input: string | undefined | null): string {
  const candidate = (input ?? '').trim();
  return isValidTimeZone(candidate) ? candidate : config.DEFAULT_TIMEZONE;
}

export function setTimezone(subscriberId: number, timezone: string): boolean {
  if (!isValidTimeZone(timezone)) return false;
  db.prepare('UPDATE subscribers SET timezone = ? WHERE id = ?').run(timezone.trim(), subscriberId);
  return true;
}

export type DueCheck = { due: true } | { due: false; reason: string };

/**
 * Whether this subscriber should receive a digest now.
 *
 * Due when their local clock has reached the send hour, is still inside the
 * catch-up window, and they have not already been sent a digest on their own
 * local calendar date. Evaluating the date in the subscriber's zone is what
 * makes "once a day" mean once a day *for them*.
 */
export function isDue(
  subscriber: Subscriber,
  options: { now?: Date; hour?: number; catchupHours?: number } = {},
): DueCheck {
  const now = options.now ?? new Date();
  const target = options.hour ?? sendHour();
  const catchup = options.catchupHours ?? SEND_CATCHUP_HOURS;

  const local = localParts(now, resolveTimezone(subscriber.timezone));

  if (subscriber.last_digest_local_date === local.date) {
    return { due: false, reason: 'already sent today in their timezone' };
  }
  if (local.hour < target) {
    return { due: false, reason: `local time ${local.hour}:00 is before the send hour` };
  }
  // Cap at midnight so a late send hour does not spill into the next day.
  if (local.hour >= Math.min(target + catchup, 24)) {
    return { due: false, reason: 'past the catch-up window for today' };
  }
  return { due: true };
}

/** Active subscribers whose local clock says it is time to send. */
export function dueSubscribers(now = new Date()): Subscriber[] {
  const hour = sendHour();
  return activeSubscribers().filter((s) => isDue(s, { now, hour }).due);
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
export function startSignup(name: string, email: string, timezone?: string): SignupOutcome {
  const normalised = normaliseEmail(email);
  const display = cleanName(name);
  const zone = resolveTimezone(timezone);
  const existing = findByEmail(normalised);

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO subscribers (email, email_normalised, name, status, timezone)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(email.trim(), normalised, display, zone);
    const created = findById(Number(info.lastInsertRowid));
    if (!created) return { kind: 'throttled' };
    const pin = issuePin(created.id, 'verify');
    return pin ? { kind: 'pin-sent', subscriber: created, pin, purpose: 'verify' } : { kind: 'throttled' };
  }

  // Keep the name fresh, since it appears in the subject line. The timezone is
  // only overwritten when the form actually supplied a usable one, so a
  // returning subscriber does not silently lose the zone they chose.
  db.prepare('UPDATE subscribers SET name = ? WHERE id = ?').run(display, existing.id);
  if (timezone && isValidTimeZone(timezone.trim())) {
    db.prepare('UPDATE subscribers SET timezone = ? WHERE id = ?').run(timezone.trim(), existing.id);
  }

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

/**
 * Mark the subscriber as dealt with for their local day without claiming a
 * digest was sent. Used when there was nothing new to send: without it, every
 * sweep inside the catch-up window would re-fetch their sources only to find
 * the same nothing.
 *
 * A send *failure* deliberately does not stamp, so the next sweep retries.
 */
export function markDigestConsidered(subscriber: Subscriber, now = new Date()): void {
  const local = localParts(now, resolveTimezone(subscriber.timezone));
  db.prepare('UPDATE subscribers SET last_digest_local_date = ? WHERE id = ?').run(
    local.date,
    subscriber.id,
  );
}

/**
 * Record a successful send. The local date is stored alongside the timestamp
 * because "already sent today" has to be judged on the subscriber's own
 * calendar, not the server's.
 */
export function markDigestSent(subscriber: Subscriber, now = new Date()): void {
  const local = localParts(now, resolveTimezone(subscriber.timezone));
  db.prepare(
    `UPDATE subscribers
     SET last_digest_sent_at = datetime('now'), last_digest_local_date = ?
     WHERE id = ?`,
  ).run(local.date, subscriber.id);
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
