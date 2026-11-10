# NewsUpdate

A daily news digest. Subscribers register their own HTTPS news sources and their
timezone; each morning — 07:00 their local time — the service fetches those
sources, works out which stories are corroborated across more than one of them,
writes a thirty-second summary of each, and emails the result.

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
| Subscriber picks their own timezone and delivery hour | `src/util/timezone.ts`, `src/services/subscribers.ts` |
| Email addresses encrypted at rest, with searchable blind index | `src/util/encryption.ts` |
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
node -e "const r=n=>require('crypto').randomBytes(n).toString('hex');console.log('SESSION_SECRET='+r(32));console.log('TOKEN_SECRET='+r(32));console.log('ENCRYPTION_KEY='+r(32));console.log('ADMIN_PATH=/console-'+r(12))"
```

Put those four lines into `.env`, then fill in `BASE_URL`, `ADMIN_EMAIL`, the
mail provider settings and, if you are using it, `ANTHROPIC_API_KEY`.

**Back up `ENCRYPTION_KEY` somewhere separate from the database before you have
real subscribers.** Stored email addresses are encrypted with it and cannot be
recovered without it. See [Encryption at rest](#encryption-at-rest).

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
| `ENCRYPTION_KEY` | 32 bytes. Encrypts stored email addresses. **Back it up.** Lose it and no address can be read |
| `DEFAULT_SEND_HOUR` | Default local hour, in *their* timezone, for subscribers who do not pick one. Default `7`. Admin-editable at runtime |
| `DEFAULT_TIMEZONE` | Zone given to a subscriber who picks none. Default `Asia/Singapore` |
| `DIGEST_SWEEP_CRON` | How often to check who is due. Default `*/15 * * * *` |
| `TZ` | Process timezone, for log timestamps and housekeeping only — not the send time |
| `DEFAULT_SOURCE_LIMIT` | Starting quota. The admin console overrides it, globally and per subscriber |
| `ALLOW_PRIVATE_NETWORK` | Leave `false`. `true` disables the SSRF guard |

Run it behind TLS. Leave `INSECURE_COOKIES=false`.

### `TRUST_PROXY` cuts both ways — set it to match your actual deployment

Rate limits on sign-up, PIN verification and admin login are keyed on the
client IP, so this setting has to be right in both directions:

- **`true` when nothing is in front of the app** lets a client set its own
  `X-Forwarded-For` and rotate IPs at will, which defeats every rate limit.
- **`false` when a proxy *is* in front** makes every request appear to come
  from the proxy, so one abusive client rate-limits all of your subscribers.

Set it to `true` only when exactly one trusted proxy (nginx, Caddy, Cloudflare)
terminates the connection and overwrites `X-Forwarded-For`. If you add a second
hop, `app.set('trust proxy', 1)` in `src/server/app.ts` needs the matching hop
count.

### If you deploy somewhere with no direct DNS

The SSRF guard resolves each hostname with `dns.lookup` and rejects any that
maps to a private address. In a sandbox or container whose only network path is
an HTTP proxy, `dns.lookup` fails and **every source will be rejected** with
"that hostname could not be resolved". Give the container a working resolver.
Do not reach for `ALLOW_PRIVATE_NETWORK=true` to work around it: that switches
the guard off entirely.

---

## How a subscriber uses it

1. Enters name, email, timezone and delivery hour on `/`. The hour can be left
   on the default.
2. Receives a 6-digit code, valid 15 minutes, 5 attempts, at most 3 codes per
   15 minutes per address.
3. On the correct code the address becomes active and they land on a private
   `/manage/<signed-token>` page.
4. They add up to their quota of `https://` sources — a homepage, a section
   page or a feed URL all work.
5. Each day, at **their** hour in **their own** timezone, they get one email.
   Every email carries manage and unsubscribe links, plus `List-Unsubscribe`
   headers for one-click unsubscribe.
6. They can change the hour and the timezone at any time from the manage page —
   useful if they move, or if a different time of day suits them.

A story is not sent to the same person twice within 14 days.

---

## Scheduling and timezones

Each subscriber receives their digest at **their own hour, in their own
timezone**. 07:00 in Singapore for a Singapore subscriber, 07:00 in London for
a London subscriber, 18:00 for someone who would rather read in the evening.

Both are per subscriber. The hour follows the same override pattern as the
source limit: a subscriber who has not chosen one tracks the admin's global
default, so changing that default moves everyone who never picked, and nobody
who did. A single sweep can therefore serve several different hours at once.

There is therefore no single daily cron. Instead the service **sweeps** every 15
minutes and asks which subscribers have reached their own send hour. A sweep
with nobody due runs one SQL query, contacts no publisher and creates no run
record, so sweeping often is cheap. When someone is due, only *their* sources
are fetched.

15 minutes is deliberate: it lands exactly on :00 local in every zone,
including the offsets that are not whole hours — India at +05:30, Nepal at
+05:45, parts of Australia at +08:45. An hourly sweep would serve those zones
half an hour late. Daylight saving is handled by the IANA database via `Intl`,
so 07:00 local stays 07:00 local across transitions.

**Catch-up.** If the service is down at a subscriber's hour, the next sweep
still sends, provided their local time is within four hours of it. After that
the day is skipped rather than delivered at a strange hour — the point of the
feature is that the digest arrives when they expect it, and a late catch-up
would undo that. The window never crosses midnight, so a 23:00 subscriber is
not emailed at 02:00.
"Already sent today" is judged on the subscriber's own local calendar date, so
a subscriber gets exactly one digest per local day.

To drive the sweep from an external cron instead, set `ENABLE_SCHEDULER=false`
and run this on the same cadence as `DIGEST_SWEEP_CRON`:

```bash
npm run digest:run
```

To send to everyone immediately, ignoring local times:

```bash
npm run digest:run -- --force
```

The admin console's "Run a digest now" button is the forced variant. Use it for
testing; the scheduled sweep never forces.

A subscriber whose stored timezone is somehow unrecognised (a hand-edited
database, or a zone the runtime later drops) falls back to `DEFAULT_TIMEZONE`
rather than being skipped silently.

A subscriber who picks an hour in the small hours gets it then: it is their
inbox, and the admin default protects everyone who expresses no preference.

---

## How the pipeline works

```
sweep (every 15 min)
   -> which subscribers have reached their own send hour? none -> stop here
   -> their distinct active sources
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
one subscriber is reused for the others in the same run. A subscriber with
nothing new is stamped for their local day, so later sweeps inside the
catch-up window do not re-fetch their sources to find the same nothing. A send
*failure* is deliberately not stamped, so the next sweep retries.

Clustering merges articles that share a canonical URL, or whose headlines share
at least two distinctive words with an overlap coefficient of 0.5 or more.
Canonicalisation strips tracking parameters, so the same story linked with
different `utm_*` tags is recognised as one.

---

## Encryption at rest

Subscriber email addresses are stored encrypted with AES-256-GCM, a fresh
random IV per value, under `ENCRYPTION_KEY`. The plaintext address is never
written to the database and never appears in a URL.

**What this protects against:** someone who obtains the database file — a
stolen backup, a volume snapshot, a copied SQLite file — cannot read the
addresses.

**What it does not protect against, and should not be claimed to:** an attacker
who compromises the running application, its environment, or the host. The
service must decrypt addresses in order to send mail, so it necessarily holds
the key. Treat application compromise as full exposure. The protection is real
but specific: it is about data at rest, not about intrusion.

### How lookup still works

An address has to be findable — sign-up and PIN verification both look one up —
and non-deterministic encryption cannot be used in a `WHERE` clause. So each
row carries two values:

- `email_enc` — the address, encrypted. Different ciphertext every time.
- `email_index` — a keyed HMAC of the normalised address. Deterministic, so it
  supports exact lookup and a `UNIQUE` constraint, while revealing nothing
  without the key. Because it is keyed rather than a plain hash, an attacker
  holding only the database cannot test guesses against it.

The two keys are derived separately from `ENCRYPTION_KEY` via HKDF, and the
column name is bound in as additional authenticated data, so a ciphertext
cannot be moved from one column to another and still decrypt.

Manage and unsubscribe links are bound to a 128-bit prefix of the index rather
than to the address, so the token in a URL, a mail log or browser history no
longer carries anyone's email.

### Operational consequences

- **Back up the key, separately from the database.** Losing it makes every
  stored address permanently unreadable. The service records a short,
  non-reversible fingerprint of the key and refuses to start against a database
  written with a different one — otherwise every lookup would miss and sign-ups
  would silently create duplicate records beside the unreadable originals.
- **Rotating the key is not supported** by this codebase. It would need a
  re-encryption pass over every row; nothing here does that.
- **Migrating an existing database** rewrites the table and then runs `VACUUM`.
  That matters: dropping a table frees its pages but does not erase them, so
  without the vacuum the old plaintext stays readable in the file with a hex
  editor. The migration logs a reminder that **backups taken before it still
  contain plaintext** and should be replaced and destroyed.
- `PRAGMA secure_delete = ON` is set, so a later unsubscribe or housekeeping
  delete overwrites the row rather than leaving it on the freelist. It costs a
  little write throughput.
- The admin console decrypts addresses to display them, which is the point of
  having one. A row that will not decrypt is shown as `(undecryptable)` rather
  than breaking the page.
- Subscriber **names are deliberately left in plaintext**. A name is not a
  unique identifier and is not a contact channel, so on its own it does not
  let anyone reach or resolve a subscriber; the address, which is both, is what
  the encryption protects. Encrypting names as well would cost admin
  readability for little gain. Worth knowing where the line sits, though: a
  name next to a source list still narrows identity, so a breached database is
  not anonymous — it is just missing the identifier and the means of contact.
  If that trade ever needs revisiting, the helper is field-agnostic: add a
  context label to `FIELD`, encrypt on write and decrypt in `hydrate`.

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
- **Personal data**: email addresses are encrypted at rest and looked up via a
  keyed blind index; see the section above for the threat model.
- **Admin**: single bound email, unguessable mount path, lockout for 15 minutes
  after 5 failures, 8-hour server-side sessions whose tokens are stored only as
  hashes, all invalidated on a password change.
- **Links in emails**: a manage link expires 30 days after it is issued, and a
  fresh one goes out with every digest. It is bearer access — it shows the
  subscriber's address and lets the holder change their sources — and it
  travels through email, so it reaches mail logs, forwarded messages and
  browser history. Unsubscribe links deliberately never expire: stopping
  unwanted mail must work from any message, however old, and that token grants
  nothing else.
- **Web**: CSRF via double-submit cookie plus an Origin check; `HttpOnly`,
  `SameSite=Lax`, `Secure` cookies; CSP of `default-src 'none'` with no
  JavaScript anywhere in the app; HSTS in production; per-IP rate limits on
  sign-up, verification and admin login.
- **Output**: every dynamic value in every page and email is HTML-escaped.
- **Enumeration**: the sign-up form answers identically whether or not the
  address is already registered.

Rate limiting is in-process, which is correct for a single-process deployment.
Behind more than one instance it would need a shared store.

### Known limitations

Stated rather than glossed over:

- **DNS rebinding.** The SSRF guard resolves a hostname and checks the
  addresses, but the subsequent connection is not pinned to a validated
  address, so a name that resolves differently between the check and the
  request could still be reached.
- **PIN attempt counting is not transactional.** The attempt count is read and
  then incremented in two statements, so a burst of concurrent requests can
  land a few guesses beyond the five-attempt limit. The excess is bounded by
  request concurrency and sits behind a per-IP limit, which leaves brute-force
  of a six-digit PIN far out of reach — but it is not exactly five.
- **Provider error messages are logged verbatim** when a verification email
  fails to send, and an SMTP rejection often echoes the recipient address. The
  address stays out of the database in plaintext, but it can appear in logs.
- **Encryption at rest protects the database, not the process.** Covered above.
- **Key rotation is unimplemented.** Covered above.

---

## Tests

```bash
npm test
```

187 tests across URL and SSRF validation, cross-source clustering and scoring,
feed and HTML extraction, crypto and signed tokens, the subject-line format and
HTML escaping, prompt-injection fencing, the subscriber and PIN lifecycle,
admin authentication, timezone and send-hour handling (daylight saving,
half-hour offsets, date-line rollover, the catch-up window, per-subscriber
hours), encryption at rest (round-trip, tamper and wrong-context rejection,
blind-index determinism, the key fingerprint guard, and a check that the raw
database file contains no plaintext address), and end-to-end digest runs with
the network stubbed.

```bash
npm run typecheck
```

---

## Operational notes

- Adding a column to `schema.sql` does not alter an existing database, because
  the schema uses `CREATE TABLE IF NOT EXISTS`. `applyMigrations` in
  `src/db/index.ts` holds the guarded `ALTER TABLE` statements for columns
  added later; it is idempotent and runs on every boot. Existing subscribers
  picked up `DEFAULT_TIMEZONE` when the timezone column was added.
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
