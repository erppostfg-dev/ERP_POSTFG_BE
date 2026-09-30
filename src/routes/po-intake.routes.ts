import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { storeInboundEmail } from '../modules/email-intake/email-storage.service';
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
 * (no label) at least one file is required. For now the email is only saved to storage.
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

    res.status(202).json({
      data: {
        messageId,
        provider: body.provider ?? 'manual',
        label: body.label ?? null,
        from: body.from ?? null,
        subject: body.subject ?? null,
        duplicate: stored.duplicate,
        status: stored.duplicate ? 'duplicate' : 'stored',
        folder: stored.folder,
        attachments: stored.files.map((f) => ({ filename: f.filename, size: f.size, status: 'stored' })),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
