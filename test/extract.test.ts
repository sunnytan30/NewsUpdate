import { describe, expect, it } from 'vitest';
import { discoverFeedUrl, extractLinksFromHtml, parseFeed } from '../src/services/extract.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example News</title>
    <item>
      <title>Central bank holds interest rates steady</title>
      <link>https://news.example.com/story/rates?utm_source=rss</link>
      <description>&lt;p&gt;The committee voted to &lt;b&gt;hold&lt;/b&gt; rates.&lt;/p&gt;</description>
      <pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Harbour dredging works begin at eastern berths</title>
      <link>https://news.example.com/story/harbour</link>
      <description>Dredging started this week.</description>
      <pubDate>Mon, 09 Nov 2026 06:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Short</title>
      <link>https://news.example.com/story/short</link>
    </item>
    <item>
      <title>An insecure link should be dropped entirely</title>
      <link>http://news.example.com/insecure</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title>Parliament approves the new transport bill</title>
    <link rel="alternate" href="https://atom.example.com/transport-bill"/>
    <summary>The bill passed its third reading on Tuesday evening.</summary>
    <published>2026-11-09T10:15:00Z</published>
  </entry>
  <entry>
    <title>Museum reopens after two years of renovation</title>
    <link href="https://atom.example.com/museum"/>
    <updated>2026-11-08T09:00:00Z</updated>
  </entry>
</feed>`;

describe('parseFeed (RSS)', () => {
  const articles = parseFeed(RSS, 'https://news.example.com/');

  it('extracts the usable items only', () => {
    // "Short" is below the title-length floor; the http:// item is refused.
    expect(articles).toHaveLength(2);
    expect(articles.map((a) => a.title)).toEqual([
      'Central bank holds interest rates steady',
      'Harbour dredging works begin at eastern berths',
    ]);
  });

  it('records feed position so prominence can be scored', () => {
    expect(articles[0]!.feedPosition).toBe(0);
    expect(articles[1]!.feedPosition).toBe(1);
  });

  it('strips markup out of the description', () => {
    expect(articles[0]!.excerpt).toBe('The committee voted to hold rates.');
    expect(articles[0]!.excerpt).not.toContain('<');
  });

  it('canonicalises the link while keeping the original for the email', () => {
    expect(articles[0]!.url).toContain('utm_source=rss');
    expect(articles[0]!.canonicalUrl).toBe('https://news.example.com/story/rates');
    expect(articles[0]!.host).toBe('news.example.com');
  });

  it('parses RFC 822 dates', () => {
    expect(articles[0]!.publishedAt).toBe('2026-11-09T08:00:00.000Z');
  });
});

describe('parseFeed (Atom)', () => {
  const articles = parseFeed(ATOM, 'https://atom.example.com/');

  it('reads the href attribute form of <link>', () => {
    expect(articles).toHaveLength(2);
    expect(articles[0]!.url).toBe('https://atom.example.com/transport-bill');
    expect(articles[1]!.url).toBe('https://atom.example.com/museum');
  });

  it('falls back to <updated> when <published> is absent', () => {
    expect(articles[1]!.publishedAt).toBe('2026-11-08T09:00:00.000Z');
  });
});

describe('parseFeed (malformed input)', () => {
  it('returns an empty list rather than throwing', () => {
    expect(parseFeed('', 'https://example.com/')).toEqual([]);
    expect(parseFeed('<html><body>not a feed</body></html>', 'https://example.com/')).toEqual([]);
  });
});

describe('discoverFeedUrl', () => {
  it('finds an advertised feed and resolves it against the page URL', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="All stories" href="/feed.xml">
    </head><body></body></html>`;
    expect(discoverFeedUrl(html, 'https://example.com/news')).toBe('https://example.com/feed.xml');
  });

  it('prefers the main feed over a comments feed', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments.xml">
      <link rel="alternate" type="application/rss+xml" title="Main" href="/main.xml">
    </head></html>`;
    expect(discoverFeedUrl(html, 'https://example.com/')).toBe('https://example.com/main.xml');
  });

  it('returns null when nothing is advertised', () => {
    expect(discoverFeedUrl('<html><head></head></html>', 'https://example.com/')).toBeNull();
  });
});

describe('extractLinksFromHtml', () => {
  const html = `<html><body>
    <nav><a href="/">Home</a></nav>
    <h2><a href="/story/one">Council approves the new library building</a></h2>
    <article><a href="/story/two">Ferry service resumes after engine repairs</a></article>
    <h3><a href="https://other.example.org/x">An article on a different domain</a></h3>
    <h2><a href="http://example.com/insecure">An insecure link on this domain</a></h2>
    <h2><a href="/story/one?utm_source=home">Council approves the new library building</a></h2>
    <footer><a href="/about">About</a></footer>
  </body></html>`;

  const articles = extractLinksFromHtml(html, 'https://example.com/news');

  it('keeps same-domain HTTPS headline links only', () => {
    expect(articles.map((a) => a.url)).toEqual([
      'https://example.com/story/one',
      'https://example.com/story/two',
    ]);
  });

  it('deduplicates links that differ only by tracking parameters', () => {
    expect(articles.filter((a) => a.canonicalUrl === 'https://example.com/story/one')).toHaveLength(1);
  });

  it('ignores navigation and footer furniture', () => {
    expect(articles.some((a) => a.title === 'Home' || a.title === 'About')).toBe(false);
  });
});
