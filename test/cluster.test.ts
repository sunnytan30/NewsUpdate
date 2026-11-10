import { describe, expect, it } from 'vitest';
import { clusterStories, tokenise, type ArticleWithSource } from '../src/services/cluster.js';

function article(
  partial: Partial<ArticleWithSource> & { title: string; host: string; sourceId: number },
): ArticleWithSource {
  const url = partial.url ?? `https://${partial.host}/${encodeURIComponent(partial.title.slice(0, 20))}`;
  return {
    title: partial.title,
    url,
    canonicalUrl: partial.canonicalUrl ?? url,
    host: partial.host,
    excerpt: partial.excerpt ?? '',
    publishedAt: partial.publishedAt ?? new Date().toISOString(),
    feedPosition: partial.feedPosition ?? 0,
    sourceId: partial.sourceId,
  };
}

describe('tokenise', () => {
  it('drops stopwords and short words', () => {
    expect(tokenise('The cat is on the mat')).toEqual(['cat', 'mat']);
  });

  it('strips accents and punctuation', () => {
    expect(tokenise('Café closures: régime change!')).toEqual(['cafe', 'closures', 'regime', 'change']);
  });
});

describe('clusterStories', () => {
  it('groups the same story reported by different publishers', () => {
    const articles = [
      article({ title: 'Singapore raises GST rate to nine percent', host: 'a.com', sourceId: 1 }),
      article({ title: 'GST rate in Singapore raised to nine percent', host: 'b.com', sourceId: 2 }),
      article({ title: 'Local football club signs new goalkeeper', host: 'c.com', sourceId: 3 }),
    ];

    const clusters = clusterStories(articles, { minSourcesForTrending: 2 });
    expect(clusters).toHaveLength(2);

    const top = clusters[0]!;
    expect(top.members).toHaveLength(2);
    expect(top.hosts.sort()).toEqual(['a.com', 'b.com']);
    expect(top.trending).toBe(true);
    expect(top.sourceCount).toBe(2);
  });

  it('ranks a corroborated story above a single-source story', () => {
    const articles = [
      article({ title: 'Minor council meeting scheduled for Thursday', host: 'solo.com', sourceId: 1, feedPosition: 0 }),
      article({ title: 'Typhoon makes landfall near Manila overnight', host: 'x.com', sourceId: 2, feedPosition: 5 }),
      article({ title: 'Typhoon makes landfall overnight near Manila', host: 'y.com', sourceId: 3, feedPosition: 5 }),
    ];

    const clusters = clusterStories(articles, { minSourcesForTrending: 2 });
    expect(clusters[0]!.hosts).toHaveLength(2);
    expect(clusters[0]!.score).toBeGreaterThan(clusters[1]!.score);
  });

  it('merges articles that share a canonical URL even when titles differ', () => {
    const shared = 'https://wire.example.com/report-123';
    const articles = [
      article({ title: 'Completely different wording here today', host: 'a.com', sourceId: 1, canonicalUrl: shared }),
      article({ title: 'Nothing alike in this headline at all', host: 'b.com', sourceId: 2, canonicalUrl: shared }),
    ];

    const clusters = clusterStories(articles, { minSourcesForTrending: 2 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
  });

  it('does not treat two stories sharing one common word as the same story', () => {
    const articles = [
      article({ title: 'Government announces new housing policy framework', host: 'a.com', sourceId: 1 }),
      article({ title: 'Government denies involvement in shipping dispute', host: 'b.com', sourceId: 2 }),
    ];

    const clusters = clusterStories(articles, { minSourcesForTrending: 2 });
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.trending === false)).toBe(true);
  });

  it('counts distinct publishers, not duplicate copies from one publisher', () => {
    const articles = [
      article({ title: 'Election results confirmed after final recount', host: 'same.com', sourceId: 1 }),
      article({ title: 'Election results confirmed following recount', host: 'same.com', sourceId: 2 }),
    ];

    const clusters = clusterStories(articles, { minSourcesForTrending: 2 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.hosts).toEqual(['same.com']);
    // One publisher is not corroboration, so it must not be marked trending.
    expect(clusters[0]!.trending).toBe(false);
  });

  it('prefers fresher stories when corroboration is equal', () => {
    const now = Date.now();
    const old = new Date(now - 72 * 3600_000).toISOString();
    const fresh = new Date(now - 1 * 3600_000).toISOString();

    const clusters = clusterStories(
      [
        article({ title: 'Older isolated item about harbour works', host: 'a.com', sourceId: 1, publishedAt: old }),
        article({ title: 'Fresher isolated item about railway works', host: 'b.com', sourceId: 2, publishedAt: fresh }),
      ],
      { now },
    );
    expect(clusters[0]!.representative.publishedAt).toBe(fresh);
  });

  it('produces a stable story key for the same story across runs', () => {
    const first = clusterStories([
      article({ title: 'Central bank holds interest rates steady', host: 'a.com', sourceId: 1 }),
    ]);
    const second = clusterStories([
      article({ title: 'Central bank holds interest rates steady', host: 'z.com', sourceId: 9 }),
    ]);
    expect(first[0]!.storyKey).toBe(second[0]!.storyKey);
  });

  it('returns an empty list for no input', () => {
    expect(clusterStories([])).toEqual([]);
  });
});
