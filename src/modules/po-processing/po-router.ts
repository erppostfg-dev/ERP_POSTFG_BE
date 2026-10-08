import fs from 'fs/promises';
import path from 'path';
import { detectChannel, emailInfo } from '../ocr/channel-detector';
import { EmailMetadata } from '../email-intake/s3-layout';
import { channelHandlers } from './channels';
import { readBodyText } from './common/email-sources';
import { hasRawOutput, readRawOcr } from './common/raw-reader';
import { saveProcessed, saveProcessedMany } from './common/processed-store';
import { ErrorCode, ERROR_CODES, errorMessage, FILES, PoWarning, RESULT_STATUS, ResultStatus } from '../../constants';
import { AppError } from '../../utils/AppError';

/*
 * One entry for processing a PO after the OCR: finds the PO's channel and sends it down that channel's route
 * (channels/<channel>/<channel>.handler.ts), which writes processed.json into the PO folder and its S3 folder.
 * Today it is called by `npm run po:process`; later by the OCR result queue ("done" message for a PO).
 * It never runs the OCR: it only reads raw output that is already there.
 */

export interface ProcessResult {
  folder: string;
  status: ResultStatus;
  /** Why it was skipped or failed: a code from constants/errors.ts (INTERNAL for an unexpected error) and its message. */
  code?: ErrorCode;
  reason?: string;
  channel?: string;
  poNumber?: string;
  lines?: number;
  warnings?: PoWarning[];
  s3Folder?: string;
  /** For an email with several POs (Purplle): one entry per PO, saved under POs/<PO number>/processed.json. */
  pos?: { poNumber: string; poType: string; lines: number; needsReview: boolean; missingFields: string[] }[];
}

export const processPo = async (folder: string): Promise<ProcessResult> => {
  const dir = path.resolve(folder);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as EmailMetadata;
    const detected = detectChannel(emailInfo(meta));
    if (!('config' in detected)) return { folder: dir, status: RESULT_STATUS.SKIPPED, code: detected.code, reason: detected.reason };

    const channel = detected.config.channel;
    const handler = channelHandlers[channel];
    if (!handler) {
      const code = ERROR_CODES.NO_PROCESSING_ROUTE;
      return { folder: dir, status: RESULT_STATUS.SKIPPED, channel, code, reason: errorMessage(code, channel) };
    }
    if (!(await hasRawOutput(dir))) {
      const code = ERROR_CODES.NO_RAW_OUTPUT;
      return { folder: dir, status: RESULT_STATUS.SKIPPED, channel, code, reason: errorMessage(code) };
    }

    const out = await handler.process({
      folder: dir,
      meta,
      channel,
      raw: await readRawOcr(dir),
      body: await readBodyText(dir),
      subject: emailInfo(meta).subject ?? '',
    });

    // One email with several POs (Purplle): one processed.json per PO under POs/<PO number>/.
    if (Array.isArray(out)) {
      const s3Folder = await saveProcessedMany(dir, out);
      return {
        folder: dir,
        status: RESULT_STATUS.OK,
        channel,
        poNumber: `${out.length} POs`,
        lines: out.reduce((n, po) => n + po.line_items.length, 0),
        warnings: out.flatMap((po) => po.warnings.map((w) => ({ ...w, message: `${po.po_number}: ${w.message}` }))),
        s3Folder,
        pos: out.map((po) => ({
          poNumber: po.po_number,
          poType: po.po_type,
          lines: po.line_items.length,
          needsReview: po.needs_review ?? false,
          missingFields: po.missing_fields ?? [],
        })),
      };
    }

    const po = out;
    const s3Folder = await saveProcessed(dir, po);
    return {
      folder: dir,
      status: RESULT_STATUS.OK,
      channel,
      poNumber: po.po_number,
      lines: po.line_items.length,
      warnings: po.warnings,
      s3Folder,
    };
  } catch (err) {
    // A known error keeps its code; anything else (unreadable file, S3 down ...) is INTERNAL with its message.
    const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
    return { folder: dir, status: RESULT_STATUS.FAILED, code, reason: err instanceof Error ? err.message : String(err) };
  }
};
