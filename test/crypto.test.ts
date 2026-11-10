import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  randomPin,
  safeEqual,
  signedToken,
  verifySecret,
  verifySignedToken,
} from '../src/util/crypto.js';

describe('hashSecret / verifySecret', () => {
  it('verifies the correct secret and rejects a wrong one', () => {
    const hash = hashSecret('correct horse battery staple');
    expect(verifySecret('correct horse battery staple', hash)).toBe(true);
    expect(verifySecret('wrong password', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', () => {
    expect(hashSecret('same')).not.toBe(hashSecret('same'));
  });

  it('stores no plaintext', () => {
    expect(hashSecret('sekrit-value')).not.toContain('sekrit-value');
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$x$y$z$aa$bb']) {
      expect(verifySecret('whatever', bad), bad).toBe(false);
    }
  });

  it('treats unicode-equivalent input consistently', () => {
    // Composed vs decomposed forms of the same character must match.
    const hash = hashSecret('café');
    expect(verifySecret('café', hash)).toBe(true);
  });
});

describe('randomPin', () => {
  it('returns the requested number of digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomPin(6)).toMatch(/^\d{6}$/);
    }
  });

  it('is not constant', () => {
    const seen = new Set(Array.from({ length: 40 }, () => randomPin(6)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('safeEqual', () => {
  it('compares by value regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('short', 'a much longer string')).toBe(false);
  });
});

describe('signedToken / verifySignedToken', () => {
  it('round-trips a payload', () => {
    const token = signedToken('manage:42:person@example.test');
    expect(verifySignedToken(token)).toBe('manage:42:person@example.test');
  });

  it('rejects a tampered payload', () => {
    const token = signedToken('manage:42:person@example.test');
    const forged = Buffer.from('manage:43:person@example.test', 'utf8').toString('base64url') +
      '.' + token.split('.')[1];
    expect(verifySignedToken(forged)).toBeNull();
  });

  it('rejects a tampered signature and malformed tokens', () => {
    const token = signedToken('manage:1:a@b.test');
    expect(verifySignedToken(token.slice(0, -2) + 'xy')).toBeNull();
    expect(verifySignedToken('no-dot-here')).toBeNull();
    expect(verifySignedToken('')).toBeNull();
    expect(verifySignedToken('.sig')).toBeNull();
  });

  it('is URL-safe', () => {
    const token = signedToken('manage:1:someone+tag@example.test');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
