import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { log } from '../../util/logger.js';
import { db, allSettings, getSettingBool, getSettingInt, setSetting, SETTING_KEYS } from '../../db/index.js';
import { adminExists, login, logout, sessionIsValid } from '../../services/admin.js';
import { adminDashboard, adminLoginPage, noticePage, type Flash } from '../views.js';
import { cookieOptions, rateLimit, resetRateLimit } from '../middleware.js';
import {
  effectiveSourceLimit,
  listSubscribers,
  sendHour,
  setSourceLimit,
  setStatus,
  type Subscriber,
} from '../../services/subscribers.js';
import { recentDeliveries, recentRuns, runDigest } from '../../services/digest.js';
import { summariserName } from '../../services/summarise.js';

export const adminRouter = Router();

const ADMIN_COOKIE = 'nu_admin';

/** True while a manually triggered digest run is in flight. */
let manualRunInFlight = false;

function sessionToken(req: Request): string | undefined {
  const value = req.cookies?.[ADMIN_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (sessionIsValid(sessionToken(req))) {
    next();
    return;
  }
  res.status(401).type('html').send(
    adminLoginPage({
      csrf: res.locals.csrf as string,
      flash: { kind: 'err', text: 'Please sign in.' },
      adminPath: config.ADMIN_PATH,
      needsSetup: !adminExists(),
    }),
  );
}

type SubscriberWithCounts = Subscriber & { source_count: number; effective_limit: number };

function subscribersWithCounts(): SubscriberWithCounts[] {
  const counts = db
    .prepare('SELECT subscriber_id, COUNT(*) AS n FROM sources GROUP BY subscriber_id')
    .all() as { subscriber_id: number; n: number }[];
  const byId = new Map(counts.map((c) => [c.subscriber_id, c.n]));

  return listSubscribers().map((subscriber) => ({
    ...subscriber,
    source_count: byId.get(subscriber.id) ?? 0,
    effective_limit: effectiveSourceLimit(subscriber),
  }));
}

function renderDashboard(res: Response, flash: Flash): void {
  const settings = allSettings();
  res.type('html').send(
    adminDashboard({
      csrf: res.locals.csrf as string,
      flash,
      adminPath: config.ADMIN_PATH,
      adminEmail: config.ADMIN_EMAIL,
      settings: {
        defaultSourceLimit: getSettingInt(SETTING_KEYS.defaultSourceLimit, config.DEFAULT_SOURCE_LIMIT),
        maxStories: getSettingInt(SETTING_KEYS.maxStoriesPerEmail, config.MAX_STORIES_PER_EMAIL),
        signupsOpen: getSettingBool(SETTING_KEYS.signupsOpen, true),
        minSourcesForTrending: getSettingInt(SETTING_KEYS.minSourcesForTrending, 2),
        sendHour: sendHour(),
      },
      subscribers: subscribersWithCounts(),
      runs: recentRuns(15),
      deliveries: recentDeliveries(40),
      summariser: settings['summariser'] ?? summariserName(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

adminRouter.get('/', (req, res) => {
  if (sessionIsValid(sessionToken(req))) {
    renderDashboard(res, null);
    return;
  }
  res.type('html').send(
    adminLoginPage({
      csrf: res.locals.csrf as string,
      flash: null,
      adminPath: config.ADMIN_PATH,
      needsSetup: !adminExists(),
    }),
  );
});

const LoginSchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(512),
});

adminRouter.post(
  '/login',
  rateLimit({
    name: 'adminlogin',
    max: 8,
    windowMs: 15 * 60_000,
    message: 'Too many sign-in attempts. Please wait before trying again.',
  }),
  (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    const fail = (text: string) =>
      res.status(401).type('html').send(
        adminLoginPage({
          csrf: res.locals.csrf as string,
          flash: { kind: 'err', text },
          adminPath: config.ADMIN_PATH,
          needsSetup: !adminExists(),
        }),
      );

    if (!parsed.success) {
      fail('Those credentials are not valid.');
      return;
    }

    const result = login(parsed.data.email, parsed.data.password, req.get('user-agent'));
    if (!result.ok) {
      log.warn('admin sign-in failed', { ip: req.ip });
      fail(result.reason);
      return;
    }

    resetRateLimit('adminlogin', req);
    res.cookie(ADMIN_COOKIE, result.token, cookieOptions(result.expiresAt.getTime() - Date.now()));
    res.redirect(303, config.ADMIN_PATH);
  },
);

adminRouter.post('/logout', (req, res) => {
  logout(sessionToken(req));
  res.clearCookie(ADMIN_COOKIE, cookieOptions());
  res.type('html').send(
    noticePage({ title: 'Signed out', message: 'You have been signed out of the console.' }),
  );
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SettingsSchema = z.object({
  default_source_limit: z.coerce.number().int().min(1).max(100),
  max_stories: z.coerce.number().int().min(1).max(30),
  min_sources_trending: z.coerce.number().int().min(2).max(20),
  // Applied in each subscriber's own timezone, so any hour is defensible.
  send_hour: z.coerce.number().int().min(0).max(23),
  signups_open: z.enum(['true', 'false']),
});

adminRouter.post('/settings', requireAdmin, (req, res) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    renderDashboard(res, { kind: 'err', text: 'Those settings are not valid.' });
    return;
  }
  setSetting(SETTING_KEYS.defaultSourceLimit, String(parsed.data.default_source_limit));
  setSetting(SETTING_KEYS.maxStoriesPerEmail, String(parsed.data.max_stories));
  setSetting(SETTING_KEYS.minSourcesForTrending, String(parsed.data.min_sources_trending));
  setSetting(SETTING_KEYS.sendHour, String(parsed.data.send_hour));
  setSetting(SETTING_KEYS.signupsOpen, parsed.data.signups_open);
  log.info('admin updated settings', parsed.data);
  renderDashboard(res, { kind: 'ok', text: 'Settings saved.' });
});

// ---------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------

adminRouter.post('/subscribers/:id/limit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    renderDashboard(res, { kind: 'err', text: 'Unknown subscriber.' });
    return;
  }

  const raw = typeof req.body?.limit === 'string' ? req.body.limit.trim() : '';
  if (raw === '') {
    // Blank clears the override, returning the subscriber to the global default.
    setSourceLimit(id, null);
    renderDashboard(res, { kind: 'ok', text: 'Subscriber now uses the default source limit.' });
    return;
  }

  const limit = Number.parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) {
    renderDashboard(res, { kind: 'err', text: 'The limit must be between 0 and 100.' });
    return;
  }
  setSourceLimit(id, limit);
  renderDashboard(res, { kind: 'ok', text: `Source limit set to ${limit}.` });
});

adminRouter.post('/subscribers/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!Number.isInteger(id) || (status !== 'active' && status !== 'unsubscribed')) {
    renderDashboard(res, { kind: 'err', text: 'That change is not valid.' });
    return;
  }
  setStatus(id, status);
  renderDashboard(res, { kind: 'ok', text: `Subscriber marked ${status}.` });
});

// ---------------------------------------------------------------------------
// Manual digest run
// ---------------------------------------------------------------------------

adminRouter.post('/run-now', requireAdmin, (_req, res) => {
  if (manualRunInFlight) {
    renderDashboard(res, { kind: 'warn', text: 'A digest run is already in progress.' });
    return;
  }
  manualRunInFlight = true;

  // Forced: an explicit "run now" should send to everyone, not only those whose
  // local clock happens to have reached the send hour.
  // Fire and forget: a run can take minutes, far longer than a request should.
  void runDigest({ force: true })
    .catch((error: unknown) => {
      log.error('manual digest run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      manualRunInFlight = false;
    });

  renderDashboard(res, {
    kind: 'ok',
    text:
      'Digest run started for every active subscriber, ignoring their local send time. ' +
      'Reload this page in a minute to see the result.',
  });
});
