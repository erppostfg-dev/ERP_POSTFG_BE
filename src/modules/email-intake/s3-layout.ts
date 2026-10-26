import path from 'path';
import { env } from '../../config/env';
import { OTHER_CHANNEL } from '../../constants/channels';
import { PROVIDERS } from '../../constants/folders';
import { monthFolder, yearFolder } from '../../constants/dates';
import { detectChannel, emailInfo, StoredMetadata } from '../ocr/channel-detector';
import { channelConfigs } from '../ocr/channels.config';
import { NOT_PO_SUFFIX } from './email-storage.service';

/*
 * Where an email goes in S3:
 *   PO:      <label>/FY<yy><yy+1>/<month>/<channel>/<PO number, or the local folder name>
 *   not PO:  <label>-not-po/<channel by sender domain, or "other">/<local folder name>
 * Year and month come from the email's received date in IST. A repeat of a PO folder gets _2, _3
 * (decided in s3-mirror.service.ts, which also remembers the folder in metadata.json as s3Folder).
 */

export interface EmailMetadata extends StoredMetadata {
  messageId?: string;
  receivedAt?: string;
  storedAt?: string;
  /** The S3 folder this email was given (set on its first upload). */
  s3Folder?: string;
  /** Where it came from (constants PROVIDERS): gmail-pubsub, manual, channel-api. */
  provider?: string;
  // --- a PO from a channel API (provider channel-api, 2026-10-16): no sender / subject to detect it from ---
  /** Our channel (constants CHANNELS), e.g. amazon. */
  channel?: string;
  /** The PO number (Amazon: the FBA shipment id). */
  poNumber?: string;
  /** constants SOURCE_SYSTEM, e.g. amazon_spapi. */
  sourceSystem?: string;
  /** The channel's own id of the PO (unique per source system). */
  externalId?: string;
  /** The channel's status of the PO when it was taken (Amazon: READY_TO_SHIP ...). */
  externalStatus?: string;
  /** A manual upload of a structured file (Amazon shipment .tsv, 2026-10-22): no OCR; processed.json made from the file. */
  structured?: boolean;
  /** That file's name (the PO's file). */
  sourceFile?: string;
}

const safeSegment = (s: string): string => s.trim().replace(/[^A-Za-z0-9._-]+/g, '_');

/** The channel of a non-PO sender, by its domain (or a channel's own sender address); otherwise "other". */
export const notPoChannelFor = (sender?: string): string => {
  const from = (sender ?? '').trim().toLowerCase();
  const domain = from.split('@')[1] ?? '';
  const config = channelConfigs.find(
    (c) =>
      c.senders.some((s) => s.toLowerCase() === from) ||
      c.domains.some((d) => domain === d || domain.endsWith(`.${d}`)),
  );
  return config?.channel ?? OTHER_CHANNEL;
};

/** The S3 folder (no trailing slash) an email belongs in, before any _2/_3 for a repeated PO. */
export const plannedS3Folder = (localFolder: string, meta: EmailMetadata): string => {
  const dir = path.resolve(localFolder);
  const name = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  const info = emailInfo(meta);

  if (parent.endsWith(NOT_PO_SUFFIX)) return `${env.s3.prefix}${parent}/${notPoChannelFor(info.from)}/${name}`;

  const date = new Date(meta.receivedAt ?? meta.storedAt ?? Date.now());
  // A channel API PO says its channel and PO number itself.
  if ((meta.provider === PROVIDERS.CHANNEL_API || meta.structured) && meta.channel && meta.poNumber) {
    return `${env.s3.prefix}${parent}/${yearFolder(date)}/${monthFolder(date)}/${meta.channel}/${safeSegment(meta.poNumber)}`;
  }
  const detected = detectChannel(info);
  const config = 'config' in detected ? detected.config : undefined;
  const po = config?.poNumber ? info.subject?.match(config.poNumber)?.[1] : undefined;
  const channel = config?.channel ?? OTHER_CHANNEL;
  return `${env.s3.prefix}${parent}/${yearFolder(date)}/${monthFolder(date)}/${channel}/${po ? safeSegment(po) : name}`;
};
