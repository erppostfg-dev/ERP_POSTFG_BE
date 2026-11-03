import { Request, Router } from 'express';
import { ACCESS_LEVEL, DAY_PATTERN, ERROR_CODES, PAGE, PRICE_DIFFS, UPLOAD_ID_PATTERN } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { emailDraft, listGroups, listLines, markSent, PriceDiffFilter, PriceDiffStatus, PriceDiffView } from '../modules/po-review/price-differences.service';
import { appError } from '../utils/AppError';
import { bodyReader, Problem } from './po-review.routes';

/*
 * Price differences (2026-10-30, a tab of PO Processing & Review; same page access):
 *   GET  /price-differences?view=po|channel&status=open|sent|all&channel=&from=&to=   one row per PO / per channel
 *   GET  /price-differences/lines?uploadId= | channel=  (&status=)                   the lines of one PO / channel
 *   GET  /price-differences/draft?uploadId= | channel=  (&status=, default open)     email draft: to, subject, body,
 *                                                                                     fileName, lineIds, lines
 * Editor:
 *   POST /price-differences/sent  { ids: [...] }   mark those lines sent (once; one batch id per email)
 */

const router = Router();
const Q = PRICE_DIFFS.QUERY;
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR)];

/** The query's filters; bad values come back together (400 VALIDATION_FAILED). */
const filterOf = (req: Request, defaultStatus: PriceDiffStatus): PriceDiffFilter => {
  const problems: Problem[] = [];
  const r = bodyReader(problems);
  const text = (k: string) => {
    const v = req.query[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const statuses = Object.values(PRICE_DIFFS.STATUS) as string[];
  const status = text(Q.STATUS) ?? defaultStatus;
  if (!statuses.includes(status)) r.bad(Q.STATUS, 'FIELD_NOT_ONE_OF', Q.STATUS, statuses.join(', '));
  const uploadId = text(Q.UPLOAD_ID);
  if (uploadId && !UPLOAD_ID_PATTERN.test(uploadId)) r.bad(Q.UPLOAD_ID, 'FIELD_NOT_TEXT', Q.UPLOAD_ID);
  const day = (k: string) => {
    const v = text(k);
    if (v && !DAY_PATTERN.test(v)) return r.bad(k, 'FIELD_NOT_TEXT', k), undefined;
    return v;
  };
  const from = day(Q.FROM);
  const to = day(Q.TO);
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return { status: status as PriceDiffStatus, channel: text(Q.CHANNEL), uploadId, from, to };
};

router.get(PRICE_DIFFS.ROUTES.GROUPS, ...viewer, async (req, res, next) => {
  try {
    const views = Object.values(PRICE_DIFFS.VIEW) as string[];
    const view = typeof req.query[Q.VIEW] === 'string' ? (req.query[Q.VIEW] as string) : PRICE_DIFFS.VIEW.PO;
    if (!views.includes(view)) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: Q.VIEW, code: 'FIELD_NOT_ONE_OF', message: `${Q.VIEW} must be one of: ${views.join(', ')}` }]);
    res.json({ data: await listGroups(view as PriceDiffView, filterOf(req, PRICE_DIFFS.STATUS.ALL)) });
  } catch (err) { next(err); }
});

router.get(PRICE_DIFFS.ROUTES.LINES, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await listLines(filterOf(req, PRICE_DIFFS.STATUS.ALL)) });
  } catch (err) { next(err); }
});

router.get(PRICE_DIFFS.ROUTES.DRAFT, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await emailDraft(filterOf(req, PRICE_DIFFS.STATUS.OPEN), req.auth!.user.name || req.auth!.user.email) });
  } catch (err) { next(err); }
});

router.post(PRICE_DIFFS.ROUTES.SENT, ...editor, async (req, res, next) => {
  try {
    const raw = (req.body as Record<string, unknown> | undefined)?.[PRICE_DIFFS.BODY.IDS];
    const ids = Array.isArray(raw) ? raw.map(String).filter((x) => UPLOAD_ID_PATTERN.test(x)) : [];
    res.json({ data: await markSent(ids, { id: req.auth!.user.id, email: req.auth!.user.email }) });
  } catch (err) { next(err); }
});

export default router;
