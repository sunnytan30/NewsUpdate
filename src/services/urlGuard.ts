import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

/** Query parameters that only carry attribution and never identity of content. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_/i,
  /^_hs/i,
  /^at_/i,
  /^ref$/i,
  /^ref_src$/i,
  /^referrer$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^mkt_tok$/i,
  /^cmpid$/i,
  /^smid$/i,
  /^spm$/i,
];

/**
 * Hostnames that must never be fetched regardless of DNS, because they are
 * conventionally internal or are cloud instance-metadata endpoints.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /\.local$/i,
  /\.internal$/i,
  /\.intranet$/i,
  /^metadata$/i,
  /^metadata\.google\.internal$/i,
];

/**
 * True when the address is globally routable. Rejects loopback, private,
 * link-local, carrier-grade NAT, multicast and reserved ranges, in both IPv4
 * and IPv6, including IPv4-mapped IPv6 addresses.
 */
export function isPublicAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPublicIPv4(ip);
  if (version === 6) return isPublicIPv6(ip);
  return false;
}

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments / RFC6890
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT RFC6598
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped / IPv4-compatible: judge by the embedded IPv4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1] as string);
  if (/^::\d+\.\d+\.\d+\.\d+$/.test(lower)) return false;

  if (lower === '::' || lower === '::1') return false; // unspecified, loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9')) return false; // link-local
  if (lower.startsWith('fea') || lower.startsWith('feb')) return false; // link-local
  if (/^f[cd]/.test(lower)) return false; // unique-local fc00::/7
  if (lower.startsWith('ff')) return false; // multicast
  if (lower.startsWith('2001:db8')) return false; // documentation
  if (lower.startsWith('64:ff9b')) return false; // NAT64
  return true;
}

function hostIsBlocked(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

/**
 * Resolve a hostname and confirm every address it maps to is public.
 * Must be re-run immediately before each fetch, not only at registration.
 */
export async function assertPublicHost(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (config.ALLOW_PRIVATE_NETWORK) return { ok: true };

  if (hostIsBlocked(hostname)) {
    return { ok: false, reason: 'That hostname is not permitted.' };
  }

  // A literal IP in the URL skips DNS entirely.
  if (net.isIP(hostname)) {
    return isPublicAddress(hostname)
      ? { ok: true }
      : { ok: false, reason: 'That address is not publicly routable.' };
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'That hostname could not be resolved.' };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'That hostname could not be resolved.' };
  }
  // Every address must be public: one private answer is enough to reject.
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      return { ok: false, reason: 'That hostname resolves to a non-public address.' };
    }
  }
  return { ok: true };
}

/**
 * Validate a user-supplied source URL.
 *
 * Enforces HTTPS (the explicit requirement) and, beyond it, blocks the
 * server-side request forgery that an unchecked user-supplied URL would
 * otherwise allow.
 */
export async function validateSourceUrl(input: string): Promise<UrlCheck> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Enter a URL.' };
  if (trimmed.length > 2000) return { ok: false, reason: 'That URL is too long.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid URL. Include the https:// prefix.' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https:// URLs are accepted.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URLs must not contain credentials.' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'Only the standard HTTPS port (443) is accepted.' };
  }
  if (url.hostname === '') {
    return { ok: false, reason: 'That URL has no hostname.' };
  }
  // Require a dotted name so bare internal names cannot be used.
  if (!net.isIP(url.hostname) && !url.hostname.includes('.')) {
    return { ok: false, reason: 'Enter a full domain name.' };
  }

  const hostCheck = await assertPublicHost(url.hostname);
  if (!hostCheck.ok) return { ok: false, reason: hostCheck.reason };

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.port === '443') url.port = '';

  return { ok: true, url: url.toString(), host: url.hostname };
}

/**
 * Canonical form of an article URL, used to recognise the same story when two
 * sources link to it with different tracking parameters.
 */
export function canonicaliseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.trim();
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.port === '443' || url.port === '80') url.port = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** Registrable-ish host label used for display and per-host grouping. */
export function displayHost(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, '');
  } catch {
    return input;
  }
}
