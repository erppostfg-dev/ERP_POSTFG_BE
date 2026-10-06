import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import { env } from '../config/env';
import { sortStoredEmail, SortResult } from '../modules/email-intake/email-sorter.service';
import { storeInboundEmail } from '../modules/email-intake/email-storage.service';
import { mirrorLater, syncEmailToS3, uploadFileToS3 } from '../modules/email-intake/s3-mirror.service';
import { queueExtractPo } from '../modules/ocr/extract-po.service';
import { ApiError } from '../utils/ApiError';

const router = Router();

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES },
});

/** X-Webhook-Secret must equal WEBHOOK_SECRET (constant-time compare). */
const requireWebhookSecret = (req: Request, _res: Response, next: NextFunction): void => {
  const expected = env.intake.webhookSecret;
  if (!expected) return next(new ApiError(500, 'WEBHOOK_SECRET is not set on the server', undefined, 'INTERNAL'));

  const given = req.header('X-Webhook-Secret') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new ApiError(401, 'Invalid webhook secret'));
  }
  next();
};

const isEmail = (v: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);

type Body = Partial<
  Record<'from' | 'subject' | 'messageId' | 'label' | 'provider' | 'gmailId' | 'receivedAt' | 'bodyText' | 'bodyHtml', string>
>;

/**
 * POST /po-intake/email
 * An email and its attachments, sent by the Gmail label router (or by hand for testing).
 * multipart/form-data: files (0-10, max 20 MB each), from, subject, messageId,
 * plus optional label, provider, gmailId, receivedAt, bodyText, bodyHtml.
 * Emails from a label are all accepted, with or without attachments. For a manual call
 * (no label) at least one file is required. A label email that is not a PO is moved to
 * <label>-not-po/ with a reason (status "not_po"); a PO stays in <label>/ and goes to OCR when OCR_ENABLED.
 */
router.post('/email', requireWebhookSecret, upload.array('files', MAX_FILES), async (req, res, next) => {
  try {
    const body = req.body as Body;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (!files.length && !body.label) throw new ApiError(400, 'No files uploaded; send them in the "files" field');

    const problems: { field: string; message: string }[] = [];
    if (body.from && !isEmail(body.from)) problems.push({ field: 'from', message: 'from must be an email' });
    if (body.receivedAt && Number.isNaN(Date.parse(body.receivedAt))) {
      problems.push({ field: 'receivedAt', message: 'receivedAt must be an ISO date' });
    }
    if (problems.length) throw new ApiError(400, 'Validation failed', problems, 'VALIDATION_FAILED');

    const messageId = body.messageId?.trim() || `${body.provider ?? 'manual'}-${crypto.randomUUID()}`;
    const stored = await storeInboundEmail({
      group: body.label ?? 'manual',
      messageId,
      provider: body.provider === 'gmail-pubsub' ? 'gmail-pubsub' : 'manual',
      gmailId: body.gmailId,
      labels: body.label ? [body.label] : undefined,
      from: body.from,
      subject: body.subject,
      receivedAt: body.receivedAt,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      files: files.map((f) => ({ filename: f.originalname, content: f.buffer })),
    });

    console.log(
      `[po-intake] ${stored.duplicate ? 'repeat of' : 'stored'} ${body.label ?? 'manual'} "${body.subject ?? ''}" -> ${stored.folder}`,
    );

    // Not a PO (reply, notice, unknown sender): moved to <label>-not-po/ with a reason, and never sent to OCR.
    let folder = stored.folder;
    let sort: SortResult | undefined;
    if (!stored.duplicate && body.label) {
      sort = await sortStoredEmail(stored.folder);
      folder = sort.folder;
      if (!sort.isPo) console.log(`[sort] not a PO (${sort.code}): ${sort.reason} -> ${sort.folder}`);
    }

    // Copy to S3 after sorting, so it goes straight to its final folder (S3 can't move without delete rights).
    if (!stored.duplicate) {
      const sortedFolder = folder;
      mirrorLater(`upload ${sortedFolder}`, async () => {
        const r = await syncEmailToS3(sortedFolder);
        console.log(`[s3] ${r.uploaded} file(s) uploaded to ${r.s3Folder}/`);
      });
      if (sort && !sort.isPo) mirrorLater('upload report.csv', () => uploadFileToS3(path.join(path.dirname(sortedFolder), 'report.csv')));
    }

    // Testing: straight to OCR. Later: upload to S3 and add a BullMQ job instead.
    if (env.ocr.enabled && !stored.duplicate && sort?.isPo !== false && !queueExtractPo(folder)) {
      console.log(`[extractPo] OCR_RUN_LIMIT ${env.ocr.runLimit} reached; ${path.basename(folder)} waits for the next start`);
    }

    res.status(202).json({
      data: {
        messageId,
        provider: body.provider ?? 'manual',
        label: body.label ?? null,
        from: body.from ?? null,
        subject: body.subject ?? null,
        duplicate: stored.duplicate,
        status: stored.duplicate ? 'duplicate' : sort && !sort.isPo ? 'not_po' : 'stored',
        channel: sort?.isPo ? sort.channel : null,
        notPoReason: sort && !sort.isPo ? sort.reason : null,
        folder,
        attachments: stored.files.map((f) => ({ filename: f.filename, size: f.size, status: 'stored' })),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
