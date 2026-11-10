# NewsUpdate

A daily news digest. Subscribers register their own HTTPS news sources; each
morning the service fetches them, works out which stories are corroborated
across more than one of those sources, writes a thirty-second summary of each,
and emails the result.

Self-contained Node.js and TypeScript: Express, SQLite, an in-process
scheduler. No managed services required, and the email provider and the
summariser are both pluggable.

---

## What it does

| Requirement | Where it lives |
|---|---|
| Email confirmed with a PIN before any digest is sent | `src/services/subscribers.ts` |
| Name and email collected at sign-up | `src/server/routes/public.ts` |
| Stories compared across a subscriber's sources, and cross-source agreement surfaced | `src/services/cluster.ts` |
| Each item has a title, a thirty-second summary and a direct link | `src/services/summarise.ts`, `src/services/templates.ts` |
| Subject line `[YYYYMMDD] - Top News Update for [Name]` | `src/services/templates.ts` |
| Admin console on an unguessable path, bound to one email, own password | `src/server/routes/admin.ts`, `src/services/admin.ts` |
| Admin sets how many sources each subscriber may register | `src/server/routes/admin.ts` |
| HTTPS enforced on every source URL | `src/services/urlGuard.ts` |
| Extracted text treated strictly as data, never as instructions | `src/services/summarise.ts` |

---

## Two things to read before you rely on this

### 1. "Trending" means corroborated, not popular

The brief asked for indicators that people are keen on a story. Arbitrary news
sites **do not publish engagement metrics** — no view counts, no share counts,
nothing comparable in any feed or page. There is no honest way to measure what
people are reading from the URLs a subscriber supplies.

So the ranking measures three things it genuinely can, and the email says
"Across N of your sources" rather than claiming popularity:

1. **Corroboration** — how many of the subscriber's distinct publishers carry
   the same story. This dominates the score, and is what the brief described in
   its own second half.
2. **Prominence** — how high the story sits in each publisher's feed, which is
   that publisher's own editorial judgement.
3. **Recency** — with a half-life of about a day.

If you later want a real popularity signal, it has to come from a source that
publishes one: Hacker News points, a Reddit score, a site's own "most read"
feed, or Google Trends. `clusterStories` is where that would slot in.

### 2. Prompt injection is mitigated, not solved

Article text is wrapped in `<source_material>` blocks, the system prompt states
that everything inside them is data, delimiter-closing attempts in the content
are neutralised, the response is constrained by a JSON schema, and the output is
stripped of markup and URLs before rendering. **Links in the email always come
from the fetched source record, never from model output.**

That is defence in depth, not a guarantee. Nobody has solved prompt injection.
The practical consequence here is bounded: the worst a successful injection
achieves is misleading summary text, because it cannot introduce a link, a
script or an HTML tag.

---

## Requirements

- Node.js 20.11 or newer (22 recommended; the Docker image uses 22)
- A transactional email provider with a verified sending domain
- Optionally an Anthropic API key, for good summaries

### Email

Use a real transactional provider — Postmark, Amazon SES, Brevo, Mailgun or
Resend. Gmail SMTP will rate-limit you and land in spam folders as soon as you
have more than a handful of subscribers. Set up SPF, DKIM and DMARC on the
sending domain before you send to anyone but yourself.

### Summaries

| `SUMMARISER` | Needs a key | Quality |
|---|---|---|
| `anthropic` | yes | Proper abstractive summaries; recommended |
| `extractive` | no | Opening sentences of the article. Always works, costs nothing, reads noticeably worse |

The extractive engine is also the automatic per-story fallback whenever a model
call fails, is refused by a safety classifier, or returns nothing parsable — so
a digest still goes out if the API is unavailable.

Default model: `claude-opus-5-5`, at `effort: low`, with the system prompt
cached. Summarising supplied text is a routine task, so low effort is the right
trade. Set `ANTHROPIC_MODEL=claude-haiku-5-5` to cut cost further if you are
happy with the result.

---

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Generate the two secrets and the admin path:

```bash
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'));console.log('TOKEN_SECRET='+require('crypto').randomBytes(32).toString('hex'));console.log('ADMIN_PATH=/console-'+require('crypto').randomBytes(12).toString('hex'))"
```

Put those three lines into `.env`, then fill in `BASE_URL`, `ADMIN_EMAIL`, the
mail provider settings and, if you are using it, `ANTHROPIC_API_KEY`.

Build and set the admin password:

```bash
npm run build
```

```bash
npm run admin:password -- --generate
```

That prints a 24-character password **once**. Store it in a password manager; it
is kept only as a scrypt hash and cannot be recovered. Use
`npm run admin:password` without `--generate` to choose your own (minimum 14
characters). Either way, setting it signs out every existing admin session.

Start it:

```bash
npm start
```

Development, with reload:

```bash
npm run dev
```

### Docker

```bash
docker compose up -d --build
```

The database lives on a named volume at `/data`. Set the admin password inside
the container, using the compiled CLI (the runtime image has no dev
dependencies, so `npm run admin:password` is not available there):

```bash
docker compose exec newsupdate node dist/cli/set-admin-password.js --generate
```

To run a digest by hand in the container:

```bash
docker compose exec newsupdate node dist/cli/run-digest.js
```

---

## Configuration

Every option is documented in [`.env.example`](.env.example). The ones that
matter most:

| Variable | Notes |
|---|---|
| `BASE_URL` | Public URL. Verification and unsubscribe links are built from it, so it must be right |
| `ADMIN_PATH` | Where the console is mounted. Long and random; at least 16 characters in production |
| `ADMIN_EMAIL` | The only address that can sign in to the console. No default in code — set it here |
| `SESSION_SECRET`, `TOKEN_SECRET` | 32+ characters each. Changing `TOKEN_SECRET` invalidates every manage and unsubscribe link |
| `DIGEST_CRON`, `TZ` | Send schedule. Default `0 7 * * *` in `Asia/Singapore` |
| `DEFAULT_SOURCE_LIMIT` | Starting quota. The admin console overrides it, globally and per subscriber |
| `ALLOW_PRIVATE_NETWORK` | Leave `false`. `true` disables the SSRF guard |

Run it behind TLS. Set `TRUST_PROXY=true` behind nginx, Caddy or Cloudflare so
client IPs and secure-cookie detection work; leave `INSECURE_COOKIES=false`.

### If you deploy somewhere with no direct DNS

The SSRF guard resolves each hostname with `dns.lookup` and rejects any that
maps to a private address. In a sandbox or container whose only network path is
an HTTP proxy, `dns.lookup` fails and **every source will be rejected** with
"that hostname could not be resolved". Give the container a working resolver.
Do not reach for `ALLOW_PRIVATE_NETWORK=true` to work around it: that switches
the guard off entirely.

---

## How a subscriber uses it

1. Enters name and email on `/`.
2. Receives a 6-digit code, valid 15 minutes, 5 attempts, at most 3 codes per
   15 minutes per address.
3. On the correct code the address becomes active and they land on a private
   `/manage/<signed-token>` page.
4. They add up to their quota of `https://` sources — a homepage, a section
   page or a feed URL all work.
5. Each morning they get one email. Every email carries manage and unsubscribe
   links, plus `List-Unsubscribe` headers for one-click unsubscribe.

A story is not sent to the same person twice within 14 days.

---

## Scheduling

The scheduler runs in-process by default and will not start a run while one is
still going. To drive it externally instead, set `ENABLE_SCHEDULER=false` and
run:

```bash
npm run digest:run
```

The admin console also has a "Run a digest now" button.

---

## How the pipeline works

```
distinct active sources
   -> fetch each URL once per run (robots.txt respected, per-host throttle,
      byte cap, timeout, redirect hops re-validated)
   -> prefer an advertised RSS/Atom feed; fall back to reading the page
   -> per subscriber: cluster articles across their sources
   -> drop stories already sent to them in the last 14 days
   -> take the top N by score
   -> fetch article bodies only for the stories that made the cut
   -> summarise (one batched API call; summaries reused across subscribers)
   -> render and send
```

Sources shared between subscribers are fetched once, and a summary produced for
one subscriber is reused for the others in the same run.

Clustering merges articles that share a canonical URL, or whose headlines share
at least two distinctive words with an overlap coefficient of 0.5 or more.
Canonicalisation strips tracking parameters, so the same story linked with
different `utm_*` tags is recognised as one.

---

## Security

- **Transport**: every source URL must be `https://`, port 443, no embedded
  credentials. Re-checked on every redirect hop, not only at registration.
- **SSRF**: hostnames are resolved and rejected if any address is loopback,
  private, link-local, CGNAT, multicast or reserved, in IPv4 or IPv6, including
  IPv4-mapped IPv6. Cloud metadata endpoints are blocked by name as well.
  A residual DNS-rebinding window remains, since the connection is not pinned to
  the validated address.
- **Passwords and PINs**: scrypt via Node's standard library, salted, no native
  dependency. PINs are stored hashed and consumed as soon as the attempt budget
  is spent.
- **Admin**: single bound email, unguessable mount path, lockout for 15 minutes
  after 5 failures, 8-hour server-side sessions whose tokens are stored only as
  hashes, all invalidated on a password change.
- **Web**: CSRF via double-submit cookie plus an Origin check; `HttpOnly`,
  `SameSite=Lax`, `Secure` cookies; CSP of `default-src 'none'` with no
  JavaScript anywhere in the app; HSTS in production; per-IP rate limits on
  sign-up, verification and admin login.
- **Output**: every dynamic value in every page and email is HTML-escaped.
- **Enumeration**: the sign-up form answers identically whether or not the
  address is already registered.

Rate limiting is in-process, which is correct for a single-process deployment.
Behind more than one instance it would need a shared store.

---

## Tests

```bash
npm test
```

109 tests across URL and SSRF validation, cross-source clustering and scoring,
feed and HTML extraction, crypto and signed tokens, the subject-line format and
HTML escaping, prompt-injection fencing, the subscriber and PIN lifecycle,
admin authentication, and an end-to-end digest run with the network stubbed.

```bash
npm run typecheck
```

---

## Operational notes

- Housekeeping runs after each digest: article rows older than 14 days, send
  history older than 60 days, PINs older than 7 days, expired admin sessions,
  and delivery logs older than 90 days.
- SQLite runs in WAL mode. Back up by copying the database file while the
  service is stopped, or with `sqlite3 <file> ".backup out.sqlite"` while it runs.
- Logs are one JSON object per line. `LOG_LEVEL` accepts `debug`, `info`,
  `warn`, `error`.
- Scraping a site you do not own may breach its terms of service, whatever
  `robots.txt` says. Feeds are preferred for that reason as well as for quality.
  The HTTPS check in the brief does not address this; it is a separate question
  from security.
