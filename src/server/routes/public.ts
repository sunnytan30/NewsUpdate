import { Router, type Response } from 'express';
import { z } from 'zod';
import { getSettingBool, getSettingInt, SETTING_KEYS } from '../../db/index.js';
import { config } from '../../config.js';
import { log } from '../../util/logger.js';
import { rateLimit, resetRateLimit } from '../middleware.js';
import {
  managePage,
  noticePage,
  signupPage,
  unsubscribePage,
  verifyPage,
  type Flash,
} from '../views.js';
import {
  checkPin,
  cleanName,
  effectiveSourceLimit,
  manageToken,
  normaliseEmail,
  PIN_TTL_MINUTES,
  sendHour,
  setStatus,
  setTimezone,
  startSignup,
  subscriberFromToken,
} from '../../services/subscribers.js';
import { addSource, listSources, removeSource } from '../../services/sources.js';
import { verificationEmail } from '../../services/templates.js';
import { sendMail } from '../../services/mailer.js';

export const publicRouter = Router();

const SignupSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(254),
  // Validated against the IANA list in resolveTimezone; an unrecognised value
  // falls back to the configured default rather than failing the sign-up.
  timezone: z.string().max(64).optional(),
});

const TimezoneSchema = z.object({
  timezone: z.string().min(1).max(64),
});

const VerifySchema = z.object({
  email: z.string().email().max(254),
  pin: z.string().regex(/^\d{4,8}$/),
  purpose: z.enum(['verify', 'manage']).default('verify'),
});

const AddSourceSchema = z.object({
  url: z.string().min(1).max(2000),
  label: z.string().max(80).optional(),
});

function defaultLimit(): number {
  return getSettingInt(SETTING_KEYS.defaultSourceLimit, config.DEFAULT_SOURCE_LIMIT);
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

publicRouter.get('/', (_req, res) => {
  res.type('html').send(
    signupPage({
      csrf: res.locals.csrf as string,
      flash: null,
      signupsOpen: getSettingBool(SETTING_KEYS.signupsOpen, true),
      sourceLimit: defaultLimit(),
      sendHour: sendHour(),
    }),
  );
});

publicRouter.post(
  '/signup',
  rateLimit({ name: 'signup', max: 5, windowMs: 15 * 60_000 }),
  async (req, res) => {
    const signupsOpen = getSettingBool(SETTING_KEYS.signupsOpen, true);
    const submittedZone = typeof req.body?.timezone === 'string' ? req.body.timezone : undefined;
    const render = (flash: Flash, name?: string, email?: string) =>
      res.type('html').send(
        signupPage({
          csrf: res.locals.csrf as string,
          flash,
          name,
          email,
          timezone: submittedZone,
          signupsOpen,
          sourceLimit: defaultLimit(),
          sendHour: sendHour(),
        }),
      );

    if (!signupsOpen) {
      render({ kind: 'warn', text: 'Sign-ups are closed at the moment.' });
      return;
    }

    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      render(
        { kind: 'err', text: 'Please enter your name and a valid email address.' },
        typeof req.body?.name === 'string' ? req.body.name : '',
        typeof req.body?.email === 'string' ? req.body.email : '',
      );
      return;
    }

    const name = cleanName(parsed.data.name);
    if (name === '') {
      render({ kind: 'err', text: 'Please enter your name.' }, '', parsed.data.email);
      return;
    }

    const email = normaliseEmail(parsed.data.email);
    const outcome = startSignup(name, email, parsed.data.timezone);

    if (outcome.kind === 'pin-sent') {
      const mail = verificationEmail({
        name: outcome.subscriber.name,
        pin: outcome.pin,
        minutes: PIN_TTL_MINUTES,
      });
      const sent = await sendMail({
        to: outcome.subscriber.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      if (!sent.ok) {
        log.error('verification email failed to send', { error: sent.error });
      }
    } else {
      // Throttled. We still show the same page: whether an address already has
      // a code outstanding is not something the form should reveal.
      log.warn('verification throttled for an address');
    }

    // The same response either way, so the form cannot be used to discover
    // which addresses are registered.
    res.type('html').send(
      verifyPage({
        csrf: res.locals.csrf as string,
        flash: { kind: 'ok', text: 'If that address can receive mail, a code is on its way.' },
        email,
        purpose: outcome.kind === 'pin-sent' ? outcome.purpose : 'verify',
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// PIN verification
// ---------------------------------------------------------------------------

publicRouter.post(
  '/verify',
  rateLimit({ name: 'verify', max: 12, windowMs: 15 * 60_000 }),
  (req, res) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).type('html').send(
        noticePage({
          title: 'Invalid request',
          message: 'That code was not in the expected format. Please start again.',
          kind: 'err',
        }),
      );
      return;
    }

    const { email, pin, purpose } = parsed.data;
    const result = checkPin(email, pin, purpose);

    if (!result.ok) {
      res.status(400).type('html').send(
        verifyPage({
          csrf: res.locals.csrf as string,
          flash: { kind: 'err', text: result.reason },
          email,
          purpose,
        }),
      );
      return;
    }

    resetRateLimit('verify', req);
    // Send the subscriber to their own manage page using a signed token.
    res.redirect(303, `/manage/${manageToken(result.subscriber)}`);
  },
);

// ---------------------------------------------------------------------------
// Manage sources
// ---------------------------------------------------------------------------

function renderManage(res: Response, token: string, flash: Flash): void {
  const subscriber = subscriberFromToken(token, 'manage');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({
        title: 'Link not valid',
        message: 'That link is not valid or has expired. Sign up again to get a new one.',
        kind: 'err',
      }),
    );
    return;
  }
  res.type('html').send(
    managePage({
      csrf: res.locals.csrf as string,
      flash,
      token,
      subscriber,
      sources: listSources(subscriber.id),
      limit: effectiveSourceLimit(subscriber),
      sendHour: sendHour(),
    }),
  );
}

publicRouter.get('/manage/:token', (req, res) => {
  renderManage(res, req.params.token as string, null);
});

publicRouter.post(
  '/manage/:token/sources',
  rateLimit({ name: 'addsource', max: 30, windowMs: 15 * 60_000 }),
  async (req, res) => {
    const token = req.params.token as string;
    const subscriber = subscriberFromToken(token, 'manage');
    if (!subscriber) {
      res.status(404).type('html').send(
        noticePage({ title: 'Link not valid', message: 'That link is not valid.', kind: 'err' }),
      );
      return;
    }

    const parsed = AddSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      renderManage(res, token, { kind: 'err', text: 'Enter a URL beginning with https://' });
      return;
    }

    const result = await addSource(subscriber, parsed.data.url, parsed.data.label);
    renderManage(
      res,
      token,
      result.ok
        ? { kind: 'ok', text: `Added ${result.source.host}. It will be included in your next digest.` }
        : { kind: 'err', text: result.reason },
    );
  },
);

publicRouter.post('/manage/:token/sources/:id/delete', (req, res) => {
  const token = req.params.token as string;
  const subscriber = subscriberFromToken(token, 'manage');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({ title: 'Link not valid', message: 'That link is not valid.', kind: 'err' }),
    );
    return;
  }
  const id = Number(req.params.id);
  const removed = Number.isInteger(id) && removeSource(subscriber.id, id);
  renderManage(
    res,
    token,
    removed
      ? { kind: 'ok', text: 'Source removed.' }
      : { kind: 'err', text: 'That source could not be found.' },
  );
});

publicRouter.post('/manage/:token/timezone', (req, res) => {
  const token = req.params.token as string;
  const subscriber = subscriberFromToken(token, 'manage');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({ title: 'Link not valid', message: 'That link is not valid.', kind: 'err' }),
    );
    return;
  }

  const parsed = TimezoneSchema.safeParse(req.body);
  if (!parsed.success) {
    renderManage(res, token, { kind: 'err', text: 'Choose a timezone from the list.' });
    return;
  }

  // setTimezone validates against the IANA list and refuses anything else, so
  // a hand-crafted POST cannot store a bogus zone.
  if (!setTimezone(subscriber.id, parsed.data.timezone)) {
    renderManage(res, token, { kind: 'err', text: 'That is not a timezone we recognise.' });
    return;
  }

  const hour = String(sendHour()).padStart(2, '0');
  renderManage(res, token, {
    kind: 'ok',
    text: `Timezone saved. Your digest will arrive at ${hour}:00 ${parsed.data.timezone.replace(/_/g, ' ')}.`,
  });
});

publicRouter.post('/manage/:token/unsubscribe', (req, res) => {
  const subscriber = subscriberFromToken(req.params.token as string, 'manage');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({ title: 'Link not valid', message: 'That link is not valid.', kind: 'err' }),
    );
    return;
  }
  setStatus(subscriber.id, 'unsubscribed');
  res.type('html').send(
    noticePage({
      title: 'Unsubscribed',
      message: 'You will not receive any further digests. Your sources have been kept in case you return.',
    }),
  );
});

// ---------------------------------------------------------------------------
// Unsubscribe links from emails
// ---------------------------------------------------------------------------

publicRouter.get('/unsubscribe/:token', (req, res) => {
  const token = req.params.token as string;
  const subscriber = subscriberFromToken(token, 'unsub');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({ title: 'Link not valid', message: 'That unsubscribe link is not valid.', kind: 'err' }),
    );
    return;
  }
  res.type('html').send(
    unsubscribePage({ csrf: res.locals.csrf as string, token, email: subscriber.email }),
  );
});

publicRouter.post('/unsubscribe/:token', (req, res) => {
  const subscriber = subscriberFromToken(req.params.token as string, 'unsub');
  if (!subscriber) {
    res.status(404).type('html').send(
      noticePage({ title: 'Link not valid', message: 'That unsubscribe link is not valid.', kind: 'err' }),
    );
    return;
  }
  setStatus(subscriber.id, 'unsubscribed');
  res.type('html').send(
    noticePage({ title: 'Unsubscribed', message: 'You will not receive any further digests.' }),
  );
});

// ---------------------------------------------------------------------------
// Operational endpoints
// ---------------------------------------------------------------------------

publicRouter.get('/healthz', (_req, res) => {
  res.type('text').send('ok');
});

publicRouter.get('/robots.txt', (_req, res) => {
  // This is a private subscription tool; keep it out of search indexes.
  res.type('text').send('User-agent: *\nDisallow: /\n');
});
