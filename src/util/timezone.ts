/**
 * Per-subscriber timezone handling.
 *
 * The digest is sent at the same local hour for everyone, in each
 * subscriber's own timezone, so nobody is woken in the middle of the night.
 * All arithmetic goes through Intl, which carries the IANA database and
 * therefore handles daylight saving transitions and offsets that are not whole
 * hours (India at +05:30, Nepal at +05:45) without special cases.
 */

/** Zones offered in the picker. Canonical IANA names, from the runtime's own data. */
let cachedZones: string[] | null = null;

export function supportedTimeZones(): string[] {
  if (!cachedZones) {
    cachedZones = [...Intl.supportedValuesOf('timeZone')].sort((a, b) => a.localeCompare(b));
  }
  return cachedZones;
}

const validityCache = new Map<string, boolean>();

/** True when the string is a timezone this runtime recognises. */
export function isValidTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (trimmed === '') return false;
  const cached = validityCache.get(trimmed);
  if (cached !== undefined) return cached;

  let valid: boolean;
  try {
    // Throws RangeError for anything the runtime does not know.
    new Intl.DateTimeFormat('en', { timeZone: trimmed }).format(new Date());
    valid = true;
  } catch {
    valid = false;
  }
  validityCache.set(trimmed, valid);
  return valid;
}

export type LocalParts = {
  /** Local calendar date as YYYY-MM-DD. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  /** Local minute, 0-59. */
  minute: number;
};

/**
 * The local date and wall-clock time in a given zone.
 * en-CA gives ISO-ordered date parts, and hourCycle h23 avoids the "24" that
 * en-GB returns at midnight.
 */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
  };
}

/** Current UTC offset of a zone, formatted for display, e.g. "UTC+08:00". */
export function offsetLabel(timeZone: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // longOffset yields "GMT+08:00"; present it as UTC, and GMT alone as +00:00.
    if (name === 'GMT') return 'UTC+00:00';
    return name.replace(/^GMT/, 'UTC');
  } catch {
    return '';
  }
}
