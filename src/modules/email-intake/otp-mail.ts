import { getGmail } from './gmail.client';
import { readParts, toHeaderMap } from './gmail-message';

/*
 * One-time codes mailed to the intake mailbox (env.gmail.mailbox), for robots that log in to a portal whose login
 * sends an OTP by email - Flipkart Seller Hub mails it to support@, which lands here (user, 2026-10-28).
 */

export interface OtpMail {
  /** Gmail search for the sender, e.g. 'from:noreply@rmo.flipkart.com'. */
  query: string;
  /** The code: group 1 of this, tried on the subject first, then the body. */
  pattern: RegExp;
  /** Only mails received at or after this time (ms) - the moment the portal was asked to send the code. */
  sentAfterMs: number;
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_POLL_MS = 5_000;
// Gmail's after: filter is in whole seconds and mail clocks drift; internalDate decides precisely below.
const SEARCH_SLACK_S = 60;
const CLOCK_SLACK_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The code in a mail, or null: the subject is tried first, then the text body. */
export const otpFromMail = (subject: string, body: string, pattern: RegExp): string | null =>
  pattern.exec(subject)?.[1] ?? pattern.exec(body)?.[1] ?? null;

/**
 * Waits for the newest matching mail received after `sentAfterMs` and returns its code. The newest wins: a portal
 * shared by several people may mail more than one code, and only the last one sent is valid.
 */
export const waitForOtp = async (mail: OtpMail): Promise<string> => {
  const gmail = getGmail();
  const deadline = Date.now() + (mail.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const q = `${mail.query} after:${Math.floor(mail.sentAfterMs / 1000) - SEARCH_SLACK_S}`;
  for (;;) {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 10 });
    let best: { at: number; code: string } | null = null;
    for (const m of list.data.messages ?? []) {
      if (!m.id) continue;
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const at = Number(msg.data.internalDate ?? 0);
      if (at < mail.sentAfterMs - CLOCK_SLACK_MS || (best && at <= best.at)) continue;
      const code = otpFromMail(toHeaderMap(msg.data.payload?.headers).subject ?? '', readParts(msg.data.payload).body.text, mail.pattern);
      if (code) best = { at, code };
    }
    if (best) return best.code;
    if (Date.now() > deadline) throw new Error(`no OTP mail (${mail.query}) within ${Math.round((mail.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`);
    await sleep(mail.pollMs ?? DEFAULT_POLL_MS);
  }
};
