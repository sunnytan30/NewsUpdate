import fs from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, getSetting, migrate, SETTING_KEYS } from '../src/db/index.js';
import {
  blindIndex,
  decryptField,
  encryptField,
  FIELD,
  isFieldEncryptionReady,
  keyFingerprint,
} from '../src/util/encryption.js';
import { signedToken } from '../src/util/crypto.js';
import {
  checkPin,
  emailIndex,
  findByEmail,
  manageToken,
  normaliseEmail,
  startSignup,
  subscriberFromToken,
  unsubscribeToken,
} from '../src/services/subscribers.js';

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM verification_pins; DELETE FROM subscribers;');
});

describe('field encryption primitives', () => {
  it('is initialised from configuration', () => {
    expect(isFieldEncryptionReady()).toBe(true);
  });

  it('round-trips a value', () => {
    const stored = encryptField('person@example.test', FIELD.subscriberEmail);
    expect(decryptField(stored, FIELD.subscriberEmail)).toBe('person@example.test');
  });

  it('never contains the plaintext', () => {
    const stored = encryptField('person@example.test', FIELD.subscriberEmail);
    expect(stored).not.toContain('person');
    expect(stored).not.toContain('example.test');
    expect(stored).not.toContain('@');
  });

  it('produces a different ciphertext every time', () => {
    const a = encryptField('person@example.test', FIELD.subscriberEmail);
    const b = encryptField('person@example.test', FIELD.subscriberEmail);
    expect(a).not.toBe(b);
    // Both still decrypt to the same value.
    expect(decryptField(a, FIELD.subscriberEmail)).toBe(decryptField(b, FIELD.subscriberEmail));
  });

  it('handles unicode and empty values', () => {
    for (const value of ['', 'tan.wei.ming@example.test', 'ünïcøde+tag@example.test', '陳@example.test']) {
      const stored = encryptField(value, FIELD.subscriberEmail);
      expect(decryptField(stored, FIELD.subscriberEmail), value).toBe(value);
    }
  });

  it('refuses a ciphertext whose contents were altered', () => {
    const stored = encryptField('person@example.test', FIELD.subscriberEmail);
    const parts = stored.split('.');
    // Flip a character in the ciphertext segment.
    const body = parts[3] as string;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      (body[0] === 'A' ? 'B' : 'A') + body.slice(1),
    ].join('.');
    expect(() => decryptField(tampered, FIELD.subscriberEmail)).toThrow();
  });

  it('refuses a ciphertext whose authentication tag was altered', () => {
    const stored = encryptField('person@example.test', FIELD.subscriberEmail);
    const parts = stored.split('.');
    const tag = parts[2] as string;
    const tampered = [parts[0], parts[1], (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1), parts[3]].join('.');
    expect(() => decryptField(tampered, FIELD.subscriberEmail)).toThrow();
  });

  it('refuses a ciphertext decrypted under a different context', () => {
    const stored = encryptField('person@example.test', FIELD.subscriberEmail);
    // A value cannot be lifted from one column into another.
    expect(() => decryptField(stored, 'subscribers.name')).toThrow();
  });

  it('refuses malformed stored values', () => {
    for (const bad of ['', 'nonsense', 'v1.a.b', 'v2.a.b.c', 'v1.' + 'A'.repeat(4) + '.b.c']) {
      expect(() => decryptField(bad, FIELD.subscriberEmail), bad).toThrow();
    }
  });
});

describe('encryption key fingerprint', () => {
  it('is recorded on the database and matches the configured key', () => {
    expect(getSetting(SETTING_KEYS.encryptionKeyFingerprint)).toBe(keyFingerprint());
  });

  it('is short and reveals nothing about the key', () => {
    const fingerprint = keyFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain(process.env.ENCRYPTION_KEY?.slice(0, 8) ?? 'nope');
  });

  it('refuses to migrate a database written with a different key', () => {
    // Simulate a key swap by storing someone else's fingerprint.
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(SETTING_KEYS.encryptionKeyFingerprint, 'deadbeefdeadbeef');

    expect(() => migrate()).toThrow(/does not match the key/);

    // Put it back so the rest of the suite is unaffected.
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      keyFingerprint(),
      SETTING_KEYS.encryptionKeyFingerprint,
    );
    expect(() => migrate()).not.toThrow();
  });
});

describe('blind index', () => {
  it('is deterministic for the same input', () => {
    expect(blindIndex('person@example.test', FIELD.subscriberEmail)).toBe(
      blindIndex('person@example.test', FIELD.subscriberEmail),
    );
  });

  it('differs for different inputs and different contexts', () => {
    expect(blindIndex('a@example.test', FIELD.subscriberEmail)).not.toBe(
      blindIndex('b@example.test', FIELD.subscriberEmail),
    );
    expect(blindIndex('a@example.test', FIELD.subscriberEmail)).not.toBe(
      blindIndex('a@example.test', 'subscribers.name'),
    );
  });

  it('does not reveal the plaintext', () => {
    const index = blindIndex('person@example.test', FIELD.subscriberEmail);
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(index).not.toContain('person');
  });

  it('is case- and whitespace-insensitive through emailIndex', () => {
    expect(emailIndex('  Person@Example.TEST ')).toBe(emailIndex('person@example.test'));
    expect(normaliseEmail('  Person@Example.TEST ')).toBe('person@example.test');
  });
});

describe('subscriber storage', () => {
  it('stores no plaintext address in the subscribers table', () => {
    const outcome = startSignup('Sunny', 'Person@Example.test');
    expect(outcome.kind).toBe('pin-sent');

    const row = db.prepare('SELECT * FROM subscribers').get() as Record<string, unknown>;
    // The columns themselves are gone, not merely unused.
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('email_normalised');

    const serialised = JSON.stringify(row).toLowerCase();
    expect(serialised).not.toContain('person@example.test');
    expect(serialised).not.toContain('person');
    expect(serialised).not.toContain('@');
  });

  it('round-trips the address through a lookup', () => {
    startSignup('Sunny', 'Person@Example.test');
    const found = findByEmail('person@example.test');
    expect(found).not.toBeNull();
    // Returned decrypted, preserving the capitalisation the subscriber typed.
    expect(found?.email).toBe('Person@Example.test');
  });

  it('finds a subscriber regardless of the case or spacing submitted', () => {
    startSignup('Sunny', 'Person@Example.test');
    for (const variant of ['person@example.test', 'PERSON@EXAMPLE.TEST', '  Person@Example.test  ']) {
      expect(findByEmail(variant)?.id, variant).toBeDefined();
    }
  });

  it('still enforces one subscriber per address', () => {
    const first = startSignup('Sunny', 'person@example.test');
    expect(first.kind).toBe('pin-sent');
    // A second sign-up updates the existing row rather than inserting one.
    startSignup('Sunny', 'PERSON@EXAMPLE.TEST');
    const count = db.prepare('SELECT COUNT(*) AS n FROM subscribers').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps no plaintext address anywhere in the database file', () => {
    const outcome = startSignup('Sunny', 'needle-address@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    checkPin('needle-address@example.test', outcome.pin, 'verify');

    // Force WAL contents to the main file so the search covers everything.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const file = db.name;
    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from('needle-address@example.test', 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from('needle-address', 'utf8'))).toBe(false);
  });
});

describe('signed links', () => {
  function activeSubscriber() {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const verified = checkPin('person@example.test', outcome.pin, 'verify');
    if (!verified.ok) throw new Error('expected verification to succeed');
    return verified.subscriber;
  }

  it('does not carry the address in the token', () => {
    const subscriber = activeSubscriber();
    for (const token of [manageToken(subscriber), unsubscribeToken(subscriber)]) {
      const decoded = Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8');
      expect(decoded).not.toContain('person');
      expect(decoded).not.toContain('@');
      expect(decoded).not.toContain('example.test');
    }
  });

  it('still resolves to the right subscriber', () => {
    const subscriber = activeSubscriber();
    expect(subscriberFromToken(manageToken(subscriber), 'manage')?.id).toBe(subscriber.id);
    expect(subscriberFromToken(unsubscribeToken(subscriber), 'unsub')?.id).toBe(subscriber.id);
  });

  it('expires a manage link after its window, but never an unsubscribe link', () => {
    const subscriber = activeSubscriber();
    const issued = new Date('2026-01-01T00:00:00Z');
    const manage = manageToken(subscriber, issued);
    const unsub = unsubscribeToken(subscriber);

    const withinWindow = new Date(issued.getTime() + 29 * 24 * 3600_000);
    const pastWindow = new Date(issued.getTime() + 31 * 24 * 3600_000);

    expect(subscriberFromToken(manage, 'manage', withinWindow)?.id).toBe(subscriber.id);
    expect(subscriberFromToken(manage, 'manage', pastWindow)).toBeNull();

    // Someone must always be able to stop unwanted mail, however old.
    const yearsLater = new Date(issued.getTime() + 3 * 365 * 24 * 3600_000);
    expect(subscriberFromToken(unsub, 'unsub', yearsLater)?.id).toBe(subscriber.id);
  });

  it('refuses a manage token with no issued-at, so the check cannot be skipped', () => {
    const subscriber = activeSubscriber();
    // A token in the old three-field shape must not be accepted.
    const legacy = signedToken(`manage:${subscriber.id}:${subscriber.email_index.slice(0, 32)}`);
    expect(subscriberFromToken(legacy, 'manage')).toBeNull();
  });

  it('refuses a manage token issued implausibly far in the future', () => {
    const subscriber = activeSubscriber();
    const future = new Date(Date.now() + 10 * 24 * 3600_000);
    expect(subscriberFromToken(manageToken(subscriber, future), 'manage')).toBeNull();
  });

  it('tolerates a small amount of clock skew', () => {
    const subscriber = activeSubscriber();
    const slightlyAhead = new Date(Date.now() + 60_000);
    expect(subscriberFromToken(manageToken(subscriber, slightlyAhead), 'manage')?.id).toBe(
      subscriber.id,
    );
  });

  it('refuses a manage token whose issued-at was tampered with', () => {
    const subscriber = activeSubscriber();
    const token = manageToken(subscriber, new Date('2026-01-01T00:00:00Z'));
    const payload = Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8');
    const forged = payload.replace(/:\d+$/, `:${Math.floor(Date.now() / 1000)}`);
    // Re-encoding the payload without re-signing must fail the signature check.
    const reassembled =
      Buffer.from(forged, 'utf8').toString('base64url') + '.' + (token.split('.')[1] as string);
    expect(subscriberFromToken(reassembled, 'manage')).toBeNull();
  });

  it('stops working if the stored address changes', () => {
    const subscriber = activeSubscriber();
    const token = manageToken(subscriber);
    expect(subscriberFromToken(token, 'manage')).not.toBeNull();

    // Simulate the address being changed underneath the link.
    db.prepare('UPDATE subscribers SET email_index = ? WHERE id = ?').run(
      emailIndex('someone.else@example.test'),
      subscriber.id,
    );
    expect(subscriberFromToken(token, 'manage')).toBeNull();
  });
});
