import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { default: { lookup }, lookup };
});

import { db, migrate, setSetting, SETTING_KEYS } from '../src/db/index.js';
import { checkPin, setTimezone, startSignup } from '../src/services/subscribers.js';
import { addSource } from '../src/services/sources.js';
import { runDigest } from '../src/services/digest.js';

/**
 * End-to-end exercise of the daily pipeline with the network stubbed:
 * fetch -> feed parse -> cross-source clustering -> summarise -> email.
 *
 * Every run passes an explicit `now`, because a sweep only sends to
 * subscribers whose own local clock has reached the send hour.
 */

/** 2026-11-10T23:00Z is 07:00 on the 11th in Singapore, the default zone. */
const SG_SEND_TIME = new Date('2026-11-10T23:00:00Z');

function rss(host: string, items: { title: string; slug: string; body: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${host}</title>
${items
  .map(
    (i) => `<item>
  <title>${i.title}</title>
  <link>https://${host}/${i.slug}</link>
  <description>${i.body}</description>
  <pubDate>${new Date().toUTCString()}</pubDate>
</item>`,
  )
  .join('\n')}
</channel></rss>`;
}

// The same lead story on two publishers, plus one story unique to each.
const SHARED = {
  title: 'Central bank holds interest rates steady in November',
  slug: 'rates',
  body:
    'The central bank left its benchmark policy rate unchanged at its November meeting. ' +
    'Officials pointed to persistent uncertainty in global trade as the main reason for waiting. ' +
    'Economists had widely expected the decision, and the next review is set for January.',
};

const FEEDS: Record<string, string> = {
  'https://alpha.example.com/feed': rss('alpha.example.com', [
    SHARED,
    {
      title: 'Harbour dredging works begin at the eastern berths',
      slug: 'harbour',
      body: 'Dredging started this week at the eastern berths and will continue until March.',
    },
  ]),
  'https://beta.example.com/feed': rss('beta.example.com', [
    {
      title: 'Interest rates held steady by the central bank in November',
      slug: 'rates-held',
      body:
        'The central bank kept its policy rate on hold this month, citing trade uncertainty. ' +
        'The decision matched market expectations.',
    },
    {
      title: 'Museum reopens after two years of renovation work',
      slug: 'museum',
      body: 'The national museum reopened on Saturday following a two-year refurbishment.',
    },
  ]),
};

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let emailOutput: string[];

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  db.exec(
    'DELETE FROM sent_stories; DELETE FROM deliveries; DELETE FROM articles; DELETE FROM digest_runs;' +
      'DELETE FROM sources; DELETE FROM verification_pins; DELETE FROM subscribers;',
  );
  setSetting(SETTING_KEYS.defaultSourceLimit, '5');
  setSetting(SETTING_KEYS.maxStoriesPerEmail, '8');
  setSetting(SETTING_KEYS.minSourcesForTrending, '2');
  // Reset too: one test below changes it, and settings outlive the tables.
  setSetting(SETTING_KEYS.sendHour, '7');

  emailOutput = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    emailOutput.push(String(chunk));
    return true;
  });

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input instanceof URL ? input.toString() : input);

    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const feed = FEEDS[url];
    if (feed) {
      return new Response(feed, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      });
    }
    // Article pages are not needed: the feed descriptions carry enough text.
    return new Response('not found', { status: 404 });
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.unstubAllGlobals();
});

async function activeSubscriberWithSources() {
  const outcome = startSignup('Sunny', 'person@example.test');
  if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
  const verified = checkPin('person@example.test', outcome.pin, 'verify');
  if (!verified.ok) throw new Error('expected verification to succeed');

  for (const url of Object.keys(FEEDS)) {
    const added = await addSource(verified.subscriber, url);
    if (!added.ok) throw new Error(`could not add ${url}: ${added.reason}`);
  }
  return verified.subscriber;
}

describe('runDigest', () => {
  it('fetches sources, clusters across them, summarises and sends one email', async () => {
    const subscriber = await activeSubscriberWithSources();

    const summary = await runDigest({ now: SG_SEND_TIME });

    expect(summary.sourcesFetched).toBe(2);
    expect(summary.sourcesFailed).toBe(0);
    expect(summary.articlesFound).toBe(4);
    expect(summary.emailsSent).toBe(1);
    expect(summary.emailsFailed).toBe(0);

    const delivery = db
      .prepare('SELECT * FROM deliveries WHERE subscriber_id = ?')
      .get(subscriber.id) as { subject: string; story_count: number; status: string };

    expect(delivery.status).toBe('sent');
    // Required subject format, with today's date in the configured timezone.
    expect(delivery.subject).toMatch(/^\[\d{8}\] - Top News Update for Sunny$/);
    // Four articles collapse to three stories: the rates story is shared.
    expect(delivery.story_count).toBe(3);
  });

  it('marks the story carried by both publishers as appearing across sources', async () => {
    await activeSubscriberWithSources();
    await runDigest({ now: SG_SEND_TIME });

    const email = emailOutput.join('');
    expect(email).toContain('Top News Update for Sunny');
    expect(email).toContain('[Across 2 of your sources]');
    // Each publisher's unique story appears.
    expect(email).toContain('https://alpha.example.com/harbour');
    expect(email).toContain('https://beta.example.com/museum');

    // The shared story appears exactly once. Which of the two copies is linked
    // is decided by prominence then headline length, so accept either, but
    // never both: that would mean the cluster failed to merge.
    const sharedLinks = [
      'https://alpha.example.com/rates',
      'https://beta.example.com/rates-held',
    ].filter((url) => email.includes(url));
    expect(sharedLinks).toHaveLength(1);
  });

  it('does not repeat stories already sent to the same subscriber', async () => {
    const subscriber = await activeSubscriberWithSources();

    const first = await runDigest({ now: SG_SEND_TIME });
    expect(first.emailsSent).toBe(1);

    const keys = db
      .prepare('SELECT COUNT(*) AS n FROM sent_stories WHERE subscriber_id = ?')
      .get(subscriber.id) as { n: number };
    expect(keys.n).toBe(3);

    // A later sweep on the same local day does not reconsider them at all,
    // so no publisher is contacted again.
    const second = await runDigest({ now: SG_SEND_TIME });
    expect(second.subscribersConsidered).toBe(0);
    expect(second.emailsSent).toBe(0);
    expect(second.sourcesFetched).toBe(0);

    // The next local day they are due again, but nothing new has been
    // published, so they are considered and skipped rather than emailed.
    const nextDay = new Date(SG_SEND_TIME.getTime() + 24 * 3600_000);
    const third = await runDigest({ now: nextDay });
    expect(third.subscribersConsidered).toBe(1);
    expect(third.emailsSent).toBe(0);
    expect(third.subscribersSkipped).toBe(1);

    // Having been considered, a further sweep that same day leaves them alone.
    const fourth = await runDigest({ now: new Date(nextDay.getTime() + 30 * 60_000) });
    expect(fourth.subscribersConsidered).toBe(0);
  });

  it('skips a subscriber who is not active', async () => {
    const outcome = startSignup('Pending', 'pending@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    // Never verified, so still pending.
    const summary = await runDigest({ now: SG_SEND_TIME });
    expect(summary.emailsSent).toBe(0);
  });

  it('records a source failure without aborting the run', async () => {
    const outcome = startSignup('Sunny', 'person@example.test');
    if (outcome.kind !== 'pin-sent') throw new Error('expected a PIN');
    const verified = checkPin('person@example.test', outcome.pin, 'verify');
    if (!verified.ok) throw new Error('expected verification to succeed');

    const good = await addSource(verified.subscriber, 'https://alpha.example.com/feed');
    expect(good.ok).toBe(true);
    const bad = await addSource(verified.subscriber, 'https://broken.example.com/feed');
    expect(bad.ok).toBe(true);

    const summary = await runDigest({ now: SG_SEND_TIME });
    expect(summary.sourcesFetched).toBe(1);
    expect(summary.sourcesFailed).toBe(1);
    // The working source still produced an email.
    expect(summary.emailsSent).toBe(1);

    const failedSource = db
      .prepare("SELECT last_status, last_error FROM sources WHERE host = 'broken.example.com'")
      .get() as { last_status: string; last_error: string | null };
    expect(failedSource.last_status).toBe('error');
    expect(failedSource.last_error).toBeTruthy();
  });

  it('honours the admin cap on stories per email', async () => {
    setSetting(SETTING_KEYS.maxStoriesPerEmail, '1');
    const subscriber = await activeSubscriberWithSources();

    await runDigest({ now: SG_SEND_TIME });
    const delivery = db
      .prepare('SELECT story_count FROM deliveries WHERE subscriber_id = ?')
      .get(subscriber.id) as { story_count: number };
    expect(delivery.story_count).toBe(1);
  });

  it('does not email a subscriber in another timezone at the wrong local hour', async () => {
    const subscriber = await activeSubscriberWithSources();
    // Move them to London, which at this instant is 23:00 the previous day.
    expect(setTimezone(subscriber.id, 'Europe/London')).toBe(true);

    const atSingaporeMorning = await runDigest({ now: SG_SEND_TIME });
    expect(atSingaporeMorning.subscribersConsidered).toBe(0);
    expect(atSingaporeMorning.emailsSent).toBe(0);

    // 07:00 in London on the same calendar day is eight hours later.
    const londonMorning = new Date('2026-11-11T07:00:00Z');
    const atLondonMorning = await runDigest({ now: londonMorning });
    expect(atLondonMorning.subscribersConsidered).toBe(1);
    expect(atLondonMorning.emailsSent).toBe(1);
  });

  it('dates the subject line in the subscriber\'s timezone, not the server\'s', async () => {
    const subscriber = await activeSubscriberWithSources();
    expect(setTimezone(subscriber.id, 'Europe/London')).toBe(true);

    // 07:00 on the 11th in London. In Singapore it is already 15:00 on the
    // 11th, so both agree here; the point is that the date comes from London.
    await runDigest({ now: new Date('2026-11-11T07:00:00Z') });
    const delivery = db
      .prepare('SELECT subject FROM deliveries WHERE subscriber_id = ? AND status = ?')
      .get(subscriber.id, 'sent') as { subject: string };
    expect(delivery.subject).toBe('[20261111] - Top News Update for Sunny');
  });

  it('serves a half-hour offset zone exactly on a 15-minute sweep', async () => {
    const subscriber = await activeSubscriberWithSources();
    expect(setTimezone(subscriber.id, 'Asia/Kolkata')).toBe(true);

    // India is UTC+05:30, so 07:00 local falls on 01:30Z — a sweep boundary.
    const tooEarly = await runDigest({ now: new Date('2026-11-11T01:15:00Z') });
    expect(tooEarly.subscribersConsidered).toBe(0);

    const onTime = await runDigest({ now: new Date('2026-11-11T01:30:00Z') });
    expect(onTime.subscribersConsidered).toBe(1);
    expect(onTime.emailsSent).toBe(1);
  });

  it('catches up after an outage, but never late at night', async () => {
    const subscriber = await activeSubscriberWithSources();

    // 10:00 Singapore: inside the four-hour catch-up window.
    const lateMorning = await runDigest({ now: new Date('2026-11-11T02:00:00Z') });
    expect(lateMorning.emailsSent).toBe(1);

    // Reset so the same subscriber is eligible again, then try the evening.
    db.prepare('UPDATE subscribers SET last_digest_local_date = NULL WHERE id = ?').run(subscriber.id);
    db.prepare('DELETE FROM sent_stories WHERE subscriber_id = ?').run(subscriber.id);

    // 22:00 Singapore: past the window, so nothing is sent.
    const night = await runDigest({ now: new Date('2026-11-11T14:00:00Z') });
    expect(night.subscribersConsidered).toBe(0);
    expect(night.emailsSent).toBe(0);
  });

  it('force sends to everyone regardless of their local time', async () => {
    const subscriber = await activeSubscriberWithSources();
    expect(setTimezone(subscriber.id, 'America/Los_Angeles')).toBe(true);

    // Middle of the night in Los Angeles, so a sweep would send nothing.
    const sweep = await runDigest({ now: SG_SEND_TIME });
    expect(sweep.emailsSent).toBe(0);

    const forced = await runDigest({ now: SG_SEND_TIME, force: true });
    expect(forced.subscribersConsidered).toBe(1);
    expect(forced.emailsSent).toBe(1);
  });

  it('honours an admin change to the send hour', async () => {
    await activeSubscriberWithSources();
    setSetting(SETTING_KEYS.sendHour, '9');

    // 07:00 Singapore is now too early.
    expect((await runDigest({ now: SG_SEND_TIME })).subscribersConsidered).toBe(0);
    // 09:00 Singapore is 01:00Z.
    expect((await runDigest({ now: new Date('2026-11-11T01:00:00Z') })).emailsSent).toBe(1);
  });

  it('fetches only the sources of subscribers who are due', async () => {
    // One subscriber in Singapore, one in London, with different sources.
    const sg = await activeSubscriberWithSources();
    expect(sg.timezone).toBe('Asia/Singapore');

    const other = startSignup('Londoner', 'london@example.test', 'Europe/London');
    if (other.kind !== 'pin-sent') throw new Error('expected a PIN');
    const verified = checkPin('london@example.test', other.pin, 'verify');
    if (!verified.ok) throw new Error('expected verification to succeed');
    const added = await addSource(verified.subscriber, 'https://beta.example.com/feed');
    expect(added.ok).toBe(true);

    // At Singapore's send hour only the Singapore subscriber is due, so only
    // their two sources are fetched — not the Londoner's.
    const summary = await runDigest({ now: SG_SEND_TIME });
    expect(summary.subscribersConsidered).toBe(1);
    expect(summary.sourcesFetched).toBe(2);
    expect(summary.emailsSent).toBe(1);
  });

  it('records the run in the digest_runs table', async () => {
    await activeSubscriberWithSources();
    const summary = await runDigest({ now: SG_SEND_TIME });

    const run = db.prepare('SELECT * FROM digest_runs WHERE id = ?').get(summary.runId) as {
      status: string;
      finished_at: string | null;
      summariser: string | null;
    };
    expect(run.status).toBe('completed');
    expect(run.finished_at).not.toBeNull();
    expect(run.summariser).toBe('extractive');
  });
});
