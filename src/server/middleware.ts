import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { randomToken, safeEqual } from '../util/crypto.js';
import { noticePage } from './views.js';

const CSRF_COOKIE = 'nu_csrf';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // The pages carry no JavaScript at all, so scripts can be blocked outright.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProd && !config.INSECURE_COOKIES) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function cookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !config.INSECURE_COOKIES,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * Issue a CSRF token on every GET and verify it on every state-changing
 * request (double-submit cookie). The token is also bound to the request
 * origin check below.
 */
export function csrf(req: Request, res: Response, next: NextFunction): void {
  const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;

  if (req.method === 'GET' || req.method === 'HEAD') {
    const token = existing ?? randomToken(24);
    if (!existing) res.cookie(CSRF_COOKIE, token, cookieOptions(12 * 3600_000));
    res.locals.csrf = token;
    next();
    return;
  }

  // Reject cross-site form posts outright where the browser tells us the origin.
  const origin = req.get('origin');
  if (origin) {
    let sameSite = false;
    try {
      sameSite = new URL(origin).host === new URL(config.BASE_URL).host || new URL(origin).host === req.get('host');
    } catch {
      sameSite = false;
    }
    if (!sameSite) {
      res.status(403).type('html').send(
        noticePage({ title: 'Request blocked', message: 'That request came from another site.', kind: 'err' }),
      );
      return;
    }
  }

  const submitted = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
  if (!existing || submitted === '' || !safeEqual(existing, submitted)) {
    res.status(403).type('html').send(
      noticePage({
        title: 'Session expired',
        message: 'Your form session expired. Please go back and try again.',
        kind: 'err',
      }),
    );
    return;
  }

  res.locals.csrf = existing;
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting (in-process; sufficient for a single-process deployment)
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// Opportunistic cleanup so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

export function rateLimit(opts: { name: string; max: number; windowMs: number; message?: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${opts.name}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).type('html').send(
        noticePage({
          title: 'Too many requests',
          message: opts.message ?? `Please wait ${retryAfter} seconds and try again.`,
          kind: 'warn',
        }),
      );
      return;
    }
    next();
  };
}

/** Clear a rate-limit bucket, used after a successful action. */
export function resetRateLimit(name: string, req: Request): void {
  buckets.delete(`${name}:${req.ip ?? 'unknown'}`);
}
