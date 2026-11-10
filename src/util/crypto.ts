import crypto from 'node:crypto';
import { config } from '../config.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

/**
 * Password/PIN hashing with scrypt from Node's standard library. Chosen over
 * bcrypt/argon2 to avoid a native dependency; scrypt is memory-hard and is an
 * appropriate choice for password storage.
 *
 * Stored format: scrypt$N$r$p$<salt-hex>$<hash-hex>
 */
export function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain.normalize('NFKC'), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

export function verifySecret(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'hex');
    expected = Buffer.from(parts[5] as string, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(plain.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Constant-time comparison of two strings of possibly differing length.
 * Hashing first keeps the comparison length-independent.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** A cryptographically random numeric PIN, uniformly distributed per digit. */
export function randomPin(digits = 6): string {
  let out = '';
  while (out.length < digits) {
    const byte = crypto.randomBytes(1)[0] as number;
    // Rejection sampling: 250 is the largest multiple of 10 under 256.
    if (byte >= 250) continue;
    out += String(byte % 10);
  }
  return out;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** HMAC used for stateless unsubscribe and manage links. */
export function sign(payload: string): string {
  return crypto.createHmac('sha256', config.TOKEN_SECRET).update(payload, 'utf8').digest('base64url');
}

export function signedToken(payload: string): string {
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return encoded + '.' + sign(payload);
}

export function verifySignedToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  if (mac.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))
    ? payload
    : null;
}
