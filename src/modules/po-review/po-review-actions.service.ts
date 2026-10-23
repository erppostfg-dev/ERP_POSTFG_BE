import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCEPTABLE_ISSUE_TYPES,
  ChannelName,
  ERROR_CODES,
  FILES,
  ISSUE_ACTION,
  ISSUE_STATUS,
  PO_REVIEW_REMARK_MAX,
  REVIEW_FIX_FIELD,
  REVIEW_SUBMISSION_STATUS,
  REVIEW_SUBMISSION_TYPE,
  saleOrderCode,
  SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE,
  UNIWARE_CSV,
  UPLOAD_STATUS,
  UploadStatus,
} from '../../constants';
import {
  DetailsPurchaseOrder,
  MasterPurchaseOrder,
  PoIssue,
  PoIssueAction,
  PoReviewSubmission,
  PoUpload,
  ReviewFixes,
  ShipmentLog,
  User,
} from '../../entities';
import { flushChanges } from '../po-overview/po-overview.live';
import { bumpReview } from './po-review.live';
import { editRules, lockedChanges } from './review-edit-rules';
import { AppError, appError } from '../../utils/AppError';
import { readS3Json, siblingS3Url, writeS3Text } from '../email-intake/s3-mirror.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { csvOf, poRows, takeSerial } from '../po-pipeline/po-save.service';
import { issueKey } from '../po-pipeline/po-uploads.service';
import { MasterDataReader, matchKey } from '../po-validation/master-data';
import { todayIst, validatePo } from '../po-validation/validate-po';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';

/*
 * Actions on a PO in review (API contract "PO review", user 2026-10-09; approval step, user 2026-10-15):
 *   submit:   the reviewer's corrections (delivery location, SKU per line, qty / MRP / rate the OCR misread) and accepts
 *             (only OTHER and PO_EXPIRED) are checked and the corrected PO validated again. It must pass completely
 *             (every issue fixed or accepted, every field filled) or nothing happens (422 with what is still open). Then
 *             a po_review_submissions row (pending) is written and the upload becomes pending_approval: it leaves In
 *             Review and waits on the Approvals page. Nothing goes to the PO tables yet.
 *   approve:  an approver (APPROVER_ROLES) replays the stored corrections, validates again and saves the PO as the chain
 *             does (PO rows + sale order code + Uniware CSV, status completed), in one transaction with the decision.
 *             If the PO no longer passes (e.g. a master changed meanwhile) it goes back to In Review by itself with the
 *             reason (submission `returned`): self-healing, nothing half-saved.
 *   reject (approver): the submission and the PO are rejected with the reason; open issues rejected.
 *   reject (reviewer, directly from PO Review): as before, plus a po_review_submissions row (reviewer_reject) with who,
 *             when and why, so rejected POs can be listed later.
 * Files are read from and written to S3 only (corrected.json and the CSV next to processed.json; processed.json itself
 * is never changed). Every issue change writes a po_issue_actions row.
 */

export interface LineCorrection {
  lineNo: string;
  /** Our SKU for this line (must be in the channel's SKU master). */
  pepCode?: string;
  /** What the PO really says, where the OCR misread it. */
  qty?: number;
  mrp?: number;
  /** PO unit price with tax. */
  rate?: number;
}

export interface ResubmitBody {
  locationId?: string;
  lines: LineCorrection[];
  accept: { issueId: string; remark?: string }[];
  remark?: string;
}

export interface ResubmitResult {
  status: string;
  poUid: string;
  saleOrderCode: string;
  uniwareCsv: string;
  resolvedIssues: string[];
}

/** The signed-in person acting (users.id + email). */
export interface Actor {
  id: number;
  email: string;
}

/** The PO upload, which must be in the given status (someone else may have acted on it). */
const inStatus = (upload: PoUpload | null, uploadId: string, status: UploadStatus = UPLOAD_STATUS.NEEDS_REVIEW): PoUpload => {
  if (!upload) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  if (upload.status !== status) throw appError(ERROR_CODES.UPLOAD_NOT_IN_REVIEW, uploadId, upload.status);
  return upload;
};

const lockUpload = async (m: EntityManager, uploadId: string, status?: UploadStatus) =>
  inStatus(await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } }), uploadId, status);

/** processed.json with the reviewer's line corrections (a copy; the original stays as it is). */
const corrected = (po: ProcessedPo, lines: LineCorrection[]): ProcessedPo => {
  const out = structuredClone(po);
  for (const c of lines) {
    const line = out.line_items.find((l) => String(l.line_no) === c.lineNo);
    if (!line) continue;
    if (c.pepCode !== undefined) line.pep_sku_code = c.pepCode;
    if (c.qty !== undefined) line.qty = c.qty;
    if (c.mrp !== undefined) line.channel_mrp = c.mrp;
    if (c.rate !== undefined) line.landing_rate = c.rate;
    // The PO's line total no longer fits a corrected qty or rate: it is worked out again from them.
    if (c.qty !== undefined || c.rate !== undefined) line.line_total = '';
  }
  return out;
};

/** Checks the corrections against the PO and validates the corrected PO; REVIEW_INCOMPLETE if anything is still open. */
const prepare = async (uploadId: string, body: ResubmitBody, status: UploadStatus) => {
  const upload = inStatus(await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId }), uploadId, status);
  const processedUrl = upload.ocrResult?.processed_json;
  const po = typeof processedUrl === 'string' ? await readS3Json<ProcessedPo>(processedUrl) : undefined;
  if (!po || typeof processedUrl !== 'string') throw appError(ERROR_CODES.PROCESSED_JSON_MISSING, uploadId);
  const master = await new MasterDataReader(AppDataSource).forChannel(po.channel_name as ChannelName);
  const channel = master?.channel.displayName ?? po.channel_name;

  // The request must fit this PO: open issues of it, its channel's locations and SKUs, its line numbers.
  const open = await AppDataSource.getRepository(PoIssue).findBy({ uploadId, status: ISSUE_STATUS.OPEN });
  const accepted = body.accept.map((a) => {
    const issue = open.find((i) => String(i.id) === a.issueId);
    if (!issue) throw appError(ERROR_CODES.ISSUE_NOT_OPEN, a.issueId);
    if (!ACCEPTABLE_ISSUE_TYPES.includes(issue.issueType)) throw appError(ERROR_CODES.ISSUE_NOT_ACCEPTABLE, a.issueId, issue.issueType);
    return { issue, remark: a.remark ?? body.remark ?? null };
  });
  if (body.locationId && !master?.locations.some((l) => String(l.id) === body.locationId)) {
    throw appError(ERROR_CODES.LOCATION_NOT_IN_CHANNEL, body.locationId, channel);
  }
  const lineNos = new Set(po.line_items.map((l) => String(l.line_no)));
  for (const c of body.lines) {
    if (!lineNos.has(c.lineNo)) throw appError(ERROR_CODES.LINE_NOT_IN_PO, c.lineNo);
    if (c.pepCode !== undefined && !master?.skusByPep.has(matchKey(c.pepCode))) throw appError(ERROR_CODES.SKU_NOT_IN_MASTER, c.pepCode, channel);
  }

  // Validate the corrected PO; what is left must all be accepted.
  const fixedPo = corrected(po, body.lines);
  const pepCodeByLine = new Map(body.lines.filter((c) => c.pepCode !== undefined).map((c) => [c.lineNo, c.pepCode as string]));
  const now = new Date();
  const v = await validatePo(fixedPo, master, now, { locationId: body.locationId, pepCodeByLine });
  const acceptedKeys = new Set(accepted.map(({ issue }) => issueKey(issue.issueType, issue.lineNo, issue.fieldName)));
  const left = v.issues.filter((i) => !acceptedKeys.has(issueKey(i.type, i.lineNo, i.field)));
  if (left.length || !v.location) {
    throw appError(ERROR_CODES.REVIEW_INCOMPLETE, Math.max(left.length, 1)).withDetails({
      openIssues: left.map((i) => ({ type: i.type, field: i.field, lineNo: i.lineNo === '' ? null : (i.lineNo ?? null), message: i.message })),
    });
  }
  return { upload, po, processedUrl, master, open, accepted, fixedPo, v, now };
};
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** What the reviewer changed, old -> new, for the approver (stored with the submission so it never changes). */
const fixesOf = (p: Prepared, body: ResubmitBody): ReviewFixes => {
  const loc = body.locationId ? p.master?.locations.find((l) => String(l.id) === body.locationId) : undefined;
  const acceptedRemark = new Map(p.accepted.map((a) => [String(a.issue.id), a.remark]));
  return {
    location: loc ? { from: p.po.delivery_facility_code || null, to: loc.channelLocationCode ?? body.locationId ?? null } : null,
    lines: body.lines
      .map((c) => {
        const line = p.po.line_items.find((l) => String(l.line_no) === c.lineNo);
        const changes: ReviewFixes['lines'][number]['changes'] = [];
        const add = (field: string, from: unknown, to: unknown) => {
          if (to !== undefined && String(from ?? '') !== String(to)) changes.push({ field, from: from === '' ? null : (from ?? null), to });
        };
        add(REVIEW_FIX_FIELD.SKU, line?.pep_sku_code, c.pepCode);
        add(REVIEW_FIX_FIELD.QTY, line?.qty, c.qty);
        add(REVIEW_FIX_FIELD.MRP, line?.channel_mrp, c.mrp);
        add(REVIEW_FIX_FIELD.RATE, line?.landing_rate, c.rate);
        return { lineNo: c.lineNo, channelSku: line?.channel_sku_code || null, description: line?.description || null, changes };
      })
      .filter((l) => l.changes.length),
    issues: p.open.map((i) => ({
      issueId: String(i.id),
      type: i.issueType,
      lineNo: i.lineNo === null ? null : String(i.lineNo),
      field: i.fieldName,
      message: i.details,
      how: acceptedRemark.has(String(i.id)) ? 'accepted' : 'fixed',
      remark: acceptedRemark.get(String(i.id)) ?? null,
    })),
  };
};

/**
 * Saves the prepared PO as the chain's step 2 does, in one transaction (the S3 files are written last, so a failure
 * rolls it all back): PO rows + sale order + Uniware CSV, issues closed (resolvedBy = the reviewer), status completed.
 * `also` runs inside the same transaction (the approval decision).
 */
const savePo = async (
  p: Prepared,
  body: ResubmitBody,
  status: UploadStatus,
  reviewer: string,
  actorId: number | null,
  also?: (m: EntityManager, r: { poUid: string; code: string }) => Promise<void>,
): Promise<ResubmitResult> => {
  const { v, fixedPo, processedUrl, open, accepted, now } = p;
  const uploadId = p.upload.id;
  const today = todayIst(now);
  const correctedUrl = siblingS3Url(processedUrl, FILES.CORRECTED);
  const csvUrl = siblingS3Url(processedUrl, UNIWARE_CSV.FILE_NAME(v.poNumber, today));
  const rows = poRows(v, { today, now, poDate: fixedPo.po_date || null, expiryDate: fixedPo.expiry_date || null, document: correctedUrl });
  const acceptRemark = new Map(accepted.map((a) => [String(a.issue.id), a.remark]));
  const correction = { locationId: body.locationId ?? null, lines: body.lines };

  let code = '';
  let poUid = '';
  await AppDataSource.transaction(async (m) => {
    const locked = await lockUpload(m, uploadId, status);
    code = saleOrderCode(today, await takeSerial(m, today));
    const masterRepo = m.getRepository(MasterPurchaseOrder);
    // The sale order code also goes into orderNo1 (PEPIMS's "Order No 1"; user, 2026-10-14).
    const masterRow = await masterRepo.save(masterRepo.create({ ...rows.master, orderNo1: code }));
    poUid = String(masterRow.uid);
    await m.getRepository(ShipmentLog).insert({ shipmentUid: poUid, userId: actorId, action: SHIPMENT_LOG_ACTION.CREATED, source: SHIPMENT_LOG_SOURCE.REVIEW, remark: code });
    const details = m.getRepository(DetailsPurchaseOrder);
    await details.save(rows.details.map((d) => details.create({ ...d, shipmentOrderId: masterRow.uid })));

    const issues = m.getRepository(PoIssue);
    const actions = m.getRepository(PoIssueAction);
    for (const issue of open) {
      const isAccepted = acceptRemark.has(String(issue.id));
      const remark = (isAccepted ? acceptRemark.get(String(issue.id)) : body.remark) ?? null;
      const resolvedValues = isAccepted ? { accepted: true } : correction;
      await issues.save({ ...issue, status: ISSUE_STATUS.APPROVED, resolvedBy: reviewer, resolvedAt: now, remark, resolvedValues });
      await actions.save(
        actions.create({ issueId: issue.id, action: ISSUE_ACTION.APPROVED, actionBy: reviewer, remark, beforeValue: issue.originalValues, afterValue: resolvedValues }),
      );
    }
    if (also) await also(m, { poUid, code });

    await writeS3Text(correctedUrl, `${JSON.stringify({ ...fixedPo, review: { by: reviewer, at: now.toISOString(), ...correction, accepted: [...acceptRemark.keys()] } }, null, 2)}\n`);
    await writeS3Text(csvUrl, csvOf(v, rows.master.poDate ?? null, code));
    await m.getRepository(PoUpload).save({
      ...locked,
      poUid,
      uniwareCsvUrl: csvUrl,
      status: UPLOAD_STATUS.COMPLETED,
      completedAt: now,
      errorDetails: null,
    });
  });
  log.info(LOG_SOURCE.APP, `[po-review] ${uploadId} ${v.poNumber}: saved (reviewer ${reviewer}), sale order ${code}, CSV ${csvUrl}`);
  void flushChanges();
  return { status: UPLOAD_STATUS.COMPLETED, poUid, saleOrderCode: code, uniwareCsv: csvUrl, resolvedIssues: open.map((i) => String(i.id)) };
};

/** The reviewer submits the fixed PO for approval: it must pass completely; nothing goes to the PO tables yet. */
export const submitForApproval = async (
  uploadId: string,
  body: ResubmitBody,
  by: Actor,
  /** The person may change any value (CAPABILITY.PO_REVIEW_EDIT_ALL); else only the values with an open error. */
  editAll = false,
): Promise<{ status: string; submissionId: string }> => {
  if (!editAll) {
    const open = await AppDataSource.getRepository(PoIssue).findBy({ uploadId, status: ISSUE_STATUS.OPEN });
    const locked = lockedChanges(editRules(open), body);
    if (locked.length) throw appError(ERROR_CODES.REVIEW_FIELD_LOCKED, locked.join(', ')).withDetails({ locked });
  }
  const p = await prepare(uploadId, body, UPLOAD_STATUS.NEEDS_REVIEW);
  const fixes = fixesOf(p, body);
  let submissionId = '';
  await AppDataSource.transaction(async (m) => {
    const locked = await lockUpload(m, uploadId);
    const repo = m.getRepository(PoReviewSubmission);
    const row = await repo.save(
      repo.create({
        uploadId,
        type: REVIEW_SUBMISSION_TYPE.APPROVAL,
        status: REVIEW_SUBMISSION_STATUS.PENDING,
        poNumber: p.v.poNumber || locked.poNumber,
        channel: locked.channel,
        changes: body as unknown as Record<string, unknown>,
        fixes,
        submittedBy: by.id,
        submittedAt: p.now,
        submitRemark: body.remark ?? null,
      }),
    );
    submissionId = String(row.id);
    await m.getRepository(PoUpload).save({ ...locked, status: UPLOAD_STATUS.PENDING_APPROVAL });
  });
  log.info(LOG_SOURCE.APP, `[po-review] ${uploadId} ${p.v.poNumber}: submitted for approval by ${by.email} (submission ${submissionId})`);
  bumpReview();
  return { status: UPLOAD_STATUS.PENDING_APPROVAL, submissionId };
};

/** A pending approval submission; locked when a transaction manager is given. */
const pendingSubmission = async (id: string, m?: EntityManager): Promise<PoReviewSubmission> => {
  const repo = (m ?? AppDataSource.manager).getRepository(PoReviewSubmission);
  const where = { id, type: REVIEW_SUBMISSION_TYPE.APPROVAL };
  const s = m ? await repo.findOne({ where, lock: { mode: 'pessimistic_write' } }) : await repo.findOne({ where });
  if (!s) throw appError(ERROR_CODES.SUBMISSION_NOT_FOUND, id);
  if (s.status !== REVIEW_SUBMISSION_STATUS.PENDING) throw appError(ERROR_CODES.SUBMISSION_NOT_PENDING, id, s.status);
  return s;
};

/** Approver: replay the reviewer's corrections, validate again, create the PO. No longer passing -> back to In Review. */
export const approveSubmission = async (id: string, by: Actor, remark?: string): Promise<ResubmitResult & { submissionId: string }> => {
  const s = await pendingSubmission(id);
  const body = s.changes as unknown as ResubmitBody;
  // Issues are resolved by the reviewer who fixed them; the approval itself is recorded on the submission.
  const reviewer = (s.submittedBy ? await AppDataSource.getRepository(User).findOneBy({ id: s.submittedBy }) : null)?.email ?? by.email;
  let p: Prepared;
  try {
    p = await prepare(s.uploadId, body, UPLOAD_STATUS.PENDING_APPROVAL);
  } catch (err) {
    // Self-healing: the PO no longer passes (a master changed, a SKU was switched off...): back to In Review with the
    // reason, so the reviewer sees why and fixes it again. A technical error (S3 down) leaves it pending for a retry.
    if (!(err instanceof AppError) || err.statusCode >= 500 || err.code === ERROR_CODES.UPLOAD_NOT_IN_REVIEW) throw err;
    await AppDataSource.transaction(async (m) => {
      const locked = await pendingSubmission(id, m);
      await m.getRepository(PoReviewSubmission).save({
        ...locked,
        status: REVIEW_SUBMISSION_STATUS.RETURNED,
        decidedAt: new Date(),
        decisionRemark: err.message.slice(0, PO_REVIEW_REMARK_MAX),
      });
      await m.getRepository(PoUpload).update({ id: s.uploadId, status: UPLOAD_STATUS.PENDING_APPROVAL }, { status: UPLOAD_STATUS.NEEDS_REVIEW });
    });
    log.warn(LOG_SOURCE.APP, `[po-review] submission ${id}: returned to In Review: ${err.message}`);
    bumpReview();
    const open = (err.details as { openIssues?: unknown[] } | undefined)?.openIssues;
    throw appError(ERROR_CODES.REVIEW_RETURNED, Array.isArray(open) ? open.length : 1).withDetails(err.details ?? { reason: err.message });
  }
  const result = await savePo(p, body, UPLOAD_STATUS.PENDING_APPROVAL, reviewer, by.id, async (m, r) => {
    const locked = await pendingSubmission(id, m);
    await m.getRepository(PoReviewSubmission).save({
      ...locked,
      status: REVIEW_SUBMISSION_STATUS.APPROVED,
      decidedBy: by.id,
      decidedAt: new Date(),
      decisionRemark: remark ?? null,
      poUid: r.poUid,
      saleOrderCode: r.code,
    });
  });
  log.info(LOG_SOURCE.APP, `[po-review] submission ${id}: approved by ${by.email}`);
  bumpReview();
  return { ...result, submissionId: id };
};

/** Every open issue of the upload rejected with the remark (+ a po_issue_actions row each). */
const rejectIssues = async (m: EntityManager, uploadId: string, remark: string, actor: string): Promise<string[]> => {
  const issues = m.getRepository(PoIssue);
  const actions = m.getRepository(PoIssueAction);
  const now = new Date();
  const ids: string[] = [];
  for (const issue of await issues.findBy({ uploadId, status: ISSUE_STATUS.OPEN })) {
    await issues.save({ ...issue, status: ISSUE_STATUS.REJECTED, resolvedBy: actor, resolvedAt: now, remark });
    await actions.save(actions.create({ issueId: issue.id, action: ISSUE_ACTION.REJECTED, actionBy: actor, remark, beforeValue: issue.originalValues }));
    ids.push(String(issue.id));
  }
  return ids;
};

/** Approver: reject the submitted PO with the reason. */
export const rejectSubmission = async (id: string, remark: string, by: Actor): Promise<{ status: string; rejectedIssues: string[] }> => {
  const rejected: string[] = [];
  await AppDataSource.transaction(async (m) => {
    const s = await pendingSubmission(id, m);
    const upload = await lockUpload(m, s.uploadId, UPLOAD_STATUS.PENDING_APPROVAL);
    rejected.push(...(await rejectIssues(m, s.uploadId, remark, by.email)));
    await m.getRepository(PoUpload).save({ ...upload, status: UPLOAD_STATUS.REJECTED });
    await m.getRepository(PoReviewSubmission).save({ ...s, status: REVIEW_SUBMISSION_STATUS.REJECTED, decidedBy: by.id, decidedAt: new Date(), decisionRemark: remark });
  });
  log.info(LOG_SOURCE.APP, `[po-review] submission ${id}: rejected by ${by.email}: ${remark}`);
  bumpReview();
  return { status: UPLOAD_STATUS.REJECTED, rejectedIssues: rejected };
};

/** The reviewer rejects the PO directly from PO Review (no approval); who / when / why kept in po_review_submissions. */
export const rejectPo = async (uploadId: string, remark: string, by: Actor): Promise<{ status: string; rejectedIssues: string[] }> => {
  const rejected: string[] = [];
  await AppDataSource.transaction(async (m) => {
    const upload = await lockUpload(m, uploadId);
    rejected.push(...(await rejectIssues(m, uploadId, remark, by.email)));
    await m.getRepository(PoUpload).save({ ...upload, status: UPLOAD_STATUS.REJECTED });
    const now = new Date();
    await m.getRepository(PoReviewSubmission).insert({
      uploadId,
      type: REVIEW_SUBMISSION_TYPE.REVIEWER_REJECT,
      status: REVIEW_SUBMISSION_STATUS.REJECTED,
      poNumber: upload.poNumber,
      channel: upload.channel,
      submittedBy: by.id,
      submittedAt: now,
      decidedBy: by.id,
      decidedAt: now,
      decisionRemark: remark,
    });
  });
  log.info(LOG_SOURCE.APP, `[po-review] ${uploadId}: rejected by ${by.email}: ${remark}`);
  bumpReview();
  return { status: UPLOAD_STATUS.REJECTED, rejectedIssues: rejected };
};
