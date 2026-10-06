import path from 'path';
import { ChannelName } from '../../../constants/channels';
import { emailInfo } from '../../ocr/channel-detector';
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
}

/**
 * Each channel has its own handler in channels/<channel>/: its own route through the processing.
 * Today: process() turns the raw OCR output into processed.json. Later each handler also gets its own
 * steps (DB save, location and SKU match, checks, review), added here as new methods.
 */
export interface ChannelHandler {
  channel: ChannelName;
  process(ctx: PoContext): Promise<ProcessedPo>;
}

/** A processed PO with the fields from our side filled in (the same for every channel). */
export const basePo = (ctx: PoContext): ProcessedPo => {
  const po = emptyPo();
  po['subject line if email'] = emailInfo(ctx.meta).subject ?? '';
  po.channel_name = ctx.channel;
  po.input_type = ctx.raw.inputType;
  po.ref_file_urls = [...ctx.raw.inputFiles, ctx.raw.sourceFile].map((f) => s3UrlFor(ctx.folder, ctx.meta, path.basename(f)));
  po.processed_at = new Date().toISOString();
  return po;
};
