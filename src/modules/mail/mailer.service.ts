import { gmail_v1, google } from 'googleapis';
import { env } from '../../config/env';
import { ERROR_CODES } from '../../constants';
import { appError } from '../../utils/AppError';
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
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends one email (multipart: plain text + HTML). Throws MAIL_SEND_NOT_ALLOWED / MAIL_SEND_FAILED. */
export const sendMail = async (mail: Mail): Promise<void> => {
  const boundary = `pf-${Date.now().toString(36)}`;
  const raw = [
    `From: POST FG <${env.gmail.mailbox}>`,
    `To: ${mail.to}`,
    `Subject: ${header(mail.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.text, 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.html, 'utf8').toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  try {
    await client().users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') } });
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
