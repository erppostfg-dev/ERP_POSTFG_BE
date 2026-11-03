import { gmail_v1, google } from 'googleapis';
import { env } from '../../config/env';
import { ERROR_CODES } from '../../constants';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logCall } from '../../utils/log-call';
import { getAuthClient, GMAIL_SEND_SCOPE } from '../email-intake/gmail.client';

/*
 * Outgoing email (2026-10-15, user: welcome email when a person is added), sent through Gmail as the intake mailbox
 * (env.gmail.mailbox, erp.postfg@mcaffeine.com).
 *   oauth mode: the same refresh token as the intake; it needs the send permission, given once by running
 *               `npm run gmail:token` again (the script now asks for read + Pub/Sub + send).
 *   service_account mode: its own client with only the send scope, so a missing delegation can never break intake.
 * A missing permission is reported as MAIL_SEND_NOT_ALLOWED (no point retrying); anything else as MAIL_SEND_FAILED.
 */

let sendClient: gmail_v1.Gmail | undefined;

const client = (): gmail_v1.Gmail => {
  if (sendClient) return sendClient;
  const cfg = env.gmail;
  const auth =
    cfg.authMode === 'service_account' && cfg.serviceAccountKeyFile
      ? new google.auth.JWT({ keyFile: cfg.serviceAccountKeyFile, scopes: [GMAIL_SEND_SCOPE], subject: cfg.mailbox })
      : getAuthClient();
  sendClient = google.gmail({ version: 'v1', auth });
  return sendClient;
};

/** "=?UTF-8?B?...?=" so a subject with any character survives. */
const header = (text: string) => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

export interface Mail {
  /** One address or several (a mailing list's To). */
  to: string | string[];
  cc?: string[];
  /** Delivered, never shown to the others (Gmail drops the header from what it sends on). */
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  /** Files sent with it (the in-transit mail's workbooks, 2026-10-30). */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  /** The file name the reader sees (ASCII). */
  filename: string;
  contentType: string;
  content: Uint8Array;
}

const addresses = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((a) => a.trim()).filter(Boolean);

/** Base64 in lines of 76 characters (RFC 2045). */
const base64Lines = (b: Uint8Array): string => (Buffer.from(b).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
/** A file name safe inside a quoted header value. */
const safeName = (s: string): string => s.replace(/["\\\r\n]/g, '_');

/** The raw RFC 822 message Gmail is given (multipart: plain text + HTML; with attachments, inside multipart/mixed). */
export const rawMessage = (mail: Mail, boundary = `pf-${Date.now().toString(36)}`): string => {
  const to = addresses(mail.to);
  const cc = addresses(mail.cc);
  const bcc = addresses(mail.bcc);
  const files = mail.attachments ?? [];
  const alt = files.length ? `${boundary}-alt` : boundary;
  const body = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.text, 'utf8').toString('base64'),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.html, 'utf8').toString('base64'),
    `--${alt}--`,
  ];
  return [
    `From: POST FG <${env.gmail.mailbox}>`,
    ...(to.length ? [`To: ${to.join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${header(mail.subject)}`,
    'MIME-Version: 1.0',
    ...(files.length
      ? [
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        ...body,
        ...files.flatMap((f) => [
          `--${boundary}`,
          `Content-Type: ${f.contentType}; name="${safeName(f.filename)}"`,
          `Content-Disposition: attachment; filename="${safeName(f.filename)}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64Lines(f.content),
        ]),
        `--${boundary}--`,
      ]
      : [`Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...body]),
    '',
  ].join('\r\n');
};

/** Sends one email to its To / Cc / Bcc. Throws MAIL_SEND_NOT_ALLOWED / MAIL_SEND_FAILED. */
export const sendMail = async (mail: Mail): Promise<void> => {
  const raw = rawMessage(mail);
  try {
    // timeout: a Gmail that never answers fails this try (MAIL_SEND_FAILED); the caller's retries take over.
    // With attachments the message goes as an upload (up to 35 MB) instead of inside the JSON body.
    await logCall(LOG_SOURCE.MAIL, 'messages.send', () =>
      (mail.attachments?.length
        ? client().users.messages.send({ userId: 'me', media: { mimeType: 'message/rfc822', body: raw } }, { timeout: env.gmail.sendTimeoutMs * 4 })
        : client().users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') } }, { timeout: env.gmail.sendTimeoutMs })));
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string; response?: { data?: { error?: string } } };
    const status = e.code ?? e.status;
    const text = `${e.message ?? ''} ${e.response?.data?.error ?? ''}`;
    if (status === 403 || /insufficient|scope|unauthorized_client|invalid_grant/i.test(text)) {
      throw appError(ERROR_CODES.MAIL_SEND_NOT_ALLOWED, env.gmail.mailbox);
    }
    throw appError(ERROR_CODES.MAIL_SEND_FAILED, (e.message ?? String(err)).slice(0, 300));
  }
};
