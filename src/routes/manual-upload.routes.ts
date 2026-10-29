import { Request, Router } from 'express';
import multer from 'multer';
import { ACCESS_LEVEL, ERROR_CODES, MANUAL_UPLOAD, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import {
  cancelUpload, listUploads, processUploads, retryUpload, uploadChannels, uploadFiles,
} from '../modules/manual-upload/manual-upload.service';
import { appError } from '../utils/AppError';

/*
 * Manual upload of PO files (user, 2026-10-22; constants/manual-upload.ts, modules/manual-upload):
 *   GET  /manual-uploads/channels    channels the app can read + what files each needs              viewer /operations/po-review
 *   GET  /manual-uploads             the Upload queue (newest first) with each upload's POs         viewer
 *   POST /manual-uploads             multipart: channel + files (PDF / Excel / CSV, ≤ 20 MB, ≤ 20)  editor
 *                                    -> stored + S3, status "uploaded" (no OCR yet)
 *   POST /manual-uploads/process     { ids } -> queued; the queue runs one at a time               editor
 *   POST /manual-uploads/:id/cancel  only "uploaded" ones (kept, nothing deleted)                   editor
 *   POST /manual-uploads/:id/retry   only "failed" ones                                             editor
 */

const router = Router();
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR)];
const upload = multer({ storage: multer.memoryStorage(), limits: { files: MANUAL_UPLOAD.MAX_FILES, fileSize: MANUAL_UPLOAD.MAX_FILE_BYTES } });
const actor = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email });
const idOf = (req: Request) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw appError(ERROR_CODES.MANUAL_UPLOAD_NOT_FOUND, req.params.id);
  return req.params.id;
};

router.get(MANUAL_UPLOAD.ROUTES.CHANNELS, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: await uploadChannels() });
  } catch (err) {
    next(err);
  }
});

router.get(MANUAL_UPLOAD.ROUTES.LIST, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: await listUploads() });
  } catch (err) {
    next(err);
  }
});

// Auth first, so files are only read for a signed-in editor.
router.post(MANUAL_UPLOAD.ROUTES.UPLOAD, ...editor, upload.array(MANUAL_UPLOAD.FIELD_FILES, MANUAL_UPLOAD.MAX_FILES), async (req, res, next) => {
  try {
    const channel = String((req.body as Record<string, unknown>)?.[MANUAL_UPLOAD.FIELD_CHANNEL] ?? '').trim();
    const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, buffer: f.buffer }));
    res.status(201).json({ data: await uploadFiles(channel, files, actor(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(MANUAL_UPLOAD.ROUTES.PROCESS, ...editor, async (req, res, next) => {
  try {
    const raw = (req.body as Record<string, unknown> | undefined)?.[MANUAL_UPLOAD.BODY_IDS];
    const ids = Array.isArray(raw) ? [...new Set(raw.map(String).filter((x) => /^\d{1,18}$/.test(x)))] : [];
    res.json({ data: await processUploads(ids, actor(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(MANUAL_UPLOAD.ROUTES.CANCEL, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await cancelUpload(idOf(req), actor(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(MANUAL_UPLOAD.ROUTES.RETRY, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await retryUpload(idOf(req), actor(req)) });
  } catch (err) {
    next(err);
  }
});

export default router;
