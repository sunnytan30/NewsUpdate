import { db, getSettingInt, SETTING_KEYS } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { collectFromSource, fetchArticleBody, type RawArticle } from './extract.js';
import { mapLimit } from './fetcher.js';
import { clusterStories, type ArticleWithSource, type ClusteredStory } from './cluster.js';
import { summarise, summariserName, type SummaryInput } from './summarise.js';
import { digestEmail, type DigestStory } from './templates.js';
import { sendMail } from './mailer.js';
import {
  activeSubscribers,
  dueSubscribers,
  manageUrl,
  markDigestConsidered,
  markDigestSent,
  resolveTimezone,
  sendHour,
  unsubscribeUrl,
  type Subscriber,
} from './subscribers.js';
import { activeSources, activeSourcesFor, recordFetchOutcome, type Source } from './sources.js';

export type RunSummary = {
  runId: number;
  sourcesFetched: number;
  sourcesFailed: number;
  articlesFound: number;
  emailsSent: number;
  emailsFailed: number;
  subscribersSkipped: number;
  /** Subscribers considered in this run (those due, or all when forced). */
  subscribersConsidered: number;
};

export type RunOptions = {
  /**
   * Send to every active subscriber regardless of their local time. Used by
   * the admin's "run now" button and `digest:run --force`; the scheduled sweep
   * never forces, or subscribers would be emailed at the wrong hour.
   */
  force?: boolean;
  now?: Date;
};

/** Keep repeat-suppression bounded so a story can resurface after a fortnight. */
const SENT_HISTORY_DAYS = 14;
/** Articles we are willing to open per subscriber to deepen a summary. */
const MAX_BODY_FETCHES_PER_SUBSCRIBER = 10;

function startRun(): number {
  const info = db
    .prepare('INSERT INTO digest_runs (summariser) VALUES (?)')
    .run(summariserName());
  return Number(info.lastInsertRowid);
}

type RunStats = Pick<
  RunSummary,
  'sourcesFetched' | 'sourcesFailed' | 'articlesFound' | 'emailsSent' | 'emailsFailed'
>;

function finishRun(runId: number, stats: RunStats, error?: string) {
  db.prepare(
    `UPDATE digest_runs
     SET finished_at = datetime('now'),
         status = ?,
         sources_fetched = ?, sources_failed = ?, articles_found = ?,
         emails_sent = ?, emails_failed = ?, error = ?
     WHERE id = ?`,
  ).run(
    error ? 'failed' : 'completed',
    stats.sourcesFetched,
    stats.sourcesFailed,
    stats.articlesFound,
    stats.emailsSent,
    stats.emailsFailed,
    error ?? null,
    runId,
  );
}

function persistArticles(runId: number, source: Source, articles: RawArticle[]): void {
  const insert = db.prepare(
    `INSERT INTO articles
       (run_id, source_id, host, url, canonical_url, title, excerpt, published_at, feed_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: RawArticle[]) => {
    for (const a of rows) {
      insert.run(
        runId,
        source.id,
        a.host,
        a.url,
        a.canonicalUrl,
        a.title,
        a.excerpt || null,
        a.publishedAt,
        a.feedPosition,
      );
    }
  });
  tx(articles);
}

function alreadySent(subscriberId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT story_key FROM sent_stories
       WHERE subscriber_id = ? AND sent_at > datetime('now', ?)`,
    )
    .all(subscriberId, `-${SENT_HISTORY_DAYS} days`) as { story_key: string }[];
  return new Set(rows.map((r) => r.story_key));
}

function recordSent(subscriberId: number, storyKeys: string[]): void {
  const insert = db.prepare(
    `INSERT INTO sent_stories (subscriber_id, story_key) VALUES (?, ?)
     ON CONFLICT (subscriber_id, story_key) DO UPDATE SET sent_at = datetime('now')`,
  );
  const tx = db.transaction((keys: string[]) => {
    for (const key of keys) insert.run(subscriberId, key);
  });
  tx(storyKeys);
}

function logDelivery(
  runId: number,
  subscriberId: number,
  subject: string,
  storyCount: number,
  status: 'sent' | 'failed' | 'skipped',
  error?: string,
): void {
  db.prepare(
    `INSERT INTO deliveries (run_id, subscriber_id, subject, story_count, status, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, subscriberId, subject, storyCount, status, error ?? null);
}

/** Housekeeping so the database does not grow without bound. */
function prune(): void {
  db.prepare("DELETE FROM sent_stories WHERE sent_at < datetime('now', '-60 days')").run();
  db.prepare("DELETE FROM articles WHERE fetched_at < datetime('now', '-14 days')").run();
  db.prepare(
    "DELETE FROM verification_pins WHERE created_at < datetime('now', '-7 days')",
  ).run();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM deliveries WHERE created_at < datetime('now', '-90 days')").run();
}

/**
 * Fetch every distinct source URL once, regardless of how many subscribers
 * share it, and return the articles keyed by source id.
 */
async function fetchAllSources(
  runId: number,
  subscriberIds: number[],
): Promise<{ bySourceId: Map<number, RawArticle[]>; fetched: number; failed: number; total: number }> {
  const sources = activeSourcesFor(subscriberIds);
  const byUrl = new Map<string, Source[]>();
  for (const source of sources) {
    const bucket = byUrl.get(source.url);
    if (bucket) bucket.push(source);
    else byUrl.set(source.url, [source]);
  }

  const bySourceId = new Map<number, RawArticle[]>();
  let fetched = 0;
  let failed = 0;
  let total = 0;

  const urls = [...byUrl.entries()];
  await mapLimit(urls, config.FETCH_CONCURRENCY, async ([url, group]) => {
    // Any stored feed URL from a previous run is a valid starting point.
    const knownFeed = group.find((s) => s.feed_url)?.feed_url ?? null;
    const result = await collectFromSource(url, knownFeed);

    if (result.error && result.articles.length === 0) {
      failed++;
      log.warn('source fetch failed', { url, error: result.error });
      for (const source of group) {
        recordFetchOutcome(source.id, { status: 'error', error: result.error });
        bySourceId.set(source.id, []);
      }
      return;
    }

    fetched++;
    total += result.articles.length;
    for (const source of group) {
      recordFetchOutcome(source.id, {
        status: 'ok',
        error: result.error,
        feedUrl: result.feedUrl,
      });
      bySourceId.set(source.id, result.articles);
      persistArticles(runId, source, result.articles);
    }
  });

  return { bySourceId, fetched, failed, total };
}

/** Best available text for a story, opening the article only when needed. */
async function bodyForStory(
  story: ClusteredStory,
  bodyCache: Map<string, string>,
  budget: { remaining: number },
): Promise<string> {
  const best = story.members
    .map((m) => m.excerpt)
    .filter((e) => e.length > 0)
    .sort((a, b) => b.length - a.length)[0] ?? '';

  if (best.length >= 400) return best;

  const key = story.representative.canonicalUrl;
  const cached = bodyCache.get(key);
  if (cached !== undefined) return cached.length > best.length ? cached : best;

  if (budget.remaining <= 0) return best;
  budget.remaining--;

  const fetchedBody = await fetchArticleBody(story.representative.url);
  bodyCache.set(key, fetchedBody);
  return fetchedBody.length > best.length ? fetchedBody : best;
}

async function buildForSubscriber(
  subscriber: Subscriber,
  bySourceId: Map<number, RawArticle[]>,
  bodyCache: Map<string, string>,
  summaryCache: Map<string, { title: string; summary: string }>,
): Promise<{ stories: DigestStory[]; storyKeys: string[] }> {
  const sources = activeSources(subscriber.id);
  const articles: ArticleWithSource[] = [];
  for (const source of sources) {
    for (const article of bySourceId.get(source.id) ?? []) {
      articles.push({ ...article, sourceId: source.id });
    }
  }
  if (articles.length === 0) return { stories: [], storyKeys: [] };

  const minSourcesForTrending = getSettingInt(SETTING_KEYS.minSourcesForTrending, 2);
  const maxStories = getSettingInt(SETTING_KEYS.maxStoriesPerEmail, config.MAX_STORIES_PER_EMAIL);

  const clusters = clusterStories(articles, { minSourcesForTrending });
  const suppressed = alreadySent(subscriber.id);
  const selected = clusters.filter((c) => !suppressed.has(c.storyKey)).slice(0, maxStories);
  if (selected.length === 0) return { stories: [], storyKeys: [] };

  // Gather the text to summarise, reusing any summary already produced for
  // the same story for another subscriber in this run.
  const budget = { remaining: MAX_BODY_FETCHES_PER_SUBSCRIBER };
  const needSummary: ClusteredStory[] = [];
  const inputs: SummaryInput[] = [];

  for (const story of selected) {
    if (summaryCache.has(story.storyKey)) continue;
    const body = await bodyForStory(story, bodyCache, budget);
    needSummary.push(story);
    inputs.push({
      id: story.storyKey,
      title: story.representative.title,
      publishers: story.hosts,
      body,
    });
  }

  if (inputs.length > 0) {
    const results = await summarise(inputs);
    for (const result of results) {
      summaryCache.set(result.id, { title: result.title, summary: result.summary });
    }
    // Guard against a story the engine dropped entirely.
    for (const story of needSummary) {
      if (!summaryCache.has(story.storyKey)) {
        summaryCache.set(story.storyKey, {
          title: story.representative.title,
          summary: story.representative.excerpt || story.representative.title,
        });
      }
    }
  }

  const stories: DigestStory[] = selected.map((story) => {
    const summary = summaryCache.get(story.storyKey) as { title: string; summary: string };
    return {
      title: summary.title,
      summary: summary.summary,
      // The link always comes from the source record, never from model output.
      url: story.representative.url,
      host: story.representative.host,
      publishers: story.hosts,
      trending: story.trending,
    };
  });

  return { stories, storyKeys: selected.map((s) => s.storyKey) };
}

/**
 * Run the digest: fetch, cluster, summarise, send.
 *
 * Called on every sweep. It first works out who is actually due in their own
 * timezone, and returns immediately if that is nobody — so a sweep that serves
 * no one costs a single query and fetches nothing from any publisher.
 */
export async function runDigest(options: RunOptions = {}): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const recipients = options.force ? activeSubscribers() : dueSubscribers(now);

  const stats: RunStats = {
    sourcesFetched: 0,
    sourcesFailed: 0,
    articlesFound: 0,
    emailsSent: 0,
    emailsFailed: 0,
  };

  if (recipients.length === 0) {
    log.debug('sweep found nobody due', { sendHour: sendHour() });
    return {
      runId: 0,
      ...stats,
      subscribersSkipped: 0,
      subscribersConsidered: 0,
    };
  }

  const runId = startRun();
  log.info('digest run started', {
    runId,
    summariser: summariserName(),
    recipients: recipients.length,
    forced: options.force === true,
  });

  let skipped = 0;

  try {
    const fetchResult = await fetchAllSources(
      runId,
      recipients.map((s) => s.id),
    );
    stats.sourcesFetched = fetchResult.fetched;
    stats.sourcesFailed = fetchResult.failed;
    stats.articlesFound = fetchResult.total;

    const bodyCache = new Map<string, string>();
    const summaryCache = new Map<string, { title: string; summary: string }>();

    for (const subscriber of recipients) {
      try {
        const { stories, storyKeys } = await buildForSubscriber(
          subscriber,
          fetchResult.bySourceId,
          bodyCache,
          summaryCache,
        );

        if (stories.length === 0) {
          skipped++;
          // Stamp their local day so later sweeps in the catch-up window do
          // not re-fetch their sources to find the same nothing.
          if (!options.force) markDigestConsidered(subscriber, now);
          logDelivery(runId, subscriber.id, '(no stories)', 0, 'skipped', 'nothing new to send');
          log.info('nothing to send', { subscriberId: subscriber.id });
          continue;
        }

        const mail = digestEmail({
          name: subscriber.name,
          stories,
          manageUrl: manageUrl(subscriber),
          unsubscribeUrl: unsubscribeUrl(subscriber),
          date: now,
          // Dates in the subject and body are rendered in the recipient's zone.
          timeZone: resolveTimezone(subscriber.timezone),
        });

        const sendResult = await sendMail({
          to: subscriber.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          unsubscribeUrl: unsubscribeUrl(subscriber),
        });

        if (sendResult.ok) {
          stats.emailsSent++;
          recordSent(subscriber.id, storyKeys);
          markDigestSent(subscriber, now);
          logDelivery(runId, subscriber.id, mail.subject, stories.length, 'sent');
          log.info('digest sent', { subscriberId: subscriber.id, stories: stories.length });
        } else {
          stats.emailsFailed++;
          logDelivery(runId, subscriber.id, mail.subject, stories.length, 'failed', sendResult.error);
          log.error('digest send failed', { subscriberId: subscriber.id, error: sendResult.error });
        }
      } catch (error) {
        stats.emailsFailed++;
        const message = error instanceof Error ? error.message : String(error);
        logDelivery(runId, subscriber.id, '(error)', 0, 'failed', message);
        log.error('subscriber digest failed', { subscriberId: subscriber.id, error: message });
      }
    }

    prune();
    finishRun(runId, stats);
    const summary: RunSummary = {
      runId,
      ...stats,
      subscribersSkipped: skipped,
      subscribersConsidered: recipients.length,
    };
    log.info('digest run finished', summary);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishRun(runId, stats, message);
    log.error('digest run failed', { runId, error: message });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export type RunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  sources_fetched: number;
  sources_failed: number;
  articles_found: number;
  emails_sent: number;
  emails_failed: number;
  summariser: string | null;
  error: string | null;
};

export function recentRuns(limit = 20): RunRow[] {
  return db
    .prepare('SELECT * FROM digest_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as RunRow[];
}

export type DeliveryRow = {
  id: number;
  run_id: number | null;
  subscriber_id: number | null;
  email: string | null;
  subject: string;
  story_count: number;
  status: string;
  error: string | null;
  created_at: string;
};

export function recentDeliveries(limit = 50): DeliveryRow[] {
  return db
    .prepare(
      `SELECT d.*, s.email
       FROM deliveries d LEFT JOIN subscribers s ON s.id = d.subscriber_id
       ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit) as DeliveryRow[];
}
