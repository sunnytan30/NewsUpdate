import { config } from '../config.js';
import { log } from '../util/logger.js';
import { assertPublicHost } from './urlGuard.js';

const USER_AGENT = process.env.FETCH_USER_AGENT?.trim() || 'NewsUpdateBot/1.0';
const MAX_REDIRECTS = 3;

export type FetchResult =
  | { ok: true; url: string; body: string; contentType: string }
  | { ok: false; reason: string; status?: number };

// ---------------------------------------------------------------------------
// Per-host politeness: serialise requests to a host and space them out.
// ---------------------------------------------------------------------------

const hostQueues = new Map<string, Promise<void>>();

function hostGate<T>(host: string, work: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const run = previous.then(work, work);
  // Hold the next caller for the politeness delay after this one settles.
  const release = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, config.FETCH_HOST_DELAY_MS)));
  hostQueues.set(host, release);
  // Avoid unbounded growth of the map for hosts that have gone quiet.
  release.then(() => {
    if (hostQueues.get(host) === release) hostQueues.delete(host);
  });
  return run;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

type RobotsRule = { allow: boolean; path: string };
type Robots = { rules: RobotsRule[]; crawlDelayMs: number | null };

const robotsCache = new Map<string, { value: Robots; expiresAt: number }>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

function parseRobots(text: string): Robots {
  const lines = text.split(/\r?\n/);
  // Collect rule groups, keyed by the user-agent they apply to.
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null } | null = null;
  let lastWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    else if (field === 'allow') current.rules.push({ allow: true, path: value });
    else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds * 1000;
    }
  }

  const ourName = USER_AGENT.split('/')[0]?.toLowerCase() ?? 'newsupdatebot';
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ourName.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = specific ?? wildcard;
  if (!chosen) return { rules: [], crawlDelayMs: null };
  return { rules: chosen.rules, crawlDelayMs: chosen.crawlDelay };
}

/** Match a robots path pattern, supporting the de-facto `*` and `$` syntax. */
function patternMatches(pattern: string, pathname: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + escaped + (anchored ? '$' : ''));
  return re.test(pathname);
}

async function loadRobots(origin: string): Promise<Robots> {
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: Robots = { rules: [], crawlDelayMs: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.FETCH_TIMEOUT_MS, 8000));
    const response = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const text = (await response.text()).slice(0, 512 * 1024);
      value = parseRobots(text);
    }
    // 4xx means no restrictions; 5xx is ambiguous, and we choose to proceed
    // rather than block a subscriber's source on a transient server error.
  } catch {
    // Unreachable robots.txt is treated as no restrictions.
  }
  robotsCache.set(origin, { value, expiresAt: Date.now() + ROBOTS_TTL_MS });
  return value;
}

export async function isAllowedByRobots(target: URL): Promise<boolean> {
  if (!config.RESPECT_ROBOTS) return true;
  const robots = await loadRobots(target.origin);
  if (robots.rules.length === 0) return true;

  const pathWithQuery = target.pathname + (target.search || '');
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    if (!patternMatches(rule.path, pathWithQuery)) continue;
    // Longest matching pattern wins; Allow wins ties.
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('response too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error('response too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch a URL with every guard applied: HTTPS only, public addresses only
 * (re-checked on each redirect hop), robots.txt respected, a hard byte cap,
 * a timeout, and per-host throttling.
 */
export async function fetchText(
  rawUrl: string,
  opts: { accept?: string; checkRobots?: boolean } = {},
): Promise<FetchResult> {
  const accept = opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const checkRobots = opts.checkRobots ?? true;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:') {
      return { ok: false, reason: 'non-HTTPS URL refused' };
    }
    const hostCheck = await assertPublicHost(current.hostname);
    if (!hostCheck.ok) return { ok: false, reason: hostCheck.reason };

    if (checkRobots && !(await isAllowedByRobots(current))) {
      return { ok: false, reason: 'disallowed by robots.txt' };
    }

    const target = current;
    const result = await hostGate(target.hostname, async (): Promise<
      { kind: 'done'; value: FetchResult } | { kind: 'redirect'; to: string }
    > => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(target, {
          headers: {
            'user-agent': USER_AGENT,
            accept,
            'accept-language': 'en',
          },
          redirect: 'manual',
          signal: controller.signal,
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return { kind: 'done', value: { ok: false, reason: 'redirect without location', status: response.status } };
          }
          return { kind: 'redirect', to: new URL(location, target).toString() };
        }
        if (!response.ok) {
          return { kind: 'done', value: { ok: false, reason: `HTTP ${response.status}`, status: response.status } };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await readCapped(response, config.FETCH_MAX_BYTES);
        return { kind: 'done', value: { ok: true, url: target.toString(), body, contentType } };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.name === 'AbortError' || error.name === 'TimeoutError'
              ? 'request timed out'
              : error.message
            : 'request failed';
        return { kind: 'done', value: { ok: false, reason: message } };
      } finally {
        clearTimeout(timer);
      }
    });

    if (result.kind === 'done') return result.value;

    try {
      current = new URL(result.to);
    } catch {
      return { ok: false, reason: 'invalid redirect target' };
    }
    log.debug('following redirect', { to: current.toString() });
  }

  return { ok: false, reason: 'too many redirects' };
}

/** Run tasks with bounded concurrency, preserving input order in the output. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index] as T, index);
      }
    }),
  );
  return results;
}
