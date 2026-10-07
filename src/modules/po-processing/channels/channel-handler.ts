import path from 'path';
import { ChannelName } from '../../../constants/channels';
import { env } from '../../../config/env';
import { EmailMetadata } from '../../email-intake/s3-layout';
import { emptyPo } from '../common/apply-mapping';
import { ProcessedPo } from '../common/processed-po';
import { RawOcr } from '../common/raw-reader';
import { s3UrlFor } from '../common/processed-store';

/** Everything a channel handler gets for one PO. */
export interface PoContext {
  /** The PO's local folder (storage/emails/po-intake/<folder>). */
  folder: string;
  meta: EmailMetadata;
  channel: ChannelName;
  raw: RawOcr;
  /** The email body as plain text ("" when the email had none). */
  body: string;
  /** The email subject. */
  subject: string;
}

/**
 * Each channel has its own handler in channels/<channel>/: its own route through the processing.
 * Today: process() turns the raw OCR output into processed.json. Later each handler also gets its own
 * steps (DB save, location and SKU match, checks, review), added here as new methods.
 */
export interface ChannelHandler {
  channel: ChannelName;
  /**
   * One PO per email folder, or a list when one email holds several POs (Purplle's daily summary). A list is saved
   * as one processed.json per PO under <email folder>/POs/<PO number>/.
   */
  process(ctx: PoContext): Promise<ProcessedPo | ProcessedPo[]>;
}

/** A processed PO with the fields from our side filled in (the same for every channel). */
export const basePo = (ctx: PoContext): ProcessedPo => {
  const po = emptyPo();
  po['subject line if email'] = ctx.subject;
  po.channel_name = ctx.channel;
  po.input_type = ctx.raw.inputType;
  po.ref_file_urls = [...ctx.raw.inputFiles, ctx.raw.sourceFile].map((f) => s3UrlFor(ctx.folder, ctx.meta, path.basename(f)));
  po.processed_at = new Date().toISOString();
  po.field_sources = {
    'subject line if email': ctx.subject ? 'email' : '',
    channel_name: 'detected',
    input_type: po.input_type ? 'raw' : '',
    ref_file_urls: 's3',
  };
  return po;
};

/**
 * For a revised PO stored next to its earlier version (S3 folder <PO>_2, _3 ...): the earlier version's S3 folder.
 * "" when this PO has no earlier version stored.
 */
export const revisionOf = (ctx: PoContext): string => {
  const folder = ctx.meta.s3Folder ?? '';
  const m = /^(.*)_d+$/.exec(folder);
  return m ? `s3://${env.s3.bucket}/${m[1]}/` : '';
};

/** Fills field_sources with "" for every header field that ended up without a value or a source. */
export const finishSources = (po: ProcessedPo): void => {
  for (const [key, value] of Object.entries(po)) {
    if (
      ['line_items', 'unmapped', 'field_sources', 'cross_checks', 'warnings', 'processed_at', 'needs_review', 'review_reasons', 'missing_fields'].includes(key)
    )
      continue;
    if (!(key in po.field_sources)) po.field_sources[key] = value === '' ? '' : 'raw';
  }
};
