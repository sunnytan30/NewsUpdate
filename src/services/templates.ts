import { config } from '../config.js';
import { esc } from '../util/html.js';

export type DigestStory = {
  title: string;
  summary: string;
  url: string;
  host: string;
  /** Publisher hostnames among the subscriber's sources carrying this story. */
  publishers: string[];
  trending: boolean;
};

/** YYYYMMDD in the configured timezone, as required by the subject line. */
export function dateStamp(date = new Date(), timeZone = config.TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** Long-form date for the email body, e.g. "Monday, 10 November 2026". */
export function readableDate(date = new Date(), timeZone = config.TZ): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** The subject line: "[YYYYMMDD] - Top News Update for [Name]". */
export function digestSubject(name: string, date = new Date()): string {
  return `[${dateStamp(date)}] - Top News Update for ${name}`;
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function shell(bodyHtml: string, preheader: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>News Update</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:${FONT};">
${bodyHtml}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Verification email
// ---------------------------------------------------------------------------

export function verificationEmail(opts: {
  name: string;
  pin: string;
  minutes: number;
}): { subject: string; html: string; text: string } {
  const subject = `Your News Update verification code: ${opts.pin}`;

  const html = shell(
    `<tr><td style="padding:28px 28px 8px;">
  <h1 style="margin:0;font-size:20px;color:#111827;">Confirm your email address</h1>
</td></tr>
<tr><td style="padding:0 28px 8px;">
  <p style="margin:12px 0;font-size:15px;line-height:1.6;color:#374151;">Hello ${esc(opts.name)},</p>
  <p style="margin:12px 0;font-size:15px;line-height:1.6;color:#374151;">
    Enter this code to finish signing up for your daily news digest.
  </p>
</td></tr>
<tr><td align="center" style="padding:8px 28px 4px;">
  <div style="display:inline-block;padding:14px 28px;background:#f3f4f6;border-radius:8px;
              font-size:32px;letter-spacing:8px;font-weight:700;color:#111827;font-family:${FONT};">
    ${esc(opts.pin)}
  </div>
</td></tr>
<tr><td style="padding:8px 28px 28px;">
  <p style="margin:12px 0;font-size:13px;line-height:1.6;color:#6b7280;">
    The code expires in ${esc(opts.minutes)} minutes. If you did not request it, you can ignore this email
    and no digest will be sent.
  </p>
</td></tr>`,
    `Your verification code is ${opts.pin}`,
  );

  const text = [
    `Hello ${opts.name},`,
    '',
    `Your News Update verification code is: ${opts.pin}`,
    '',
    `It expires in ${opts.minutes} minutes.`,
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Digest email
// ---------------------------------------------------------------------------

function trendingBadge(story: DigestStory): string {
  if (!story.trending) return '';
  const others = story.publishers.length;
  return `<div style="margin:0 0 8px;font-size:12px;font-weight:600;color:#9a3412;
                      background:#ffedd5;display:inline-block;padding:3px 9px;border-radius:999px;">
    Across ${esc(others)} of your sources
  </div>`;
}

function storyHtml(story: DigestStory, index: number): string {
  const sourceList =
    story.publishers.length > 1
      ? `<p style="margin:8px 0 0;font-size:12px;color:#9ca3af;">
           Also carried by: ${esc(story.publishers.filter((p) => p !== story.host).join(', '))}
         </p>`
      : '';

  return `<tr><td style="padding:20px 28px;border-top:1px solid #e5e7eb;">
  ${trendingBadge(story)}
  <h2 style="margin:0 0 8px;font-size:17px;line-height:1.35;color:#111827;font-weight:650;">
    ${esc(index + 1)}. ${esc(story.title)}
  </h2>
  <p style="margin:0 0 12px;font-size:14px;line-height:1.65;color:#374151;">${esc(story.summary)}</p>
  <a href="${esc(story.url)}" style="font-size:14px;font-weight:600;color:#1d4ed8;text-decoration:none;">
    Read on ${esc(story.host)} &rarr;
  </a>
  ${sourceList}
</td></tr>`;
}

export function digestEmail(opts: {
  name: string;
  stories: DigestStory[];
  manageUrl: string;
  unsubscribeUrl: string;
  date?: Date;
}): { subject: string; html: string; text: string } {
  const date = opts.date ?? new Date();
  const subject = digestSubject(opts.name, date);
  const trendingCount = opts.stories.filter((s) => s.trending).length;

  const intro =
    trendingCount > 0
      ? `${opts.stories.length} stories from your sources. ${trendingCount} appeared across more than one of them.`
      : `${opts.stories.length} stories from your sources.`;

  const html = shell(
    `<tr><td style="padding:26px 28px 6px;">
  <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;">
    ${esc(readableDate(date))}
  </p>
  <h1 style="margin:6px 0 0;font-size:22px;color:#111827;">Top News Update for ${esc(opts.name)}</h1>
  <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#6b7280;">${esc(intro)}</p>
</td></tr>
${opts.stories.map((s, i) => storyHtml(s, i)).join('\n')}
<tr><td style="padding:20px 28px 28px;border-top:1px solid #e5e7eb;background:#fafafa;">
  <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#6b7280;">
    Summaries are generated automatically from the sources you chose and may contain errors.
    Follow the links for the full reporting.
  </p>
  <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">
    <a href="${esc(opts.manageUrl)}" style="color:#4b5563;">Manage your sources</a>
    &nbsp;&middot;&nbsp;
    <a href="${esc(opts.unsubscribeUrl)}" style="color:#4b5563;">Unsubscribe</a>
  </p>
</td></tr>`,
    intro,
  );

  const text = [
    `Top News Update for ${opts.name}`,
    readableDate(date),
    '',
    ...opts.stories.flatMap((story, i) => [
      `${i + 1}. ${story.title}`,
      story.trending ? `   [Across ${story.publishers.length} of your sources]` : '',
      `   ${story.summary}`,
      `   ${story.url}`,
      '',
    ]),
    'Summaries are generated automatically and may contain errors.',
    `Manage your sources: ${opts.manageUrl}`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, html, text };
}
