import { db } from '../db/index.js';
import { validateSourceUrl } from './urlGuard.js';
import { effectiveSourceLimit, type Subscriber } from './subscribers.js';

export type Source = {
  id: number;
  subscriber_id: number;
  url: string;
  host: string;
  label: string | null;
  feed_url: string | null;
  active: number;
  created_at: string;
  last_fetched_at: string | null;
  last_status: string | null;
  last_error: string | null;
};

export function listSources(subscriberId: number): Source[] {
  return db
    .prepare('SELECT * FROM sources WHERE subscriber_id = ? ORDER BY created_at')
    .all(subscriberId) as Source[];
}

export function activeSources(subscriberId: number): Source[] {
  return db
    .prepare('SELECT * FROM sources WHERE subscriber_id = ? AND active = 1 ORDER BY created_at')
    .all(subscriberId) as Source[];
}

export function countSources(subscriberId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM sources WHERE subscriber_id = ?')
    .get(subscriberId) as { n: number };
  return row.n;
}

export type AddSourceResult = { ok: true; source: Source } | { ok: false; reason: string };

/**
 * Add a source for a subscriber. Enforces the HTTPS rule, the SSRF guard and
 * the per-subscriber limit that the admin controls.
 */
export async function addSource(
  subscriber: Subscriber,
  rawUrl: string,
  label?: string,
): Promise<AddSourceResult> {
  const limit = effectiveSourceLimit(subscriber);
  if (countSources(subscriber.id) >= limit) {
    return {
      ok: false,
      reason: `You have reached your limit of ${limit} source${limit === 1 ? '' : 's'}. Remove one first.`,
    };
  }

  const check = await validateSourceUrl(rawUrl);
  if (!check.ok) return { ok: false, reason: check.reason };

  const existing = db
    .prepare('SELECT id FROM sources WHERE subscriber_id = ? AND url = ?')
    .get(subscriber.id, check.url) as { id: number } | undefined;
  if (existing) return { ok: false, reason: 'That source is already on your list.' };

  const cleanLabel = label?.replace(/\s+/g, ' ').trim().slice(0, 80) || null;

  const info = db
    .prepare('INSERT INTO sources (subscriber_id, url, host, label) VALUES (?, ?, ?, ?)')
    .run(subscriber.id, check.url, check.host, cleanLabel);

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(info.lastInsertRowid)) as Source;
  return { ok: true, source };
}

export function removeSource(subscriberId: number, sourceId: number): boolean {
  const info = db
    .prepare('DELETE FROM sources WHERE id = ? AND subscriber_id = ?')
    .run(sourceId, subscriberId);
  return info.changes > 0;
}

export function setSourceActive(subscriberId: number, sourceId: number, active: boolean): boolean {
  const info = db
    .prepare('UPDATE sources SET active = ? WHERE id = ? AND subscriber_id = ?')
    .run(active ? 1 : 0, sourceId, subscriberId);
  return info.changes > 0;
}

export function recordFetchOutcome(
  sourceId: number,
  outcome: { status: string; error?: string | null; feedUrl?: string | null },
): void {
  db.prepare(
    `UPDATE sources
     SET last_fetched_at = datetime('now'),
         last_status = ?,
         last_error = ?,
         feed_url = COALESCE(?, feed_url)
     WHERE id = ?`,
  ).run(outcome.status, outcome.error ?? null, outcome.feedUrl ?? null, sourceId);
}

/**
 * Active sources belonging to the given subscribers, fetched once per run.
 *
 * Scoped to the subscribers actually due in this sweep: with per-subscriber
 * timezones, a sweep typically serves one region, so there is no reason to
 * fetch everybody else's sources.
 */
export function activeSourcesFor(subscriberIds: number[]): Source[] {
  if (subscriberIds.length === 0) return [];
  // better-sqlite3 has no array binding, so build the placeholder list.
  const placeholders = subscriberIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT s.* FROM sources s
       JOIN subscribers sub ON sub.id = s.subscriber_id
       WHERE s.active = 1 AND sub.status = 'active'
         AND s.subscriber_id IN (${placeholders})
       ORDER BY s.host, s.id`,
    )
    .all(...subscriberIds) as Source[];
}
