import { describe, expect, it } from 'vitest';
import { dateStamp, digestEmail, digestSubject, verificationEmail } from '../src/services/templates.js';

describe('digestSubject', () => {
  it('matches the required "[YYYYMMDD] - Top News Update for [Name]" format', () => {
    const subject = digestSubject('Sunny', new Date('2026-11-10T03:00:00Z'));
    expect(subject).toBe('[20261110] - Top News Update for Sunny');
  });

  it('uses the configured timezone, not UTC', () => {
    // 23:30 UTC on the 9th is already 07:30 on the 10th in Singapore.
    const subject = digestSubject('Sunny', new Date('2026-11-09T23:30:00Z'));
    expect(subject).toBe('[20261110] - Top News Update for Sunny');
  });

  it('keeps the name verbatim, including spaces', () => {
    expect(digestSubject('Tan Wei Ming', new Date('2026-01-02T04:00:00Z'))).toBe(
      '[20260102] - Top News Update for Tan Wei Ming',
    );
  });
});

describe('dateStamp', () => {
  it('zero-pads month and day', () => {
    expect(dateStamp(new Date('2026-03-05T04:00:00Z'))).toBe('20260305');
  });
});

describe('digestEmail', () => {
  const stories = [
    {
      title: 'Central bank holds rates',
      summary: 'The central bank left its policy rate unchanged at its November meeting.',
      url: 'https://a.example.com/rates',
      host: 'a.example.com',
      publishers: ['a.example.com', 'b.example.com'],
      trending: true,
    },
    {
      title: 'Harbour works begin',
      summary: 'Dredging started this week at the eastern berths.',
      url: 'https://c.example.com/harbour',
      host: 'c.example.com',
      publishers: ['c.example.com'],
      trending: false,
    },
  ];

  const mail = digestEmail({
    name: 'Sunny',
    stories,
    manageUrl: 'https://news.example.test/manage/tok',
    unsubscribeUrl: 'https://news.example.test/unsubscribe/tok',
    date: new Date('2026-11-10T03:00:00Z'),
  });

  it('uses the required subject line', () => {
    expect(mail.subject).toBe('[20261110] - Top News Update for Sunny');
  });

  it('includes each story title, summary and link in both HTML and text', () => {
    for (const story of stories) {
      expect(mail.html).toContain(story.title);
      expect(mail.html).toContain(story.summary);
      expect(mail.html).toContain(story.url);
      expect(mail.text).toContain(story.title);
      expect(mail.text).toContain(story.url);
    }
  });

  it('marks the corroborated story as appearing across sources', () => {
    expect(mail.html).toMatch(/Across 2 of your sources/);
  });

  it('always offers unsubscribe and manage links', () => {
    expect(mail.html).toContain('https://news.example.test/unsubscribe/tok');
    expect(mail.html).toContain('https://news.example.test/manage/tok');
    expect(mail.text).toContain('Unsubscribe:');
  });

  it('escapes HTML in subscriber-supplied and extracted values', () => {
    const hostile = digestEmail({
      name: '<script>alert(1)</script>',
      stories: [
        {
          title: 'Title with <img src=x onerror=alert(1)>',
          summary: 'Summary with </td></table><script>bad()</script>',
          url: 'https://x.example.com/a?b=1&c=2',
          host: 'x.example.com',
          publishers: ['x.example.com'],
          trending: false,
        },
      ],
      manageUrl: 'https://news.example.test/manage/t',
      unsubscribeUrl: 'https://news.example.test/unsubscribe/t',
    });

    // The payloads survive as inert escaped text; what matters is that no
    // attacker-controlled tag can form, and no element can be closed early.
    expect(hostile.html).not.toContain('<script');
    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).not.toContain('</td></table>');
    expect(hostile.html).toContain('&lt;script&gt;');
    expect(hostile.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Ampersands inside a legitimate URL must be encoded, not dropped.
    expect(hostile.html).toContain('https://x.example.com/a?b=1&amp;c=2');
  });
});

describe('verificationEmail', () => {
  it('shows the PIN and its expiry in both parts', () => {
    const mail = verificationEmail({ name: 'Sunny', pin: '418290', minutes: 15 });
    expect(mail.subject).toContain('418290');
    expect(mail.html).toContain('418290');
    expect(mail.text).toContain('418290');
    expect(mail.text).toContain('15 minutes');
  });

  it('escapes a hostile name', () => {
    const mail = verificationEmail({ name: '<b>x</b>', pin: '111111', minutes: 15 });
    expect(mail.html).not.toContain('<b>x</b>');
    expect(mail.html).toContain('&lt;b&gt;');
  });
});
