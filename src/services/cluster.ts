import crypto from 'node:crypto';
import type { RawArticle } from './extract.js';

/**
 * Story clustering and ranking.
 *
 * Honest scope note: arbitrary news sites do not expose engagement metrics
 * (views, shares, comments) in any reliable machine-readable form. So the
 * ranking here does not claim to measure what people are reading. It measures
 * three things it genuinely can:
 *
 *   1. Corroboration  - how many of the subscriber's distinct publishers carry
 *                       the same story. This is the primary signal.
 *   2. Prominence      - how high the story sits in each publisher's own feed,
 *                       which is that publisher's editorial judgement.
 *   3. Recency         - how fresh the story is.
 */

export type ClusteredStory = {
  /** Stable key for this story across days, used to avoid repeat sends. */
  storyKey: string;
  /** The article chosen to represent the cluster (and to link to). */
  representative: RawArticle;
  members: RawArticle[];
  /** Distinct publisher hostnames carrying the story. */
  hosts: string[];
  /** Distinct subscriber source ids carrying the story. */
  sourceCount: number;
  score: number;
  trending: boolean;
};

export type ArticleWithSource = RawArticle & { sourceId: number };

const STOPWORDS = new Set([
  'a','about','after','again','against','all','also','among','an','and','any','are','as','at','be','because',
  'been','before','being','between','both','but','by','can','could','did','do','does','doing','down','during',
  'each','few','for','from','further','had','has','have','having','he','her','here','hers','him','his','how',
  'i','if','in','into','is','it','its','just','me','more','most','my','no','nor','not','now','of','off','on',
  'once','only','or','other','our','out','over','own','said','same','says','she','should','so','some','such',
  'than','that','the','their','them','then','there','these','they','this','those','through','to','too','under',
  'until','up','very','was','we','were','what','when','where','which','while','who','whom','why','will','with',
  'would','you','your','new','news','latest','update','updates','report','reports','live','video','watch',
  'exclusive','opinion','analysis','amid','amp',
]);

/** Lowercased content words from a title. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** The subset of tokens distinctive enough to anchor a match. */
function significant(tokens: string[]): Set<string> {
  return new Set(tokens.filter((t) => t.length >= 4 || /\d/.test(t)));
}

/**
 * Overlap coefficient rather than Jaccard: headlines for the same event often
 * differ a lot in length, which Jaccard penalises unfairly.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared;
}

const SIMILARITY_THRESHOLD = 0.5;
const MIN_SHARED_SIGNIFICANT = 2;

class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_v, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    let cursor = x;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor] as number;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function recencyWeight(publishedAt: string | null, now: number): number {
  if (!publishedAt) return 0.5; // unknown: neither rewarded nor punished
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return 0.5;
  const hours = Math.max(0, (now - ts) / 3_600_000);
  // Half-life of roughly a day.
  return Math.exp(-hours / 24);
}

function prominenceWeight(feedPosition: number): number {
  return 1 / (1 + Math.max(0, feedPosition));
}

function storyKeyFor(members: ArticleWithSource[]): string {
  // Build the key from the most common significant tokens across the cluster,
  // so the same story recognises itself tomorrow even behind a different URL.
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const token of significant(tokenise(member.title))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([token]) => token)
    .sort();

  if (top.length === 0) {
    const first = members[0];
    return crypto.createHash('sha256').update(first ? first.canonicalUrl : 'empty').digest('hex').slice(0, 32);
  }
  return crypto.createHash('sha256').update(top.join(' ')).digest('hex').slice(0, 32);
}

/**
 * Group articles that describe the same event and score each group.
 * Returns clusters sorted best-first.
 */
export function clusterStories(
  articles: ArticleWithSource[],
  opts: { minSourcesForTrending?: number; now?: number } = {},
): ClusteredStory[] {
  const minSourcesForTrending = opts.minSourcesForTrending ?? 2;
  const now = opts.now ?? Date.now();
  if (articles.length === 0) return [];

  const tokenSets = articles.map((a) => significant(tokenise(a.title)));
  const uf = new UnionFind(articles.length);

  // Identical canonical URLs are the same story by definition.
  const byCanonical = new Map<string, number>();
  articles.forEach((article, index) => {
    const existing = byCanonical.get(article.canonicalUrl);
    if (existing === undefined) byCanonical.set(article.canonicalUrl, index);
    else uf.union(existing, index);
  });

  // Then title similarity. O(n^2), which is fine at the scale of one
  // subscriber's handful of sources.
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const a = tokenSets[i] as Set<string>;
      const b = tokenSets[j] as Set<string>;
      if (sharedCount(a, b) < MIN_SHARED_SIGNIFICANT) continue;
      if (overlap(a, b) >= SIMILARITY_THRESHOLD) uf.union(i, j);
    }
  }

  const groups = new Map<number, ArticleWithSource[]>();
  articles.forEach((article, index) => {
    const root = uf.find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(article);
    else groups.set(root, [article]);
  });

  const clusters: ClusteredStory[] = [];
  for (const members of groups.values()) {
    const hosts = [...new Set(members.map((m) => m.host))];
    const sourceIds = new Set(members.map((m) => m.sourceId));

    const recency = members.reduce((sum, m) => sum + recencyWeight(m.publishedAt, now), 0) / members.length;
    const prominence =
      members.reduce((sum, m) => sum + prominenceWeight(m.feedPosition), 0) / members.length;

    // Corroboration across distinct publishers dominates the score.
    const score = 100 * Math.log2(1 + hosts.length) + 30 * recency + 20 * prominence;

    // Represent the cluster with its most prominent, and then longest, headline.
    const representative = [...members].sort(
      (a, b) => a.feedPosition - b.feedPosition || b.title.length - a.title.length,
    )[0] as ArticleWithSource;

    clusters.push({
      storyKey: storyKeyFor(members),
      representative,
      members,
      hosts,
      sourceCount: sourceIds.size,
      score,
      trending: hosts.length >= minSourcesForTrending,
    });
  }

  return clusters.sort((a, b) => b.score - a.score);
}
