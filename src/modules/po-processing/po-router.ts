import fs from 'fs/promises';
import path from 'path';
import { detectChannel, emailInfo } from '../ocr/channel-detector';
import { EmailMetadata } from '../email-intake/s3-layout';
import { channelHandlers } from './channels';
import { readBodyText } from './common/email-sources';
import { hasRawOutput, readRawOcr } from './common/raw-reader';
import { saveProcessed } from './common/processed-store';

/*
 * One entry for processing a PO after the OCR: finds the PO's channel and sends it down that channel's route
 * (channels/<channel>/<channel>.handler.ts), which writes processed.json into the PO folder and its S3 folder.
 * Today it is called by `npm run po:process`; later by the OCR result queue ("done" message for a PO).
 * It never runs the OCR: it only reads raw output that is already there.
 */

export interface ProcessResult {
  folder: string;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  channel?: string;
  poNumber?: string;
  lines?: number;
  warnings?: string[];
  s3Folder?: string;
}

export const processPo = async (folder: string): Promise<ProcessResult> => {
  const dir = path.resolve(folder);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')) as EmailMetadata;
    const detected = detectChannel(emailInfo(meta));
    if (!('config' in detected)) return { folder: dir, status: 'skipped', reason: detected.reason };

    const channel = detected.config.channel;
    const handler = channelHandlers[channel];
    if (!handler) return { folder: dir, status: 'skipped', channel, reason: `no processing route for ${channel} yet` };
    if (!(await hasRawOutput(dir))) return { folder: dir, status: 'skipped', channel, reason: 'no raw OCR output yet' };

    const po = await handler.process({
      folder: dir,
      meta,
      channel,
      raw: await readRawOcr(dir),
      body: await readBodyText(dir),
      subject: emailInfo(meta).subject ?? '',
    });
    const s3Folder = await saveProcessed(dir, po);
    return {
      folder: dir,
      status: 'ok',
      channel,
      poNumber: po.po_number,
      lines: po.line_items.length,
      warnings: po.warnings,
      s3Folder,
    };
  } catch (err) {
    return { folder: dir, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
};
