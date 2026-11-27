import { In } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { MAIL_LIST, MYNTRA_STR, USER_STATUS } from '../../../constants';
import { LOG_SOURCE } from '../../../constants/logging';
import { User } from '../../../entities';
import { logError } from '../../../utils/classify-error';
import { recipientsFor, sendToList } from '../../mail/mail-lists.service';
import { sendSystemNotices } from '../../notices/notices.service';

/*
 * Myntra STR alerts (2026-11-27, user: "when it arrives send a notification to Reshma so she can open Myntra and
 * Connect"). Who = the "Myntra STRs" mail list (Users & Roles -> Email; changed there, no code): the email to all its
 * active addresses, the bell to the POST_FG people among them (same email address, active). Never throws: an alert
 * problem is logged and the robot run stands.
 */

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const notifyStr = async (text: string, subject: string): Promise<void> => {
  try {
    const r = await recipientsFor(MAIL_LIST.MYNTRA_STR);
    const emails = [...new Set([...r.to, ...r.cc, ...r.bcc].map((e) => e.toLowerCase()))];
    if (emails.length) {
      const people = await AppDataSource.getRepository(User).find({ select: { id: true }, where: { email: In(emails), status: USER_STATUS.ACTIVE } });
      await sendSystemNotices(people.map((p) => p.id), text, MYNTRA_STR.NOTIFY.LINK);
    }
    // the app's own address (AUTH_REDIRECT_URL, e.g. https://<domain>/postfg: the welcome email's link) + the page
    const url = `${env.auth.redirectUrl.replace(/\/+$/, '')}${MYNTRA_STR.NOTIFY.LINK}`;
    // in the background: a mail problem never holds the robot
    void sendToList(MAIL_LIST.MYNTRA_STR, { subject, text: `${text}\n\n${url}`, html: `<p>${esc(text)}</p><p><a href="${url}">${url}</a></p>` })
      .catch((err: unknown) => logError(LOG_SOURCE.MAIL, '[myntra-str] alert email not sent (the bell has it)', err));
  } catch (err) {
    logError(LOG_SOURCE.APP, '[myntra-str] alert not sent', err);
  }
};
