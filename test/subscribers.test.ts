import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolve every hostname to a public address. These tests exercise the
 * subscriber and source logic, not DNS, and the sandbox has no resolver.
 * The SSRF guard itself is tested against literal addresses in
 * urlGuard.test.ts, which needs no DNS.
 */
vi.mock('node:dns/promises', () => {
  // Defined inside the factory: vi.mock is hoisted above module-level consts.
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { default: { lookup }, lookup };
});

import { db, migrate, setSetting, SETTING_KEYS } from '../src/db/index.js';
import {
  checkPin,
  effectiveSourceLimit,
  findByEmail,
  issuePin,
  normaliseEmail,
  PIN_MAX_ATTEMPTS,
  setSourceLimit,
  setStatus,
  startSignup,
  subscriberFromToken,
  manageToken,
  unsubscribeToken,
} from '../src/services/subscribers.js';
import { addSource, countSources, listSources, removeSource } from '../src/services/sources.js';
import { login, setAdminPassword, sessionIsValid, logout } from '../src/services/admin.js';

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM sent_stories; DELETE FROM deliveries; DELETE FROM sources; DELETE FROM verification_pins; DELETE FROM subscribers; DELETE FROM admin_sessions; DELETE FROM admin_users;');
  setSetting(SETTING_KEYS.defaultSourceLimit, '5');
});

describe('normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Person@Example.TEST ')).toBe('person@example.test');
  });
});

describe('signup and verification', () => {
  it('creates a pending subscriber and issues a verify PIN', () => {
    const outcome = startSignup('Sunny', 'person@example.test');
    expect(outcome.kind).toBe('pin-sent');
    if (outcome.kind !== 'pin-sent') return;

    expect(outcome.purpose).toBe('verify');
    expect(outcome.pin).toMatch(/^\d{6}$/);
    expect(outcome.subscriber.status).toBe('pending');
    expect(outcome.subscriber.name).toBe('Sunny');
  });

  it('activates the subscriber on a correct PIN', () => {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');

    const result = checkPin('person@example.test', outcome.pin, 'verify');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriber.status).toBe('active');
    expect(result.subscriber.verified_at).not.toBeNull();
  });

  it('does not store the PIN in plaintext', () => {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const row = db.prepare('SELECT pin_hash FROM verification_pins LIMIT 1').get() as { pin_hash: string };
    expect(row.pin_hash).not.toContain(outcome.pin);
    expect(row.pin_hash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a wrong PIN and locks out after too many attempts', () => {
    startSignup('Sunny', 'person@example.test');

    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
      const result = checkPin('person@example.test', '000000', 'verify');
      expect(result.ok).toBe(false);
    }
    const final = checkPin('person@example.test', '000000', 'verify');
    expect(final.ok).toBe(false);
    if (!final.ok) expect(final.reason).toMatch(/too many/i);

    // Even the correct PIN no longer works once the attempt budget is spent.
    const row = db.prepare('SELECT consumed_at FROM verification_pins ORDER BY id DESC LIMIT 1').get() as {
      consumed_at: string | null;
    };
    expect(row.consumed_at).not.toBeNull();
  });

  it('gives the same generic answer for an address that does not exist', () => {
    const result = checkPin('nobody@example.test', '123456', 'verify');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid/i);
  });

  it('invalidates an earlier PIN when a new one is issued', () => {
    const first = startSignup('Sunny', 'person@example.test');
    if (first.kind !== 'pin-sent') throw new Error('expected a PIN');

    const subscriber = findByEmail('person@example.test');
    expect(subscriber).not.toBeNull();
    const second = issuePin(subscriber!.id, 'verify');
    expect(second).not.toBeNull();

    // The superseded code must no longer work.
    expect(checkPin('person@example.test', first.pin, 'verify').ok).toBe(false);
    expect(checkPin('person@example.test', second as string, 'verify').ok).toBe(true);
  });

  it('throttles repeated PIN requests for the same address', () => {
    startSignup('Sunny', 'person@example.test');
    startSignup('Sunny', 'person@example.test');
    startSignup('Sunny', 'person@example.test');
    const fourth = startSignup('Sunny', 'person@example.test');
    expect(fourth.kind).toBe('throttled');
  });

  it('issues a manage code, not a verify code, to an already active subscriber', () => {
    const first = startSignup('Sunny', 'person@example.test');
    if (first.kind !== 'pin-sent') throw new Error('expected a PIN');
    checkPin('person@example.test', first.pin, 'verify');

    const again = startSignup('Sunny Tan', 'person@example.test');
    expect(again.kind).toBe('pin-sent');
    if (again.kind !== 'pin-sent') return;
    expect(again.purpose).toBe('manage');
    // The display name is refreshed, since it appears in the subject line.
    expect(again.subscriber.name).toBe('Sunny Tan');
  });

  it('returns an unsubscribed address to pending on re-signup', () => {
    const first = startSignup('Sunny', 'person@example.test');
    if (first.kind !== 'pin-sent') throw new Error('expected a PIN');
    checkPin('person@example.test', first.pin, 'verify');
    setStatus(first.subscriber.id, 'unsubscribed');

    const again = startSignup('Sunny', 'person@example.test');
    expect(again.kind).toBe('pin-sent');
    if (again.kind !== 'pin-sent') return;
    expect(again.purpose).toBe('verify');
    expect(again.subscriber.status).toBe('pending');
  });
});

describe('signed manage and unsubscribe links', () => {
  function activeSubscriber() {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const result = checkPin('person@example.test', outcome.pin, 'verify');
    if (!result.ok) throw new Error('expected verification to succeed');
    return result.subscriber;
  }

  it('resolves a manage token back to the subscriber', () => {
    const subscriber = activeSubscriber();
    const resolved = subscriberFromToken(manageToken(subscriber), 'manage');
    expect(resolved?.id).toBe(subscriber.id);
  });

  it('refuses a token used for the wrong purpose', () => {
    const subscriber = activeSubscriber();
    expect(subscriberFromToken(manageToken(subscriber), 'unsub')).toBeNull();
    expect(subscriberFromToken(unsubscribeToken(subscriber), 'manage')).toBeNull();
  });

  it('refuses a forged or truncated token', () => {
    const subscriber = activeSubscriber();
    const token = manageToken(subscriber);
    expect(subscriberFromToken(token.slice(0, -3) + 'aaa', 'manage')).toBeNull();
    expect(subscriberFromToken('garbage', 'manage')).toBeNull();
  });
});

describe('sources and the admin-controlled limit', () => {
  function activeSubscriber() {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const result = checkPin('person@example.test', outcome.pin, 'verify');
    if (!result.ok) throw new Error('expected verification to succeed');
    return result.subscriber;
  }

  it('uses the global default when no per-subscriber override is set', () => {
    const subscriber = activeSubscriber();
    expect(effectiveSourceLimit(subscriber)).toBe(5);

    setSetting(SETTING_KEYS.defaultSourceLimit, '3');
    expect(effectiveSourceLimit(subscriber)).toBe(3);
  });

  it('prefers a per-subscriber override over the default', () => {
    const subscriber = activeSubscriber();
    setSourceLimit(subscriber.id, 1);
    const refreshed = findByEmail('person@example.test');
    expect(effectiveSourceLimit(refreshed!)).toBe(1);
  });

  it('refuses a non-HTTPS source', async () => {
    const subscriber = activeSubscriber();
    const result = await addSource(subscriber, 'http://example.com/news');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/i);
    expect(countSources(subscriber.id)).toBe(0);
  });

  it('refuses a source pointing at a private address', async () => {
    const subscriber = activeSubscriber();
    const result = await addSource(subscriber, 'https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
    expect(countSources(subscriber.id)).toBe(0);
  });

  it('enforces the limit when adding', async () => {
    const subscriber = activeSubscriber();
    setSourceLimit(subscriber.id, 1);
    const refreshed = findByEmail('person@example.test')!;

    const first = await addSource(refreshed, 'https://example.com/news');
    expect(first.ok).toBe(true);

    const second = await addSource(refreshed, 'https://example.org/news');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/limit of 1/);
    expect(countSources(refreshed.id)).toBe(1);
  });

  it('refuses the same source twice', async () => {
    const subscriber = activeSubscriber();
    expect((await addSource(subscriber, 'https://example.com/news')).ok).toBe(true);
    const duplicate = await addSource(subscriber, 'https://example.com/news');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toMatch(/already/i);
  });

  it('removes only the subscriber\'s own source', async () => {
    const subscriber = activeSubscriber();
    const added = await addSource(subscriber, 'https://example.com/news');
    if (!added.ok) throw new Error('expected the source to be added');

    // A different subscriber must not be able to delete it.
    const other = startSignup('Other', 'other@example.test');
    if (other.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(removeSource(other.subscriber.id, added.source.id)).toBe(false);
    expect(listSources(subscriber.id)).toHaveLength(1);

    expect(removeSource(subscriber.id, added.source.id)).toBe(true);
    expect(listSources(subscriber.id)).toHaveLength(0);
  });
});

describe('admin authentication', () => {
  const password = 'a-long-enough-admin-password';

  it('rejects a password below the minimum length', () => {
    const result = setAdminPassword('short');
    expect(result.ok).toBe(false);
  });

  it('signs in with the bound email and correct password', () => {
    expect(setAdminPassword(password).ok).toBe(true);
    const result = login('admin@example.test', password);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sessionIsValid(result.token)).toBe(true);
  });

  it('refuses any other email, even with the correct password', () => {
    setAdminPassword(password);
    const result = login('someone.else@example.test', password);
    expect(result.ok).toBe(false);
  });

  it('refuses a wrong password', () => {
    setAdminPassword(password);
    expect(login('admin@example.test', 'wrong-but-long-enough').ok).toBe(false);
  });

  it('locks the account after repeated failures', () => {
    setAdminPassword(password);
    for (let i = 0; i < 5; i++) login('admin@example.test', 'wrong-but-long-enough');
    const result = login('admin@example.test', password);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too many/i);
  });

  it('stores only a hash of the session token', () => {
    setAdminPassword(password);
    const result = login('admin@example.test', password);
    if (!result.ok) throw new Error('expected sign-in to succeed');
    const row = db.prepare('SELECT token_hash FROM admin_sessions LIMIT 1').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(result.token);
  });

  it('invalidates the session on sign-out', () => {
    setAdminPassword(password);
    const result = login('admin@example.test', password);
    if (!result.ok) throw new Error('expected sign-in to succeed');
    logout(result.token);
    expect(sessionIsValid(result.token)).toBe(false);
  });

  it('invalidates existing sessions when the password changes', () => {
    setAdminPassword(password);
    const result = login('admin@example.test', password);
    if (!result.ok) throw new Error('expected sign-in to succeed');
    setAdminPassword('another-long-enough-password');
    expect(sessionIsValid(result.token)).toBe(false);
  });

  it('rejects an empty or unknown session token', () => {
    expect(sessionIsValid(undefined)).toBe(false);
    expect(sessionIsValid('nonsense')).toBe(false);
  });
});
