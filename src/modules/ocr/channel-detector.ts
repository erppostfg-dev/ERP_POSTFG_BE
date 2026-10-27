import { ERROR_CODES, errorMessage, NotPoCode, PROVIDERS } from '../../constants';
import { ChannelConfig, channelConfigs } from './channels.config';

export interface EmailInfo {
  from?: string;
  subject?: string;
  /** A manual upload (2026-10-22): the channel the person picked; no sender / subject to go by. */
  channel?: string;
  /**
   * The email's attachment names, when known (stored emails). An email of a channel without that channel's PO file(s)
   * is not a PO (2026-10-26, every channel). Unknown (undefined, e.g. before download) = not checked.
   */
  files?: string[];
}

/** metadata.json as stored, in either format. */
export interface StoredMetadata {
  from?: string;
  /** Older metadata (subject-pull script): `from` is the Google Group, the real sender is here. */
  originalSender?: string;
  replyTo?: string;
  subject?: string;
  files?: ({ filename: string } | string)[];
  /** gmail-pubsub, manual or channel-api (constants/folders PROVIDERS). */
  provider?: string;
  /** Manual upload / channel API: the channel, as constants/channels CHANNELS. */
  channel?: string;
}

/** Sender address + subject from metadata.json, for both formats. */
export const emailInfo = (meta: StoredMetadata): EmailInfo => {
  const raw = meta.originalSender || meta.replyTo || meta.from || '';
  const m = /<([^>]+)>/.exec(raw);
  return {
    from: (m ? m[1] : raw).trim() || undefined,
    subject: meta.subject,
    channel: meta.provider === PROVIDERS.MANUAL ? meta.channel : undefined,
    files: meta.files ? meta.files.map((f) => (typeof f === 'string' ? f : f.filename)) : undefined,
  };
};

const senderMatches = (from: string, sender: string): boolean => {
  const s = sender.toLowerCase();
  return s.startsWith('@') ? from.endsWith(s) : from === s;
};

/** Why an email is not a PO (codes and messages in constants/errors.ts). */
export type { NotPoCode };

/** The channel whose sender (and subject, if set) matches the email, or a reason why none did. */
export const detectChannel = (email: EmailInfo): { config: ChannelConfig } | { code: NotPoCode; reason: string } => {
  // A manual upload says its channel (picked on the Manual Upload tab): the same config as that channel's emails.
  if (email.channel) {
    const picked = channelConfigs.find((c) => c.channel === email.channel);
    if (picked) return { config: picked };
    return { code: ERROR_CODES.UNKNOWN_SENDER, reason: errorMessage(ERROR_CODES.UNKNOWN_SENDER, `manual upload for channel ${email.channel}`) };
  }
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
  // The PO file(s) the channel sends must be there (each of pdf / sheet that it uses); channels that send links
  // instead of attachments (FirstCry) are not checked here.
  if (email.files && !match.links) {
    const kinds = (['pdf', 'sheet'] as const).filter((k) => match.files[k] && !match.optional?.includes(k));
    const missing = kinds.filter((k) => !email.files!.some((f) => match.files[k]!.test(f)));
    if (missing.length) {
      const need = kinds.map((k) => String(match.files[k])).join(' + ');
      return { code: ERROR_CODES.NOT_PO_NO_FILES, reason: errorMessage(ERROR_CODES.NOT_PO_NO_FILES, match.channel, need, email.files.join(', ')) };
    }
  }
  return { config: match };
};
