import { describe, expect, it } from 'vitest';
import {
  canonicaliseUrl,
  displayHost,
  isPublicAddress,
  validateSourceUrl,
} from '../src/services/urlGuard.js';

describe('isPublicAddress', () => {
  it('accepts globally routable IPv4', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('203.116.1.1')).toBe(true);
  });

  it('rejects loopback, private and link-local IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud instance metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('rejects loopback and unique-local IPv6, including IPv4-mapped private addresses', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects anything that is not an IP address', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('validateSourceUrl', () => {
  it('rejects non-HTTPS schemes', async () => {
    for (const url of [
      'http://example.com/news',
      'ftp://example.com/news',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'gopher://example.com',
    ]) {
      const result = await validateSourceUrl(url);
      expect(result.ok, url).toBe(false);
    }
  });

  it('names HTTPS explicitly when a plain HTTP URL is given', async () => {
    const result = await validateSourceUrl('http://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/i);
  });

  it('rejects embedded credentials', async () => {
    const result = await validateSourceUrl('https://user:pass@example.com/feed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/credentials/i);
  });

  it('rejects non-standard ports', async () => {
    const result = await validateSourceUrl('https://example.com:8443/feed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/443/);
  });

  it('rejects loopback and metadata hosts without needing DNS', async () => {
    for (const url of [
      'https://localhost/feed',
      'https://127.0.0.1/feed',
      'https://[::1]/feed',
      'https://192.168.0.1/feed',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/',
    ]) {
      const result = await validateSourceUrl(url);
      expect(result.ok, url).toBe(false);
    }
  });

  it('rejects bare hostnames with no dot', async () => {
    const result = await validateSourceUrl('https://intranet/feed');
    expect(result.ok).toBe(false);
  });

  it('rejects empty and over-long input', async () => {
    expect((await validateSourceUrl('   ')).ok).toBe(false);
    expect((await validateSourceUrl('https://example.com/' + 'a'.repeat(2100))).ok).toBe(false);
  });
});

describe('canonicaliseUrl', () => {
  it('strips tracking parameters, fragments and the www prefix', () => {
    expect(
      canonicaliseUrl('https://www.example.com/story?utm_source=x&id=7&fbclid=abc#top'),
    ).toBe('https://example.com/story?id=7');
  });

  it('removes a trailing slash but keeps the root path', () => {
    expect(canonicaliseUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(canonicaliseUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('sorts query parameters so ordering does not defeat deduplication', () => {
    expect(canonicaliseUrl('https://example.com/s?b=2&a=1')).toBe(
      canonicaliseUrl('https://example.com/s?a=1&b=2'),
    );
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(canonicaliseUrl('not a url')).toBe('not a url');
  });
});

describe('displayHost', () => {
  it('drops the www prefix', () => {
    expect(displayHost('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });
});
