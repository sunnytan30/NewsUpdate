import { esc } from '../util/html.js';
import { config } from '../config.js';
import { offsetLabel, supportedTimeZones } from '../util/timezone.js';
import type { Source } from '../services/sources.js';
import type { Subscriber } from '../services/subscribers.js';
import type { DeliveryRow, RunRow } from '../services/digest.js';

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#f6f7f9; --card:#fff; --ink:#111827; --muted:#6b7280; --line:#e5e7eb;
  --accent:#1d4ed8; --accent-ink:#fff; --ok-bg:#ecfdf5; --ok-ink:#065f46;
  --err-bg:#fef2f2; --err-ink:#991b1b; --warn-bg:#fffbeb; --warn-ink:#92400e;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0f1115; --card:#171a21; --ink:#e5e7eb; --muted:#9ca3af; --line:#2a2f3a;
    --accent:#6b8afd; --accent-ink:#0f1115; --ok-bg:#06281f; --ok-ink:#6ee7b7;
    --err-bg:#2a1214; --err-ink:#fca5a5; --warn-bg:#2a2209; --warn-ink:#fcd34d;
  }
}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,
  'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;padding:24px 16px}
.wrap{max-width:780px;margin:0 auto}
.wrap.wide{max-width:1100px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin-bottom:20px}
h1{font-size:24px;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 10px}
h3{font-size:15px;margin:0 0 8px}
p{margin:10px 0}
.lede{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:14px;font-weight:600;margin:16px 0 6px}
input[type=text],input[type=email],input[type=url],input[type=password],input[type=number],select{
  width:100%;padding:10px 12px;font-size:15px;color:var(--ink);background:var(--bg);
  border:1px solid var(--line);border-radius:8px}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}
.hint{font-size:13px;color:var(--muted);margin:6px 0 0}
button,.btn{display:inline-block;margin-top:18px;padding:10px 18px;font-size:15px;font-weight:600;
  border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);cursor:pointer;
  text-decoration:none}
button.secondary,.btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--err-ink);border:1px solid var(--line)}
button.tiny{margin:0;padding:5px 10px;font-size:13px}
.msg{padding:12px 14px;border-radius:8px;margin:0 0 18px;font-size:14px}
.msg.ok{background:var(--ok-bg);color:var(--ok-ink)}
.msg.err{background:var(--err-bg);color:var(--err-ink)}
.msg.warn{background:var(--warn-bg);color:var(--warn-ink)}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.pill.active{background:var(--ok-bg);color:var(--ok-ink)}
.pill.pending{background:var(--warn-bg);color:var(--warn-ink)}
.pill.unsubscribed{background:var(--err-bg);color:var(--err-ink)}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.row>*{flex:1 1 180px}
.row>.narrow{flex:0 0 120px}
.inline{display:inline}
code{background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:4px;font-size:13px}
.src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:8px}
a{color:var(--accent)}
.pin{letter-spacing:6px;font-size:20px;text-align:center}
@media (max-width:600px){.card{padding:18px}body{padding:16px 12px}}
`;

export type Flash = { kind: 'ok' | 'err' | 'warn'; text: string } | null;

function flashHtml(flash: Flash): string {
  if (!flash) return '';
  return `<div class="msg ${esc(flash.kind)}">${esc(flash.text)}</div>`;
}

export function layout(opts: {
  title: string;
  body: string;
  wide?: boolean;
  noindex?: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<title>${esc(opts.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap${opts.wide ? ' wide' : ''}">
${opts.body}
</div>
</body>
</html>`;
}

function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}

/**
 * Timezone picker, built from the runtime's own IANA list.
 *
 * The app carries no JavaScript, so the browser's zone cannot be detected
 * automatically; the subscriber chooses, with the configured default selected.
 * Offsets are cached per render, since computing 418 of them is not free.
 */
let zoneOptionsCache: { builtAt: number; html: string } | null = null;
const ZONE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function zoneOptionsHtml(): string {
  if (zoneOptionsCache && Date.now() - zoneOptionsCache.builtAt < ZONE_CACHE_TTL_MS) {
    return zoneOptionsCache.html;
  }
  const html = supportedTimeZones()
    .map((zone) => {
      const offset = offsetLabel(zone);
      const label = offset ? `${zone.replace(/_/g, ' ')} (${offset})` : zone.replace(/_/g, ' ');
      return `<option value="${esc(zone)}">${esc(label)}</option>`;
    })
    .join('');
  zoneOptionsCache = { builtAt: Date.now(), html };
  return html;
}

/**
 * Hour-of-day picker, 00:00 to 23:00.
 *
 * `selected` is the hour to preselect; `defaultHour` is the global default,
 * labelled as such on the "follow the default" option so the subscriber can
 * see what they would get by not choosing. Passing `selected: null` selects
 * that option.
 */
function hourSelect(opts: {
  id: string;
  name: string;
  selected: number | null;
  defaultHour: number;
}): string {
  const pad = (h: number) => String(h).padStart(2, '0');
  const options = [
    `<option value=""${opts.selected === null ? ' selected' : ''}>` +
      `Use the default (${esc(pad(opts.defaultHour))}:00)</option>`,
    ...Array.from({ length: 24 }, (_v, hour) => {
      const chosen = opts.selected === hour ? ' selected' : '';
      return `<option value="${hour}"${chosen}>${esc(pad(hour))}:00</option>`;
    }),
  ].join('');
  return `<select id="${esc(opts.id)}" name="${esc(opts.name)}">${options}</select>`;
}

function timezoneSelect(opts: { id: string; name: string; selected: string }): string {
  // Mark the selected option without rebuilding the cached list.
  const needle = `<option value="${esc(opts.selected)}">`;
  const options = zoneOptionsHtml().replace(
    needle,
    `<option value="${esc(opts.selected)}" selected>`,
  );
  return `<select id="${esc(opts.id)}" name="${esc(opts.name)}">${options}</select>`;
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------

export function signupPage(opts: {
  csrf: string;
  flash: Flash;
  name?: string;
  email?: string;
  timezone?: string;
  /** Hour submitted on a failed attempt, so the form keeps their choice. */
  chosenHour?: number | null;
  signupsOpen: boolean;
  sourceLimit: number;
  sendHour: number;
}): string {
  const hour = String(opts.sendHour).padStart(2, '0');
  const body = `
<div class="card">
  <h1>Daily news digest</h1>
  <p class="lede">
    Choose the news sites you follow. Each morning you get one email: the stories your
    sources agree on, each with a thirty-second summary and a link to the original.
  </p>
  ${flashHtml(opts.flash)}
  ${
    opts.signupsOpen
      ? `<form method="post" action="/signup" novalidate>
    ${csrfField(opts.csrf)}
    <label for="name">Your name</label>
    <input id="name" name="name" type="text" required maxlength="80" autocomplete="name"
           value="${esc(opts.name ?? '')}">
    <p class="hint">Used to greet you and in the email subject line.</p>

    <label for="email">Email address</label>
    <input id="email" name="email" type="email" required maxlength="254" autocomplete="email"
           value="${esc(opts.email ?? '')}">
    <p class="hint">We send a 6-digit code to confirm the address is yours.</p>

    <div class="row">
      <div>
        <label for="timezone">Your timezone</label>
        ${timezoneSelect({
          id: 'timezone',
          name: 'timezone',
          selected: opts.timezone ?? config.DEFAULT_TIMEZONE,
        })}
      </div>
      <div>
        <label for="send_hour">Delivery time</label>
        ${hourSelect({
          id: 'send_hour',
          name: 'send_hour',
          selected: opts.chosenHour ?? null,
          defaultHour: opts.sendHour,
        })}
      </div>
    </div>
    <p class="hint">
      Your digest arrives at the hour you pick, in your own timezone. Leave it on the default
      and you will get it at ${esc(hour)}:00 local time. Both can be changed later.
    </p>

    <button type="submit">Send me a code</button>
  </form>`
      : `<div class="msg warn">Sign-ups are closed at the moment.</div>`
  }
</div>
<div class="card">
  <h3>How it works</h3>
  <p class="hint">
    1. Confirm your email with the code we send.<br>
    2. Add up to ${esc(opts.sourceLimit)} news sites (https only).<br>
    3. Receive your digest at your chosen hour, your local time. Unsubscribe from any email.
  </p>
</div>
<footer>Already signed up? Use the manage link in any digest email.</footer>`;
  return layout({ title: 'Daily news digest', body });
}

export function verifyPage(opts: {
  csrf: string;
  flash: Flash;
  email: string;
  purpose: 'verify' | 'manage';
}): string {
  const body = `
<div class="card">
  <h1>Enter your code</h1>
  <p class="lede">
    We have emailed a 6-digit code to <strong>${esc(opts.email)}</strong>. It expires in 15 minutes.
  </p>
  ${flashHtml(opts.flash)}
  <form method="post" action="/verify" novalidate>
    ${csrfField(opts.csrf)}
    <input type="hidden" name="email" value="${esc(opts.email)}">
    <input type="hidden" name="purpose" value="${esc(opts.purpose)}">
    <label for="pin">6-digit code</label>
    <input id="pin" class="pin" name="pin" type="text" inputmode="numeric" pattern="[0-9]*"
           maxlength="6" required autocomplete="one-time-code" autofocus>
    <button type="submit">Confirm</button>
  </form>
</div>
<div class="card">
  <p class="hint">
    No code? Check your spam folder, then
    <a href="/">start again</a> to request a new one.
  </p>
</div>`;
  return layout({ title: 'Enter your code', body, noindex: true });
}

function sourceRow(source: Source, csrf: string, token: string): string {
  const status =
    source.last_status === 'error'
      ? `<span class="pill unsubscribed">error</span>`
      : source.last_status === 'ok'
        ? `<span class="pill active">ok</span>`
        : `<span class="pill pending">not yet fetched</span>`;

  return `<tr>
  <td>
    <div class="src">${esc(source.url)}</div>
    ${source.label ? `<div class="hint">${esc(source.label)}</div>` : ''}
    ${source.feed_url ? `<div class="hint">Feed detected</div>` : ''}
    ${source.last_error ? `<div class="hint">${esc(source.last_error)}</div>` : ''}
  </td>
  <td>${status}</td>
  <td>
    <form method="post" action="/manage/${esc(token)}/sources/${esc(source.id)}/delete" class="inline">
      ${csrfField(csrf)}
      <button type="submit" class="danger tiny">Remove</button>
    </form>
  </td>
</tr>`;
}

export function managePage(opts: {
  csrf: string;
  flash: Flash;
  token: string;
  subscriber: Subscriber;
  sources: Source[];
  limit: number;
  /** The global default hour, shown on the "use the default" option. */
  defaultHour: number;
  /** The hour this subscriber actually receives their digest. */
  effectiveHour: number;
}): string {
  const atLimit = opts.sources.length >= opts.limit;
  const hour = String(opts.effectiveHour).padStart(2, '0');
  const offset = offsetLabel(opts.subscriber.timezone);
  const body = `
<div class="card">
  <h1>Your sources</h1>
  <p class="lede">
    ${esc(opts.subscriber.name)} &middot; ${esc(opts.subscriber.email)} &middot;
    using ${esc(opts.sources.length)} of ${esc(opts.limit)} allowed sources
  </p>
  ${flashHtml(opts.flash)}

  ${
    opts.sources.length > 0
      ? `<table>
    <thead><tr><th>Source</th><th>Last fetch</th><th></th></tr></thead>
    <tbody>${opts.sources.map((s) => sourceRow(s, opts.csrf, opts.token)).join('')}</tbody>
  </table>`
      : `<p class="hint">You have no sources yet. Add one below to start receiving digests.</p>`
  }
</div>

<div class="card">
  <h2>Add a source</h2>
  ${
    atLimit
      ? `<div class="msg warn">
        You have reached your limit of ${esc(opts.limit)}. Remove a source to add another.
      </div>`
      : `<form method="post" action="/manage/${esc(opts.token)}/sources" novalidate>
    ${csrfField(opts.csrf)}
    <div class="row">
      <div>
        <label for="url">News site or feed URL</label>
        <input id="url" name="url" type="url" required maxlength="2000"
               placeholder="https://www.example.com/news">
      </div>
      <div>
        <label for="label">Label (optional)</label>
        <input id="label" name="label" type="text" maxlength="80" placeholder="Example News">
      </div>
    </div>
    <p class="hint">
      Must begin with <code>https://</code>. A homepage, a section page or an RSS/Atom feed all work;
      we look for a feed first and fall back to reading the page.
    </p>
    <button type="submit">Add source</button>
  </form>`
  }
</div>

<div class="card">
  <h2>Delivery time</h2>
  <p class="hint">
    Your digest is sent at <strong>${esc(hour)}:00</strong> in
    <strong>${esc(opts.subscriber.timezone.replace(/_/g, ' '))}</strong>${offset ? ` (${esc(offset)})` : ''}.
    Change either if you move, or if a different hour suits you better.
  </p>
  <form method="post" action="/manage/${esc(opts.token)}/schedule">
    ${csrfField(opts.csrf)}
    <div class="row">
      <div>
        <label for="timezone">Timezone</label>
        ${timezoneSelect({ id: 'timezone', name: 'timezone', selected: opts.subscriber.timezone })}
      </div>
      <div>
        <label for="send_hour">Hour</label>
        ${hourSelect({
          id: 'send_hour',
          name: 'send_hour',
          selected: opts.subscriber.send_hour,
          defaultHour: opts.defaultHour,
        })}
      </div>
    </div>
    <p class="hint">
      A change takes effect from your next digest. If today's has already been sent, the new time
      applies from tomorrow.
    </p>
    <button type="submit">Save delivery time</button>
  </form>
</div>

<div class="card">
  <h2>Subscription</h2>
  <p class="hint">Status: <span class="pill ${esc(opts.subscriber.status)}">${esc(opts.subscriber.status)}</span></p>
  <form method="post" action="/manage/${esc(opts.token)}/unsubscribe">
    ${csrfField(opts.csrf)}
    <button type="submit" class="danger">Unsubscribe</button>
  </form>
</div>`;
  return layout({ title: 'Your sources', body, noindex: true });
}

export function unsubscribePage(opts: { csrf: string; token: string; email: string }): string {
  const body = `
<div class="card">
  <h1>Unsubscribe</h1>
  <p class="lede">Stop sending the daily digest to <strong>${esc(opts.email)}</strong>?</p>
  <form method="post" action="/unsubscribe/${esc(opts.token)}">
    ${csrfField(opts.csrf)}
    <button type="submit" class="danger">Yes, unsubscribe</button>
  </form>
</div>`;
  return layout({ title: 'Unsubscribe', body, noindex: true });
}

export function noticePage(opts: { title: string; message: string; kind?: 'ok' | 'err' | 'warn' }): string {
  const body = `
<div class="card">
  <h1>${esc(opts.title)}</h1>
  <div class="msg ${esc(opts.kind ?? 'ok')}">${esc(opts.message)}</div>
  <p class="hint"><a href="/">Back to the start</a></p>
</div>`;
  return layout({ title: opts.title, body, noindex: true });
}

// ---------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------

export function adminLoginPage(opts: { csrf: string; flash: Flash; adminPath: string; needsSetup: boolean }): string {
  const body = `
<div class="card">
  <h1>Administrator sign-in</h1>
  <p class="lede">This console is restricted to a single bound account.</p>
  ${flashHtml(opts.flash)}
  ${
    opts.needsSetup
      ? `<div class="msg warn">
      No admin password has been set yet. Run <code>npm run admin:password</code> on the server first.
    </div>`
      : `<form method="post" action="${esc(opts.adminPath)}/login" novalidate>
    ${csrfField(opts.csrf)}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="username">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>`
  }
</div>`;
  return layout({ title: 'Administrator sign-in', body, noindex: true });
}

function subscriberRow(
  row: Subscriber & { source_count: number; effective_limit: number; effective_hour: number },
  csrf: string,
  adminPath: string,
): string {
  return `<tr>
  <td>
    <div>${esc(row.name)}</div>
    <div class="hint">${esc(row.email)}</div>
  </td>
  <td><span class="pill ${esc(row.status)}">${esc(row.status)}</span></td>
  <td>${esc(row.source_count)}</td>
  <td>
    <form method="post" action="${esc(adminPath)}/subscribers/${esc(row.id)}/limit" class="row">
      ${csrfField(csrf)}
      <input class="narrow" type="number" name="limit" min="0" max="100"
             value="${esc(row.source_limit ?? '')}" placeholder="${esc(row.effective_limit)}">
      <button type="submit" class="secondary tiny">Save</button>
    </form>
    <div class="hint">Blank uses the default (${esc(row.effective_limit)}).</div>
  </td>
  <td>
    <div class="hint">${esc(String(row.effective_hour).padStart(2, '0'))}:00${
      row.send_hour === null ? ' (default)' : ''
    }</div>
    <div class="hint">${esc(row.timezone.replace(/_/g, ' '))}</div>
  </td>
  <td>
    <div class="hint">${esc(row.last_digest_sent_at ?? 'never')}</div>
  </td>
  <td>
    <form method="post" action="${esc(adminPath)}/subscribers/${esc(row.id)}/status" class="inline">
      ${csrfField(csrf)}
      <input type="hidden" name="status" value="${row.status === 'active' ? 'unsubscribed' : 'active'}">
      <button type="submit" class="secondary tiny">
        ${row.status === 'active' ? 'Deactivate' : 'Activate'}
      </button>
    </form>
  </td>
</tr>`;
}

export function adminDashboard(opts: {
  csrf: string;
  flash: Flash;
  adminPath: string;
  adminEmail: string;
  settings: {
    defaultSourceLimit: number;
    maxStories: number;
    signupsOpen: boolean;
    minSourcesForTrending: number;
    sendHour: number;
  };
  subscribers: (Subscriber & { source_count: number; effective_limit: number; effective_hour: number })[];
  runs: RunRow[];
  deliveries: DeliveryRow[];
  summariser: string;
}): string {
  const body = `
<div class="card">
  <h1>Administration</h1>
  <p class="lede">
    Signed in as ${esc(opts.adminEmail)} &middot; summariser: <code>${esc(opts.summariser)}</code>
    &middot; sweep: <code>${esc(config.DIGEST_SWEEP_CRON)}</code>
    &middot; default timezone: <code>${esc(config.DEFAULT_TIMEZONE)}</code>
  </p>
  ${flashHtml(opts.flash)}
  <form method="post" action="${esc(opts.adminPath)}/logout" class="inline">
    ${csrfField(opts.csrf)}
    <button type="submit" class="secondary">Sign out</button>
  </form>
</div>

<div class="card">
  <h2>Settings</h2>
  <form method="post" action="${esc(opts.adminPath)}/settings">
    ${csrfField(opts.csrf)}
    <div class="row">
      <div>
        <label for="default_source_limit">Sources allowed per subscriber</label>
        <input id="default_source_limit" name="default_source_limit" type="number" min="1" max="100"
               value="${esc(opts.settings.defaultSourceLimit)}" required>
      </div>
      <div>
        <label for="max_stories">Stories per email</label>
        <input id="max_stories" name="max_stories" type="number" min="1" max="30"
               value="${esc(opts.settings.maxStories)}" required>
      </div>
      <div>
        <label for="min_sources_trending">Sources needed to mark "trending"</label>
        <input id="min_sources_trending" name="min_sources_trending" type="number" min="2" max="20"
               value="${esc(opts.settings.minSourcesForTrending)}" required>
      </div>
      <div>
        <label for="send_hour">Default send hour (local time)</label>
        <input id="send_hour" name="send_hour" type="number" min="0" max="23"
               value="${esc(opts.settings.sendHour)}" required>
      </div>
      <div>
        <label for="signups_open">Sign-ups</label>
        <select id="signups_open" name="signups_open">
          <option value="true" ${opts.settings.signupsOpen ? 'selected' : ''}>Open</option>
          <option value="false" ${opts.settings.signupsOpen ? '' : 'selected'}>Closed</option>
        </select>
      </div>
    </div>
    <p class="hint">
      The per-subscriber limit applies to new additions. Lowering it does not remove sources a
      subscriber has already saved.
    </p>
    <p class="hint">
      The send hour is applied in each subscriber's own timezone, so nobody is emailed overnight.
      It is only the default: a subscriber who picked their own hour keeps it, and changing this
      moves everyone who did not. A digest missed because the service was down is still sent if
      the subscriber's local time is within four hours of their hour; after that it waits for the
      next day.
    </p>
    <button type="submit">Save settings</button>
  </form>
</div>

<div class="card">
  <h2>Subscribers (${esc(opts.subscribers.length)})</h2>
  ${
    opts.subscribers.length === 0
      ? '<p class="hint">No subscribers yet.</p>'
      : `<table>
    <thead><tr><th>Person</th><th>Status</th><th>Sources</th><th>Source limit</th><th>Delivery</th><th>Last digest</th><th></th></tr></thead>
    <tbody>${opts.subscribers.map((s) => subscriberRow(s, opts.csrf, opts.adminPath)).join('')}</tbody>
  </table>`
  }
</div>

<div class="card">
  <h2>Digest runs</h2>
  <form method="post" action="${esc(opts.adminPath)}/run-now" class="inline">
    ${csrfField(opts.csrf)}
    <button type="submit" class="secondary">Run a digest now</button>
  </form>
  ${
    opts.runs.length === 0
      ? '<p class="hint">No runs recorded yet.</p>'
      : `<table>
    <thead><tr><th>Started</th><th>Status</th><th>Sources ok/failed</th><th>Articles</th><th>Sent/failed</th><th>Note</th></tr></thead>
    <tbody>${opts.runs
      .map(
        (r) => `<tr>
      <td>${esc(r.started_at)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.sources_fetched)} / ${esc(r.sources_failed)}</td>
      <td>${esc(r.articles_found)}</td>
      <td>${esc(r.emails_sent)} / ${esc(r.emails_failed)}</td>
      <td class="hint">${esc(r.error ?? '')}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>`
  }
</div>

<div class="card">
  <h2>Recent deliveries</h2>
  ${
    opts.deliveries.length === 0
      ? '<p class="hint">Nothing sent yet.</p>'
      : `<table>
    <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Stories</th><th>Status</th></tr></thead>
    <tbody>${opts.deliveries
      .map(
        (d) => `<tr>
      <td>${esc(d.created_at)}</td>
      <td>${esc(d.email ?? '(deleted)')}</td>
      <td>${esc(d.subject)}</td>
      <td>${esc(d.story_count)}</td>
      <td>${esc(d.status)}${d.error ? `<div class="hint">${esc(d.error)}</div>` : ''}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>`
  }
</div>`;
  return layout({ title: 'Administration', body, wide: true, noindex: true });
}
