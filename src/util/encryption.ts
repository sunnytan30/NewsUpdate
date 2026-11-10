import crypto from 'node:crypto';

/**
 * Field-level encryption for personal data at rest.
 *
 * What this protects against: someone who obtains the database file — a stolen
 * backup, a snapshot of the volume, a copied SQLite file — cannot read the
 * stored email addresses.
 *
 * What it does NOT protect against, and must not be claimed to: an attacker who
 * compromises the running application, its environment variables, or the host.
 * The service has to decrypt addresses in order to send mail, so it necessarily
 * holds the key. Keep the key out of the database and out of version control,
 * and treat application compromise as full exposure.
 *
 * Two primitives are needed, because a column that must be searched cannot be
 * encrypted non-deterministically:
 *
 *   - encryptField / decryptField: AES-256-GCM with a fresh random IV per
 *     value. The same address encrypts differently every time, which is what
 *     you want, and is why it cannot be used in a WHERE clause.
 *   - blindIndex: a keyed HMAC of the normalised value. Deterministic, so it
 *     supports exact lookup and a UNIQUE constraint, while revealing nothing
 *     without the key. Because it is keyed, an attacker holding only the
 *     database cannot test guesses against it.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the standard nonce length for GCM
const KEY_BYTES = 32;

/** Accepts 64 hex characters, or base64/base64url, and requires 32 bytes. */
function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');

  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    throw new Error('ENCRYPTION_KEY could not be decoded as hex or base64.');
  }
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${decoded.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return decoded;
}

/**
 * Two independent subkeys from the one configured key, via HKDF. Using the
 * same bytes for both encryption and the index would mean a single primitive's
 * weakness affected the other; separating them costs nothing.
 */
function subkey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), KEY_BYTES),
  );
}

let encryptionKey: Buffer | null = null;
let indexKey: Buffer | null = null;

/** Called once at startup, from config. */
export function initFieldEncryption(rawKey: string): void {
  const master = decodeKey(rawKey);
  encryptionKey = subkey(master, 'newsupdate/field-encryption/v1');
  indexKey = subkey(master, 'newsupdate/blind-index/v1');
}

function requireKeys(): { enc: Buffer; idx: Buffer } {
  if (!encryptionKey || !indexKey) {
    throw new Error('Field encryption is not initialised: initFieldEncryption was never called.');
  }
  return { enc: encryptionKey, idx: indexKey };
}

export function isFieldEncryptionReady(): boolean {
  return encryptionKey !== null && indexKey !== null;
}

/**
 * Encrypt a value for storage.
 *
 * `context` is bound in as additional authenticated data, so a ciphertext
 * cannot be moved from one column to another and still decrypt.
 *
 * Returned format: v1.<iv>.<tag>.<ciphertext>, each part base64url.
 */
export function encryptField(plaintext: string, context: string): string {
  const { enc } = requireKeys();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', enc, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored value. Throws if the ciphertext, tag or context does not
 * verify — a failure here means the data or the key is wrong, and silently
 * returning something would be worse than stopping.
 */
export function decryptField(stored: string, context: string): string {
  const { enc } = requireKeys();
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored value is not in the expected encrypted format.');
  }
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ciphertext = Buffer.from(parts[3] as string, 'base64url');
  if (iv.length !== IV_BYTES) throw new Error('Encrypted value has a malformed IV.');

  const decipher = crypto.createDecipheriv('aes-256-gcm', enc, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Deterministic, keyed lookup value for an encrypted column.
 *
 * Normalise before calling: the index is only equal for byte-identical input,
 * which is exactly why it can back a UNIQUE constraint.
 */
export function blindIndex(value: string, context: string): string {
  const { idx } = requireKeys();
  return crypto
    .createHmac('sha256', idx)
    .update(context, 'utf8')
    .update('\u0000')
    .update(value, 'utf8')
    .digest('hex');
}

/**
 * A short, non-reversible identifier for the configured key.
 *
 * Stored once and compared on every boot. Without this check, starting with the
 * wrong key is quietly destructive rather than loudly broken: lookups by blind
 * index would all miss, so sign-up would insert a *second* row for an address
 * that already exists, and the original would be stranded.
 */
export function keyFingerprint(): string {
  return blindIndex('key-check', 'newsupdate/key-fingerprint/v1').slice(0, 16);
}

/** Context labels, kept in one place so they cannot drift between call sites. */
export const FIELD = {
  subscriberEmail: 'subscribers.email',
} as const;
