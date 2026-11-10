import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, migrate, setSetting, SETTING_KEYS } from '../src/db/index.js';
import {
  isValidTimeZone,
  localParts,
  offsetLabel,
  supportedTimeZones,
} from '../src/util/timezone.js';
import {
  checkPin,
  defaultSendHour,
  effectiveSendHour,
  findByEmail,
  isDue,
  resolveTimezone,
  setSendHour,
  setTimezone,
  startSignup,
  type Subscriber,
} from '../src/services/subscribers.js';
import { dateStamp, digestSubject } from '../src/services/templates.js';

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  db.exec('DELETE FROM verification_pins; DELETE FROM subscribers;');
  setSetting(SETTING_KEYS.sendHour, '7');
});

describe('isValidTimeZone', () => {
  it('accepts canonical IANA names', () => {
    for (const zone of ['Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it('rejects anything the runtime does not know', () => {
    for (const bad of ['', '   ', 'Mars/Olympus_Mons', 'GMT+8', 'SGT', 'not a zone', '../../etc']) {
      expect(isValidTimeZone(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('supportedTimeZones', () => {
  it('returns a sorted list containing the common zones', () => {
    const zones = supportedTimeZones();
    expect(zones.length).toBeGreaterThan(300);
    expect(zones).toContain('Asia/Singapore');
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });
});

describe('localParts', () => {
  it('reports the local date and wall-clock time', () => {
    // 23:00Z on the 10th is 07:00 on the 11th in Singapore.
    expect(localParts(new Date('2026-11-10T23:00:00Z'), 'Asia/Singapore')).toEqual({
      date: '2026-11-11',
      hour: 7,
      minute: 0,
    });
  });

  it('handles offsets that are not whole hours', () => {
    expect(localParts(new Date('2026-11-11T01:30:00Z'), 'Asia/Kolkata')).toEqual({
      date: '2026-11-11',
      hour: 7,
      minute: 0,
    });
    expect(localParts(new Date('2026-11-11T01:15:00Z'), 'Asia/Kathmandu')).toEqual({
      date: '2026-11-11',
      hour: 7,
      minute: 0,
    });
  });

  it('reports midnight as hour 0, not 24', () => {
    expect(localParts(new Date('2026-11-10T16:00:00Z'), 'Asia/Singapore').hour).toBe(0);
  });

  it('follows daylight saving transitions', () => {
    // London is GMT in January and BST (UTC+1) in July.
    expect(localParts(new Date('2026-01-15T07:00:00Z'), 'Europe/London').hour).toBe(7);
    expect(localParts(new Date('2026-07-15T06:00:00Z'), 'Europe/London').hour).toBe(7);
  });

  it('crosses the date line correctly', () => {
    // UTC+14: still the 10th in UTC, already the 11th there.
    const parts = localParts(new Date('2026-11-10T17:00:00Z'), 'Pacific/Kiritimati');
    expect(parts).toEqual({ date: '2026-11-11', hour: 7, minute: 0 });

    // UTC-11: still the 10th there when UTC has moved on.
    expect(localParts(new Date('2026-11-11T05:00:00Z'), 'Pacific/Niue').date).toBe('2026-11-10');
  });
});

describe('offsetLabel', () => {
  it('formats the current offset', () => {
    expect(offsetLabel('Asia/Singapore', new Date('2026-11-11T00:00:00Z'))).toBe('UTC+08:00');
    expect(offsetLabel('Asia/Kolkata', new Date('2026-11-11T00:00:00Z'))).toBe('UTC+05:30');
    expect(offsetLabel('America/New_York', new Date('2026-01-11T00:00:00Z'))).toBe('UTC-05:00');
  });

  it('renders zero offset as UTC+00:00 rather than bare GMT', () => {
    expect(offsetLabel('Europe/London', new Date('2026-01-11T00:00:00Z'))).toBe('UTC+00:00');
  });

  it('returns an empty string for an unknown zone instead of throwing', () => {
    expect(offsetLabel('Mars/Olympus_Mons')).toBe('');
  });
});

describe('resolveTimezone', () => {
  it('keeps a valid zone', () => {
    expect(resolveTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimezone('  Europe/Berlin  ')).toBe('Europe/Berlin');
  });

  it('falls back to the configured default for anything invalid', () => {
    for (const bad of [undefined, null, '', 'SGT', 'Mars/Olympus_Mons']) {
      expect(resolveTimezone(bad)).toBe('Asia/Singapore');
    }
  });
});

describe('setTimezone', () => {
  function subscriber(): Subscriber {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const verified = checkPin('person@example.test', outcome.pin, 'verify');
    if (!verified.ok) throw new Error('expected verification to succeed');
    return verified.subscriber;
  }

  it('stores a valid zone', () => {
    const s = subscriber();
    expect(setTimezone(s.id, 'Europe/London')).toBe(true);
    expect(findByEmail('person@example.test')?.timezone).toBe('Europe/London');
  });

  it('refuses an invalid zone and leaves the stored value alone', () => {
    const s = subscriber();
    expect(setTimezone(s.id, 'Mars/Olympus_Mons')).toBe(false);
    expect(setTimezone(s.id, '')).toBe(false);
    expect(findByEmail('person@example.test')?.timezone).toBe('Asia/Singapore');
  });
});

describe('sign-up timezone', () => {
  it('records a valid timezone chosen on the form', () => {
    const outcome = startSignup('Sunny', 'person@example.test', 'Europe/Lisbon');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(outcome.subscriber.timezone).toBe('Europe/Lisbon');
  });

  it('falls back to the default when none is given or it is bogus', () => {
    const a = startSignup('A', 'a@example.test');
    if (a.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(a.subscriber.timezone).toBe('Asia/Singapore');

    const b = startSignup('B', 'b@example.test', 'Mars/Olympus_Mons');
    if (b.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(b.subscriber.timezone).toBe('Asia/Singapore');
  });

  it('does not wipe a chosen zone when a returning subscriber submits none', () => {
    const first = startSignup('Sunny', 'person@example.test', 'Europe/London');
    if (first.kind !== 'pin-sent') throw new Error('expected a PIN');
    checkPin('person@example.test', first.pin, 'verify');

    startSignup('Sunny', 'person@example.test');
    expect(findByEmail('person@example.test')?.timezone).toBe('Europe/London');
  });
});

describe('isDue', () => {
  const base: Subscriber = {
    id: 1,
    email: 'person@example.test',
    email_index: 'a'.repeat(64),
    name: 'Sunny',
    status: 'active',
    source_limit: null,
    timezone: 'Asia/Singapore',
    created_at: '2026-11-01 00:00:00',
    verified_at: '2026-11-01 00:00:00',
    unsubscribed_at: null,
    last_digest_sent_at: null,
    last_digest_local_date: null,
  };

  it('is due at the send hour in the subscriber\'s own zone', () => {
    expect(isDue(base, { now: new Date('2026-11-10T23:00:00Z') }).due).toBe(true);
  });

  it('is not due before the send hour', () => {
    const check = isDue(base, { now: new Date('2026-11-10T22:00:00Z') });
    expect(check.due).toBe(false);
    if (!check.due) expect(check.reason).toMatch(/before their send hour/);
  });

  it('is not due once the catch-up window has passed', () => {
    // 12:00 Singapore, with a send hour of 7 and a four-hour window.
    const check = isDue(base, { now: new Date('2026-11-11T04:00:00Z') });
    expect(check.due).toBe(false);
    if (!check.due) expect(check.reason).toMatch(/catch-up window/);
  });

  it('is still due inside the catch-up window', () => {
    // 10:59 Singapore.
    expect(isDue(base, { now: new Date('2026-11-11T02:59:00Z') }).due).toBe(true);
  });

  it('is never due in the middle of the night', () => {
    for (const hourZ of ['16:00', '17:00', '18:00', '19:00', '20:00']) {
      // 00:00 to 04:00 Singapore.
      const check = isDue(base, { now: new Date(`2026-11-10T${hourZ}:00Z`) });
      expect(check.due, hourZ).toBe(false);
    }
  });

  it('is not due twice on the same local date', () => {
    const sent = { ...base, last_digest_local_date: '2026-11-11' };
    const check = isDue(sent, { now: new Date('2026-11-10T23:00:00Z') });
    expect(check.due).toBe(false);
    if (!check.due) expect(check.reason).toMatch(/already sent/);
  });

  it('is due again the next local day', () => {
    const sent = { ...base, last_digest_local_date: '2026-11-11' };
    expect(isDue(sent, { now: new Date('2026-11-11T23:00:00Z') }).due).toBe(true);
  });

  it('tracks daylight saving, so the local hour stays 07:00 year round', () => {
    const london = { ...base, timezone: 'Europe/London' };
    // Winter: 07:00 local is 07:00Z.
    expect(isDue(london, { now: new Date('2026-01-15T07:00:00Z') }).due).toBe(true);
    expect(isDue(london, { now: new Date('2026-01-15T06:00:00Z') }).due).toBe(false);
    // Summer: 07:00 local is 06:00Z.
    expect(isDue(london, { now: new Date('2026-07-15T06:00:00Z') }).due).toBe(true);
    expect(isDue(london, { now: new Date('2026-07-15T05:00:00Z') }).due).toBe(false);
  });

  it('treats an unrecognised stored zone as the default rather than failing', () => {
    const broken = { ...base, timezone: 'Mars/Olympus_Mons' };
    expect(isDue(broken, { now: new Date('2026-11-10T23:00:00Z') }).due).toBe(true);
  });

  it('respects a changed send hour', () => {
    setSetting(SETTING_KEYS.sendHour, '18');
    expect(defaultSendHour()).toBe(18);
    // 18:00 Singapore is 10:00Z.
    expect(isDue(base, { now: new Date('2026-11-11T10:00:00Z') }).due).toBe(true);
    expect(isDue(base, { now: new Date('2026-11-10T23:00:00Z') }).due).toBe(false);
  });

  it('does not let a late send hour spill past midnight', () => {
    setSetting(SETTING_KEYS.sendHour, '23');
    // 23:00 Singapore is due; 02:00 the next local day is not, even though it
    // is within four hours of the send hour.
    expect(isDue(base, { now: new Date('2026-11-11T15:00:00Z') }).due).toBe(true);
    expect(isDue(base, { now: new Date('2026-11-11T18:00:00Z') }).due).toBe(false);
  });
});

describe('per-subscriber send hour', () => {
  function subscriber(email = 'person@example.test'): Subscriber {
    const outcome = startSignup('Sunny', email);
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const verified = checkPin(email, outcome.pin, 'verify');
    if (!verified.ok) throw new Error('expected verification to succeed');
    return verified.subscriber;
  }

  it('follows the global default until a choice is made', () => {
    const s = subscriber();
    expect(s.send_hour).toBeNull();
    expect(effectiveSendHour(s)).toBe(7);

    setSetting(SETTING_KEYS.sendHour, '6');
    expect(effectiveSendHour(s)).toBe(6);
  });

  it('prefers the subscriber\'s own hour over the default', () => {
    const s = subscriber();
    expect(setSendHour(s.id, 21)).toBe(true);
    const updated = findByEmail('person@example.test') as Subscriber;
    expect(updated.send_hour).toBe(21);
    expect(effectiveSendHour(updated)).toBe(21);

    // Changing the default no longer moves them.
    setSetting(SETTING_KEYS.sendHour, '6');
    expect(effectiveSendHour(updated)).toBe(21);
  });

  it('clears the override back to the default', () => {
    const s = subscriber();
    setSendHour(s.id, 21);
    expect(setSendHour(s.id, null)).toBe(true);
    const updated = findByEmail('person@example.test') as Subscriber;
    expect(updated.send_hour).toBeNull();
    expect(effectiveSendHour(updated)).toBe(7);
  });

  it('accepts every hour of the day, including the boundaries', () => {
    const s = subscriber();
    for (const hour of [0, 1, 12, 22, 23]) {
      expect(setSendHour(s.id, hour), String(hour)).toBe(true);
      expect(effectiveSendHour(findByEmail('person@example.test') as Subscriber)).toBe(hour);
    }
  });

  it('refuses an hour outside 0-23 and leaves the stored value alone', () => {
    const s = subscriber();
    setSendHour(s.id, 9);
    for (const bad of [-1, 24, 25, 7.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setSendHour(s.id, bad), String(bad)).toBe(false);
    }
    expect((findByEmail('person@example.test') as Subscriber).send_hour).toBe(9);
  });

  it('is recorded at sign-up when chosen', () => {
    const outcome = startSignup('Sunny', 'person@example.test', 'Europe/London', 18);
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(outcome.subscriber.send_hour).toBe(18);
    expect(effectiveSendHour(outcome.subscriber)).toBe(18);
  });

  it('is left to the default when not chosen or out of range at sign-up', () => {
    const a = startSignup('A', 'a@example.test', 'Europe/London');
    if (a.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(a.subscriber.send_hour).toBeNull();

    const b = startSignup('B', 'b@example.test', 'Europe/London', 99);
    if (b.kind !== 'pin-sent') throw new Error('expected a PIN');
    expect(b.subscriber.send_hour).toBeNull();
  });

  it('does not wipe a chosen hour when a returning subscriber submits none', () => {
    const first = startSignup('Sunny', 'person@example.test', 'Asia/Singapore', 20);
    if (first.kind !== 'pin-sent') throw new Error('expected a PIN');
    checkPin('person@example.test', first.pin, 'verify');

    startSignup('Sunny', 'person@example.test');
    expect((findByEmail('person@example.test') as Subscriber).send_hour).toBe(20);
  });

  it('decides due-ness by the subscriber\'s own hour', () => {
    const s = subscriber();
    setSendHour(s.id, 20);
    const updated = findByEmail('person@example.test') as Subscriber;

    // 07:00 Singapore, the global default, is no longer their hour.
    expect(isDue(updated, { now: new Date('2026-11-10T23:00:00Z') }).due).toBe(false);
    // 20:00 Singapore is 12:00Z.
    expect(isDue(updated, { now: new Date('2026-11-11T12:00:00Z') }).due).toBe(true);
  });

  it('applies the catch-up window to the chosen hour, not the default', () => {
    const s = subscriber();
    setSendHour(s.id, 20);
    const updated = findByEmail('person@example.test') as Subscriber;

    // 23:59 Singapore is still inside four hours of 20:00.
    expect(isDue(updated, { now: new Date('2026-11-11T15:59:00Z') }).due).toBe(true);
    // 00:00 the next local day is not: the window never crosses midnight.
    expect(isDue(updated, { now: new Date('2026-11-11T16:00:00Z') }).due).toBe(false);
  });

  it('lets two subscribers in one zone receive at different hours', () => {
    const early = subscriber('early@example.test');
    const late = subscriber('late@example.test');
    setSendHour(early.id, 7);
    setSendHour(late.id, 19);

    const earlyRow = findByEmail('early@example.test') as Subscriber;
    const lateRow = findByEmail('late@example.test') as Subscriber;

    const morning = new Date('2026-11-10T23:00:00Z'); // 07:00 Singapore
    expect(isDue(earlyRow, { now: morning }).due).toBe(true);
    expect(isDue(lateRow, { now: morning }).due).toBe(false);

    const evening = new Date('2026-11-11T11:00:00Z'); // 19:00 Singapore
    expect(isDue(earlyRow, { now: evening }).due).toBe(false);
    expect(isDue(lateRow, { now: evening }).due).toBe(true);
  });

  it('combines a chosen hour with a chosen timezone', () => {
    const s = subscriber();
    setSendHour(s.id, 6);
    setTimezone(s.id, 'America/New_York');
    const updated = findByEmail('person@example.test') as Subscriber;

    // 06:00 New York in November (EST, UTC-5) is 11:00Z.
    expect(isDue(updated, { now: new Date('2026-11-11T11:00:00Z') }).due).toBe(true);
    // 06:00 Singapore would be 22:00Z the day before; not their hour.
    expect(isDue(updated, { now: new Date('2026-11-10T22:00:00Z') }).due).toBe(false);
  });
});

describe('subject-line date in the subscriber\'s timezone', () => {
  it('uses the local date, which can differ from the server date', () => {
    const instant = new Date('2026-11-10T17:00:00Z');
    // UTC is still the 10th; UTC+14 is already the 11th.
    expect(dateStamp(instant, 'UTC')).toBe('20261110');
    expect(dateStamp(instant, 'Pacific/Kiritimati')).toBe('20261111');

    expect(digestSubject('Sunny', instant, 'Pacific/Kiritimati')).toBe(
      '[20261111] - Top News Update for Sunny',
    );
    expect(digestSubject('Sunny', instant, 'Pacific/Niue')).toBe(
      '[20261110] - Top News Update for Sunny',
    );
  });
});
