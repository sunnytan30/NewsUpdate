import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { log } from '../util/logger.js';

export type OutgoingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** RFC 8058 one-click unsubscribe URL, when applicable. */
  unsubscribeUrl?: string;
};

export type SendResult = { ok: true; id?: string } | { ok: false; error: string };

let transporter: Transporter | null = null;

function smtpTransport(): Transporter {
  if (!transporter) {
    if (!config.SMTP_HOST) {
      throw new Error('MAIL_PROVIDER=smtp requires SMTP_HOST');
    }
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth:
        config.SMTP_USER && config.SMTP_PASS
          ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
          : undefined,
      // Keep the connection pooled: a digest run sends one mail per subscriber.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    });
  }
  return transporter;
}

function listUnsubscribeHeaders(url: string | undefined): Record<string, string> {
  if (!url) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function sendViaSmtp(mail: OutgoingMail): Promise<SendResult> {
  try {
    const info = await smtpTransport().sendMail({
      from: config.MAIL_FROM,
      to: mail.to,
      ...(config.MAIL_REPLY_TO ? { replyTo: config.MAIL_REPLY_TO } : {}),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: listUnsubscribeHeaders(mail.unsubscribeUrl),
    });
    return { ok: true, id: info.messageId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendViaResend(mail: OutgoingMail): Promise<SendResult> {
  if (!config.RESEND_API_KEY) {
    return { ok: false, error: 'MAIL_PROVIDER=resend requires RESEND_API_KEY' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.MAIL_FROM,
        to: [mail.to],
        ...(config.MAIL_REPLY_TO ? { reply_to: config.MAIL_REPLY_TO } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: listUnsubscribeHeaders(mail.unsubscribeUrl),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `Resend responded ${response.status}: ${detail.slice(0, 300)}` };
    }
    const body = (await response.json()) as { id?: string };
    return { ok: true, id: body.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function sendViaConsole(mail: OutgoingMail): SendResult {
  // Development only: config refuses this provider in production.
  log.info('[console mailer] email not delivered, printed instead', {
    to: mail.to,
    subject: mail.subject,
  });
  process.stdout.write(
    '\n--- EMAIL ---\n' +
      `To: ${mail.to}\n` +
      `Subject: ${mail.subject}\n` +
      (mail.unsubscribeUrl ? `List-Unsubscribe: ${mail.unsubscribeUrl}\n` : '') +
      '\n' +
      mail.text +
      '\n--- END EMAIL ---\n\n',
  );
  return { ok: true, id: 'console' };
}

export async function sendMail(mail: OutgoingMail): Promise<SendResult> {
  switch (config.MAIL_PROVIDER) {
    case 'smtp':
      return sendViaSmtp(mail);
    case 'resend':
      return sendViaResend(mail);
    case 'console':
      return sendViaConsole(mail);
    default:
      return { ok: false, error: `unknown mail provider: ${String(config.MAIL_PROVIDER)}` };
  }
}

/** Verify provider configuration at boot, so problems surface early. */
export async function verifyMailer(): Promise<void> {
  if (config.MAIL_PROVIDER !== 'smtp') return;
  try {
    await smtpTransport().verify();
    log.info('SMTP connection verified', { host: config.SMTP_HOST, port: config.SMTP_PORT });
  } catch (error) {
    log.warn('SMTP verification failed; sends will likely fail', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
