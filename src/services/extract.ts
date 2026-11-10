import * as cheerio from 'cheerio';
import { squash, truncate } from '../util/html.js';
import { canonicaliseUrl, displayHost } from './urlGuard.js';
import { fetchText } from './fetcher.js';
import { log } from '../util/logger.js';

export type RawArticle = {
  title: string;
  url: string;
  canonicalUrl: string;
  host: string;
  excerpt: string;
  publishedAt: string | null;
  /** Position in the feed or on the page: a proxy for editorial prominence. */
  feedPosition: number;
};

const MAX_ARTICLES_PER_SOURCE = 25;
const MIN_TITLE_LENGTH = 18;

/** Feed MIME types advertised via <link rel="alternate">. */
const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/feed+json', 'text/xml'];

function looksLikeFeed(contentType: string, body: string): boolean {
  if (FEED_TYPES.some((t) => contentType.includes(t))) return true;
  if (contentType.includes('xml')) return /<(rss|feed)\b/i.test(body.slice(0, 2000));
  return /^\s*<\?xml/.test(body) && /<(rss|feed)\b/i.test(body.slice(0, 2000));
}

/** Find an RSS/Atom feed advertised by an HTML page. */
export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const candidates: { href: string; score: number }[] = [];

  $('link[rel~="alternate"]').each((_i, el) => {
    const type = ($(el).attr('type') ?? '').toLowerCase();
    const href = $(el).attr('href');
    if (!href || !FEED_TYPES.includes(type)) return;
    // Prefer the site's main feed over per-category feeds.
    const title = ($(el).attr('title') ?? '').toLowerCase();
    let score = 0;
    if (type.includes('rss')) score += 2;
    if (type.includes('atom')) score += 1;
    if (/all|main|home|latest|top/.test(title)) score += 2;
    if (/comment/.test(title) || /comment/i.test(href)) score -= 5;
    candidates.push({ href, score });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  try {
    return new URL(candidates[0]!.href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseDate(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  // Reject implausible dates that would skew recency scoring.
  const year = date.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
  return date.toISOString();
}

/**
 * Strip all markup from a feed description. Feed summaries routinely contain
 * HTML; we keep only its text so nothing is rendered or interpreted later.
 */
function stripMarkup(input: string): string {
  if (input.trim() === '') return '';
  try {
    return squash(cheerio.load(`<div>${input}</div>`)('div').text());
  } catch {
    return squash(input.replace(/<[^>]*>/g, ' '));
  }
}

/** Parse an RSS 2.0 or Atom feed into articles, in document order. */
export function parseFeed(xml: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: RawArticle[] = [];

  const items = $('item').length > 0 ? $('item') : $('entry');
  items.each((index, el) => {
    if (out.length >= MAX_ARTICLES_PER_SOURCE) return;
    const item = $(el);

    const title = squash(item.children('title').first().text());
    if (title.length < MIN_TITLE_LENGTH) return;

    // RSS puts the URL in <link>text</link>; Atom in <link href="...">.
    let href = squash(item.children('link').first().text());
    if (href === '') {
      const alt = item
        .children('link')
        .filter((_j, l) => {
          const rel = $(l).attr('rel');
          return rel === undefined || rel === 'alternate';
        })
        .first();
      href = alt.attr('href') ?? '';
    }
    if (href === '') href = squash(item.children('guid').first().text());
    if (!/^https?:\/\//i.test(href)) {
      try {
        href = new URL(href, baseUrl).toString();
      } catch {
        return;
      }
    }
    // Only HTTPS article links are kept, consistent with the source rule.
    if (!href.toLowerCase().startsWith('https://')) return;

    const description =
      item.children('description').first().text() ||
      item.children('summary').first().text() ||
      item.children('content').first().text() ||
      item.find('content\\:encoded').first().text() ||
      '';

    const published =
      parseDate(item.children('pubDate').first().text()) ??
      parseDate(item.children('published').first().text()) ??
      parseDate(item.children('updated').first().text()) ??
      parseDate(item.find('dc\\:date').first().text());

    out.push({
      title,
      url: href,
      canonicalUrl: canonicaliseUrl(href),
      host: displayHost(href),
      excerpt: truncate(stripMarkup(description), 1200),
      publishedAt: published,
      feedPosition: index,
    });
  });

  return out;
}

/**
 * Last-resort extraction from a homepage or section page. Headline links are
 * taken in document order, which approximates the publisher's own ordering.
 */
export function extractLinksFromHtml(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, aside, form').remove();

  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  // Headline anchors: inside a heading, or inside an article/item container.
  const selector = [
    'h1 a[href]',
    'h2 a[href]',
    'h3 a[href]',
    'article a[href]',
    '[class*="headline"] a[href]',
    '[class*="title"] a[href]',
    '[class*="story"] a[href]',
  ].join(', ');

  $(selector).each((_i, el) => {
    if (out.length >= MAX_ARTICLES_PER_SOURCE) return;
    const anchor = $(el);
    const href = anchor.attr('href');
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }
    if (resolved.protocol !== 'https:') return;
    // Stay on the publisher's own domain.
    if (resolved.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;

    const title = squash(anchor.text());
    if (title.length < MIN_TITLE_LENGTH || title.length > 300) return;
    // Skip navigation furniture.
    if (/^(home|more|latest|subscribe|sign in|log in|menu|all stories)$/i.test(title)) return;

    const canonical = canonicaliseUrl(resolved.toString());
    if (seen.has(canonical)) return;
    seen.add(canonical);

    out.push({
      title,
      url: resolved.toString(),
      canonicalUrl: canonical,
      host: displayHost(resolved.toString()),
      excerpt: '',
      publishedAt: null,
      feedPosition: out.length,
    });
  });

  return out;
}

/**
 * Collect the latest articles from one subscriber source.
 * Prefers a feed, because a feed is the publisher's own machine-readable
 * offering; falls back to parsing the page only when no feed is advertised.
 */
export async function collectFromSource(sourceUrl: string, knownFeedUrl?: string | null): Promise<{
  articles: RawArticle[];
  feedUrl: string | null;
  error: string | null;
}> {
  if (knownFeedUrl) {
    const feed = await fetchText(knownFeedUrl, { accept: 'application/rss+xml, application/atom+xml, application/xml' });
    if (feed.ok && looksLikeFeed(feed.contentType, feed.body)) {
      return { articles: parseFeed(feed.body, feed.url), feedUrl: knownFeedUrl, error: null };
    }
    log.debug('known feed no longer usable, re-discovering', { sourceUrl });
  }

  const page = await fetchText(sourceUrl);
  if (!page.ok) {
    return { articles: [], feedUrl: null, error: page.reason };
  }

  // The source URL may itself be a feed.
  if (looksLikeFeed(page.contentType, page.body)) {
    return { articles: parseFeed(page.body, page.url), feedUrl: page.url, error: null };
  }

  const discovered = discoverFeedUrl(page.body, page.url);
  if (discovered) {
    const feed = await fetchText(discovered, {
      accept: 'application/rss+xml, application/atom+xml, application/xml',
    });
    if (feed.ok && looksLikeFeed(feed.contentType, feed.body)) {
      const articles = parseFeed(feed.body, feed.url);
      if (articles.length > 0) return { articles, feedUrl: discovered, error: null };
    }
  }

  const articles = extractLinksFromHtml(page.body, page.url);
  return {
    articles,
    feedUrl: null,
    error: articles.length === 0 ? 'no articles could be extracted' : null,
  };
}

/**
 * Fetch one article and extract its main text, for the stories that reach the
 * final digest. Called only for selected stories to keep request volume low.
 */
export async function fetchArticleBody(url: string): Promise<string> {
  const page = await fetchText(url);
  if (!page.ok) return '';

  const $ = cheerio.load(page.body);
  $('script, style, noscript, nav, footer, aside, form, figure, iframe, svg').remove();

  // Prefer a semantic article container, then the densest paragraph block.
  const containers = ['article', 'main', '[itemprop="articleBody"]', '[class*="article-body"]', '[class*="story-body"]'];
  let best = '';
  for (const selector of containers) {
    const text = squash($(selector).first().text());
    if (text.length > best.length) best = text;
  }
  if (best.length < 400) {
    const paragraphs = $('p')
      .map((_i, el) => squash($(el).text()))
      .get()
      .filter((t) => t.length > 60);
    const joined = paragraphs.join(' ');
    if (joined.length > best.length) best = joined;
  }
  if (best.length < 200) {
    const meta =
      $('meta[property="og:description"]').attr('content') ??
      $('meta[name="description"]').attr('content') ??
      '';
    if (meta) best = squash(meta);
  }

  return truncate(best, 6000);
}
