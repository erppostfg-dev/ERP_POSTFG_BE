import { ERROR_CODES, errorMessage, NotPoCode } from '../../constants';
import { ChannelConfig, channelConfigs } from './channels.config';

export interface EmailInfo {
  from?: string;
  subject?: string;
}

/** metadata.json as stored, in either format. */
export interface StoredMetadata {
  from?: string;
  /** Older metadata (subject-pull script): `from` is the Google Group, the real sender is here. */
  originalSender?: string;
  replyTo?: string;
  subject?: string;
  files?: ({ filename: string } | string)[];
}

/** Sender address + subject from metadata.json, for both formats. */
export const emailInfo = (meta: StoredMetadata): EmailInfo => {
  const raw = meta.originalSender || meta.replyTo || meta.from || '';
  const m = /<([^>]+)>/.exec(raw);
  return { from: (m ? m[1] : raw).trim() || undefined, subject: meta.subject };
};

const senderMatches = (from: string, sender: string): boolean => {
  const s = sender.toLowerCase();
  return s.startsWith('@') ? from.endsWith(s) : from === s;
};

/** Why an email is not a PO (codes and messages in constants/errors.ts). */
export type { NotPoCode };

/** The channel whose sender (and subject, if set) matches the email, or a reason why none did. */
export const detectChannel = (email: EmailInfo): { config: ChannelConfig } | { code: NotPoCode; reason: string } => {
  const from = (email.from ?? '').trim().toLowerCase();
  if (!from) return { code: ERROR_CODES.NO_SENDER, reason: errorMessage(ERROR_CODES.NO_SENDER) };

  const bySender = channelConfigs.filter((c) => c.senders.some((s) => senderMatches(from, s)));
  if (!bySender.length) return { code: ERROR_CODES.UNKNOWN_SENDER, reason: errorMessage(ERROR_CODES.UNKNOWN_SENDER, from) };

  const subject = (email.subject ?? '').trim();
  const match = bySender.find((c) => !c.subject || c.subject.test(subject));
  if (!match) {
    const channels = bySender.map((c) => c.channel).join('/');
    return { code: ERROR_CODES.NOT_PO_SUBJECT, reason: errorMessage(ERROR_CODES.NOT_PO_SUBJECT, from, channels) };
  }
  return { config: match };
};
