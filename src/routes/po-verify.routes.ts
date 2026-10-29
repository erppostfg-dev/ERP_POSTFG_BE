import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, PAGE, PO_VERIFY, UPLOAD_ID_PATTERN } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { listChannelSettings, sendBack, updateChannelSetting, VerifyBody, verifyDetail, verifyPo, verifyStates } from '../modules/po-verify/po-verify.service';
import { USER_ADMIN_ROLES } from '../constants/users';
import { appError } from '../utils/AppError';

/*
 * PO verification before Uniware (user, 2026-10-22; constants/po-verify.ts). New routes only, the review routes are
 * unchanged:
 *   GET  /po-verify?uploadIds=1,2,3        { required, items: [{ uploadId, state, by, at, remark }] }   viewer
 *   GET  /po-verify/:uploadId              the saved PO next to what the PO says (header, lines, totals)  viewer
 *   POST /po-verify/:uploadId/verify       { remark?, linesChecked?, lineCount? }                         editor
 *   POST /po-verify/:uploadId/send-back    { remark }  cancels the saved PO, back to In Review            editor
 *   GET  /po-verify/settings               the switch per channel (+ verified / sent back counts)       admin / developer
 *   PATCH /po-verify/settings/:channel     { required: true|false }                                       admin / developer
 */

const router = Router();
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR)];

const uploadIdOf = (req: Request): string => {
  const { uploadId } = req.params;
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  return uploadId;
};

const remarkOf = (req: Request, required: boolean): string | undefined => {
  const v = (req.body as Record<string, unknown> | undefined)?.[PO_VERIFY.BODY_REMARK];
  const text = typeof v === 'string' ? v.trim() : '';
  if ((required && !text) || text.length > PO_VERIFY.REMARK_MAX) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{
      field: PO_VERIFY.BODY_REMARK,
      code: ERROR_CODES.FIELD_REQUIRED,
      message: `${PO_VERIFY.BODY_REMARK}: ${required ? 'required, ' : ''}at most ${PO_VERIFY.REMARK_MAX} characters`,
    }]);
  }
  return text || undefined;
};

/** Settings: the Users & Roles page's own rule (editor on /admin AND the admin or developer role). */
const requireUserAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_A_USER_ADMIN, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};
const admin = [requireAuth, requirePage(PAGE.ADMIN, ACCESS_LEVEL.EDITOR), requireUserAdmin];

// Before /:uploadId, so "settings" is never read as an upload id.
router.get(PO_VERIFY.ROUTES.SETTINGS, ...admin, async (_req, res, next) => {
  try {
    res.json({ data: await listChannelSettings() });
  } catch (err) {
    next(err);
  }
});

router.patch(PO_VERIFY.ROUTES.SETTING, ...admin, async (req, res, next) => {
  try {
    const required = (req.body as Record<string, unknown> | undefined)?.[PO_VERIFY.BODY_REQUIRED];
    if (typeof required !== 'boolean') {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{
        field: PO_VERIFY.BODY_REQUIRED, code: ERROR_CODES.FIELD_REQUIRED, message: `${PO_VERIFY.BODY_REQUIRED}: true or false`,
      }]);
    }
    res.json({ data: await updateChannelSetting(req.params.channel, required, { id: req.auth!.user.id, email: req.auth!.user.email }) });
  } catch (err) {
    next(err);
  }
});

const count = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

router.get(PO_VERIFY.ROUTES.STATES, ...viewer, async (req, res, next) => {
  try {
    const raw = typeof req.query[PO_VERIFY.QUERY_IDS] === 'string' ? (req.query[PO_VERIFY.QUERY_IDS] as string) : '';
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => UPLOAD_ID_PATTERN.test(s)))];
    if (ids.length > PO_VERIFY.MAX_IDS) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
    res.json({ data: await verifyStates(ids) });
  } catch (err) {
    next(err);
  }
});

router.get(PO_VERIFY.ROUTES.ONE, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await verifyDetail(uploadIdOf(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(PO_VERIFY.ROUTES.VERIFY, ...editor, async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const body: VerifyBody = { remark: remarkOf(req, false), linesChecked: count(b.linesChecked), lineCount: count(b.lineCount) };
    res.json({ data: await verifyPo(uploadIdOf(req), body, { id: req.auth!.user.id, email: req.auth!.user.email }) });
  } catch (err) {
    next(err);
  }
});

router.post(PO_VERIFY.ROUTES.SEND_BACK, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await sendBack(uploadIdOf(req), remarkOf(req, true)!, { id: req.auth!.user.id, email: req.auth!.user.email }) });
  } catch (err) {
    next(err);
  }
});

export default router;
