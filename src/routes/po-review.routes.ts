import { Request, Response, Router } from 'express';
import {
  ACCESS_LEVEL,
  CAPABILITY,
  DAY_PATTERN,
  ERROR_CODES,
  errorMessage,
  PAGE,
  PO_REVIEW_BODY,
  PO_REVIEW_LIST,
  PO_REVIEW_REMARK_MAX,
  PO_REVIEW_QUERY,
  REVIEW_LIVE,
  REVIEW_RECHECK,
  UNIWARE_HANDOFF,
  UPLOAD_ID_PATTERN,
  UPLOAD_STATUS,
  UploadStatus,
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { hasCapability } from '../modules/auth/access.service';
import { getPoFile, getPoReview, listPoReview, PoReviewListQuery } from '../modules/po-review/po-review.service';
import { reviewEvents, reviewVersion } from '../modules/po-review/po-review.live';
import { recheckInReview } from '../modules/po-review/recheck.service';
import { downloadCombined, downloadOne, markUploaded } from '../modules/po-review/uniware-handoff.service';
import { LineCorrection, rejectPo, ResubmitBody, submitForApproval } from '../modules/po-review/po-review-actions.service';
import { appError } from '../utils/AppError';

/*
 * PO review routes (API contract "PO review", 2026-10-09):
 *   GET /po-review   po_uploads of one status (default needs_review), newest first, paged.
 *                     ?status=&channel=&q=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&pageSize=
 *   GET /po-review/:uploadId   one PO for the review panel (processed.json from S3, issues, our SKU/MRP/rate per line,
 *                              the channel's SKUs, download links). Viewer on /operations/po-review.
 *   GET /po-review/events, /live-state   live updates (SSE) and the version for polling (po-review.live.ts).
 *   GET /po-review/:uploadId/uniware-csv · POST /po-review/uniware-csv · POST /po-review/uniware-uploaded   the Uniware
 *   hand-off (download the sale order CSV, then mark it uploaded; uniware-handoff.service.ts).
 *   GET /po-review/:uploadId/file   the PO file itself, streamed from S3 (for the panel's PDF viewer). Viewer.
 *   POST /po-review/:uploadId/submit   { location?: { detailsChannelId }, lines?: [{ lineNo, pepCode?, qty?, mrp?, rate? }],
 *                                        accept?: [{ issueId, remark? }], remark? }   corrections -> validate -> must pass
 *                                        completely -> pending_approval (Approvals page; 2026-10-15, replaces /resubmit,
 *                                        which saved the PO at once).
 *   POST /po-review/:uploadId/reject   { remark }   the reviewer rejects directly (kept in po_review_submissions).
 *   Editor on /operations/po-review for both. Approve / reject of a submission: routes/approvals.routes.ts.
 */

const router = Router();

export type Problem = { field: string; code: string; message: string };

const STATUSES = Object.values(UPLOAD_STATUS) as string[];

const text = (req: Request, name: string): string | undefined => {
  const v = req.query[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

const parseListQuery = (req: Request): PoReviewListQuery => {
  const problems: Problem[] = [];

  const status = text(req, PO_REVIEW_QUERY.STATUS) ?? UPLOAD_STATUS.NEEDS_REVIEW;
  if (!STATUSES.includes(status)) {
    problems.push({
      field: PO_REVIEW_QUERY.STATUS,
      code: ERROR_CODES.FIELD_NOT_ONE_OF,
      message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, PO_REVIEW_QUERY.STATUS, STATUSES.join(', ')),
    });
  }

  const day = (name: string): string | undefined => {
    const v = text(req, name);
    if (v && (!DAY_PATTERN.test(v) || Number.isNaN(Date.parse(v)))) {
      problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, name) });
      return undefined;
    }
    return v;
  };
  const from = day(PO_REVIEW_QUERY.FROM);
  const to = day(PO_REVIEW_QUERY.TO);
  if (from && to && from > to) {
    problems.push({
      field: PO_REVIEW_QUERY.FROM,
      code: ERROR_CODES.FIELD_RANGE_REVERSED,
      message: errorMessage(ERROR_CODES.FIELD_RANGE_REVERSED, PO_REVIEW_QUERY.FROM, PO_REVIEW_QUERY.TO),
    });
  }

  const int = (name: string, fallback: number, max: number): number => {
    const v = text(req, name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_INT_RANGE, message: errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, name, 1, max) });
      return fallback;
    }
    return n;
  };
  const page = int(PO_REVIEW_QUERY.PAGE, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = int(PO_REVIEW_QUERY.PAGE_SIZE, PO_REVIEW_LIST.DEFAULT_PAGE_SIZE, PO_REVIEW_LIST.MAX_PAGE_SIZE);

  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return {
    status: status as UploadStatus,
    channel: text(req, PO_REVIEW_QUERY.CHANNEL),
    q: text(req, PO_REVIEW_QUERY.Q),
    from,
    to,
    page,
    pageSize,
  };
};

router.get('/', requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER), async (req, res, next) => {
  try {
    const query = parseListQuery(req);
    const { items, total } = await listPoReview(query);
    res.json({ data: items, meta: { page: query.page, pageSize: query.pageSize, total } });
  } catch (err) {
    next(err);
  }
});

// Live updates (before /:uploadId): SSE + the version for the screen's polling fallback.
router.get(REVIEW_LIVE.EVENTS, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER), (req, res, next) => {
  reviewEvents(req, res).catch(next);
});
router.get(REVIEW_LIVE.STATE, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    res.json({ data: { version: await reviewVersion() } });
  } catch (err) {
    next(err);
  }
});

router.get('/:uploadId', requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER), async (req, res, next) => {
  try {
    const { uploadId } = req.params;
    if (!UPLOAD_ID_PATTERN.test(uploadId)) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
    res.json({ data: await getPoReview(uploadId) });
  } catch (err) {
    next(err);
  }
});

router.get('/:uploadId/file', requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER), async (req, res, next) => {
  try {
    const file = await getPoFile(uploadIdOf(req));
    res.setHeader('Content-Type', file.contentType);
    if (file.length !== undefined) res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    file.body.on('error', next);
    file.body.pipe(res);
  } catch (err) {
    next(err);
  }
});

// ---- Resubmit / reject ---------------------------------------------------------------------------------------------

const B = PO_REVIEW_BODY;

/** Field checks on a JSON body; `problems` collects every bad field, so the reviewer sees them all at once. */
export const bodyReader = (problems: Problem[]) => {
  const bad = (field: string, code: keyof typeof ERROR_CODES, ...args: unknown[]) =>
    problems.push({ field, code, message: (errorMessage as (c: string, ...a: unknown[]) => string)(ERROR_CODES[code], ...args) });
  const id = (v: unknown, field: string): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v))) return String(v);
    bad(field, 'FIELD_NOT_TEXT', field);
    return undefined;
  };
  const remark = (v: unknown, field: string, required: boolean): string | undefined => {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      if (required) bad(field, 'FIELD_REQUIRED', field);
      return undefined;
    }
    if (typeof v !== 'string') return bad(field, 'FIELD_NOT_TEXT', field), undefined;
    if (v.trim().length > PO_REVIEW_REMARK_MAX) return bad(field, 'FIELD_TOO_LONG', field, PO_REVIEW_REMARK_MAX), undefined;
    return v.trim();
  };
  const amount = (v: unknown, field: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) return bad(field, 'FIELD_NOT_NUMBER', field), undefined;
    return n;
  };
  const list = (v: unknown, field: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return bad(field, 'FIELD_NOT_LIST', field), [];
    return v;
  };
  const object = (v: unknown, field: string): Record<string, unknown> | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) return bad(field, 'FIELD_NOT_OBJECT', field), undefined;
    return v as Record<string, unknown>;
  };
  return { bad, id, remark, amount, list, object };
};

const parseResubmit = (body: unknown): ResubmitBody => {
  const problems: Problem[] = [];
  const r = bodyReader(problems);
  const b = r.object(body, 'body') ?? {};
  const location = r.object(b[B.LOCATION], B.LOCATION);
  const locationId = location ? r.id(location.detailsChannelId, B.DETAILS_CHANNEL_ID) : undefined;

  const lines = r.list(b[B.LINES], B.LINES).map((raw, i): LineCorrection | undefined => {
    const f = (name: string) => `${B.LINES}[${i}].${name}`;
    const l = r.object(raw, `${B.LINES}[${i}]`);
    if (!l) return undefined;
    const lineNo = l[B.LINE_NO];
    if (lineNo === undefined || lineNo === null || lineNo === '') return r.bad(f(B.LINE_NO), 'FIELD_REQUIRED', f(B.LINE_NO)), undefined;
    const pep = l[B.PEP_CODE];
    if (pep !== undefined && (typeof pep !== 'string' || !pep.trim())) r.bad(f(B.PEP_CODE), 'FIELD_NOT_TEXT', f(B.PEP_CODE));
    return {
      lineNo: String(lineNo),
      pepCode: typeof pep === 'string' && pep.trim() ? pep.trim() : undefined,
      qty: r.amount(l[B.QTY], f(B.QTY)),
      mrp: r.amount(l[B.MRP], f(B.MRP)),
      rate: r.amount(l[B.RATE], f(B.RATE)),
    };
  });

  const accept = r.list(b[B.ACCEPT], B.ACCEPT).map((raw, i) => {
    const a = r.object(raw, `${B.ACCEPT}[${i}]`);
    if (!a) return undefined;
    const issueId = r.id(a[B.ISSUE_ID], `${B.ACCEPT}[${i}].${B.ISSUE_ID}`);
    if (!issueId) return r.bad(`${B.ACCEPT}[${i}].${B.ISSUE_ID}`, 'FIELD_REQUIRED', `${B.ACCEPT}[${i}].${B.ISSUE_ID}`), undefined;
    return { issueId, remark: r.remark(a[B.REMARK], `${B.ACCEPT}[${i}].${B.REMARK}`, false) };
  });
  const remark = r.remark(b[B.REMARK], B.REMARK, false);

  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return {
    locationId,
    lines: lines.filter((l): l is LineCorrection => !!l),
    accept: accept.filter((a): a is { issueId: string; remark: string | undefined } => !!a),
    remark,
  };
};

const uploadIdOf = (req: Request): string => {
  const { uploadId } = req.params;
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  return uploadId;
};

router.post('/:uploadId/submit', requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (req, res, next) => {
  try {
    const uploadId = uploadIdOf(req);
    // Only the values with an error, unless the person's role has "PO Review: edit all fields" (2026-10-22).
    const editAll = await hasCapability(req.auth!.user.id, req.auth!.roles, CAPABILITY.PO_REVIEW_EDIT_ALL);
    res.json({ data: await submitForApproval(uploadId, parseResubmit(req.body), { id: req.auth!.user.id, email: req.auth!.user.email }, editAll) });
  } catch (err) {
    next(err);
  }
});

router.post('/:uploadId/reject', requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (req, res, next) => {
  try {
    const uploadId = uploadIdOf(req);
    const problems: Problem[] = [];
    const remark = bodyReader(problems).remark((req.body as Record<string, unknown> | undefined)?.[B.REMARK], B.REMARK, true);
    if (problems.length || !remark) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    res.json({ data: await rejectPo(uploadId, remark, { id: req.auth!.user.id, email: req.auth!.user.email }) });
  } catch (err) {
    next(err);
  }
});

// ---- Re-check after a master fix (2026-10-22, REVIEW_RECHECK) ------------------------------------------------------

/** POST /po-review/recheck: re-check every PO in review now (the timer does it every RECHECK_MINUTES too). Editor. */
router.post(REVIEW_RECHECK.ROUTE, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (_req, res, next) => {
  try {
    res.json({ data: await recheckInReview({ trigger: REVIEW_RECHECK.TRIGGER.BUTTON }) });
  } catch (err) {
    next(err);
  }
});

// ---- Uniware hand-off (2026-10-19): download the sale order CSV, then mark it uploaded into Uniware ----------------

const actorOf = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email });

/** uploadIds from the body: digits only, at most MAX_IDS, each once. */
const idsOf = (body: unknown): string[] => {
  const v = (body as Record<string, unknown> | undefined)?.[UNIWARE_HANDOFF.BODY_IDS];
  const ids = Array.isArray(v) ? [...new Set(v.map(String).filter((x) => UPLOAD_ID_PATTERN.test(x)))] : [];
  if (!ids.length || ids.length > UNIWARE_HANDOFF.MAX_IDS) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  return ids;
};

const sendCsv = (res: Response, file: { fileName: string; text: string }) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.text);
};

/** One PO's sale order CSV as a download (records the first download). Editor: downloading moves the PO on. */
router.get(UNIWARE_HANDOFF.CSV_ONE, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (req, res, next) => {
  try {
    sendCsv(res, await downloadOne(uploadIdOf(req), actorOf(req)));
  } catch (err) {
    next(err);
  }
});

/** Several POs as ONE combined CSV ({ uploadIds }); records each first download. */
router.post(UNIWARE_HANDOFF.CSV_MANY, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (req, res, next) => {
  try {
    sendCsv(res, await downloadCombined(idsOf(req.body), actorOf(req)));
  } catch (err) {
    next(err);
  }
});

/** Mark uploaded into Uniware ({ uploadIds, undo? }); only downloaded POs; then they show in PO Overview. */
router.post(UNIWARE_HANDOFF.MARK_UPLOADED, requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR), async (req, res, next) => {
  try {
    const undo = (req.body as Record<string, unknown> | undefined)?.[UNIWARE_HANDOFF.BODY_UNDO] === true;
    res.json({ data: await markUploaded(idsOf(req.body), actorOf(req), undo) });
  } catch (err) {
    next(err);
  }
});

export default router;
