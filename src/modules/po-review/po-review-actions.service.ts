import { AppDataSource } from '../../config/data-source';
import {
  ACCEPTABLE_ISSUE_TYPES,
  ChannelName,
  ERROR_CODES,
  FILES,
  ISSUE_ACTION,
  ISSUE_STATUS,
  saleOrderCode,
  UNIWARE_CSV,
  UPLOAD_STATUS,
} from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoIssue, PoIssueAction, PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { readS3Json, siblingS3Url, writeS3Text } from '../email-intake/s3-mirror.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { csvOf, poRows, takeSerial } from '../po-pipeline/po-save.service';
import { issueKey } from '../po-pipeline/po-uploads.service';
import { MasterDataReader, matchKey } from '../po-validation/master-data';
import { todayIst, validatePo } from '../po-validation/validate-po';

/*
 * The reviewer's two actions on a PO in review (API contract "PO review", user 2026-10-09):
 *   resubmit: apply the reviewer's corrections (delivery location, SKU per line, qty / MRP / rate the OCR misread) and
 *             accepts (only OTHER and PO_EXPIRED), validate again, and if nothing is left open save it as the chain
 *             does: PO rows + sale order code + Uniware CSV, status completed. Still failing -> 422, nothing written.
 *   reject:   status rejected, every open issue rejected with the remark. Nothing is saved.
 * Files are read from and written to S3 only (corrected.json and the CSV next to processed.json; processed.json
 * itself is never changed). The reviewer is the signed-in user; every issue change writes a po_issue_actions row.
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

/** The PO upload, which must still be in review (someone else may have acted on it). */
const inReview = (upload: PoUpload | null, uploadId: string): PoUpload => {
  if (!upload) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  if (upload.status !== UPLOAD_STATUS.NEEDS_REVIEW) throw appError(ERROR_CODES.UPLOAD_NOT_IN_REVIEW, uploadId, upload.status);
  return upload;
};

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

export const resubmitPo = async (uploadId: string, body: ResubmitBody, actor: string): Promise<ResubmitResult> => {
  const upload = inReview(await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId }), uploadId);
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

  // Save as the chain's step 2 does, in one transaction; the S3 files are written last, so a failure rolls it all back.
  const today = todayIst(now);
  const correctedUrl = siblingS3Url(processedUrl, FILES.CORRECTED);
  const csvUrl = siblingS3Url(processedUrl, UNIWARE_CSV.FILE_NAME(v.poNumber, today));
  const rows = poRows(v, { today, now, poDate: fixedPo.po_date || null, document: correctedUrl });
  const acceptRemark = new Map(accepted.map((a) => [String(a.issue.id), a.remark]));
  const correction = { locationId: body.locationId ?? null, lines: body.lines };

  let code = '';
  let poUid = '';
  await AppDataSource.transaction(async (m) => {
    const locked = inReview(await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } }), uploadId);
    code = saleOrderCode(today, await takeSerial(m, today));
    const masterRepo = m.getRepository(MasterPurchaseOrder);
    const masterRow = await masterRepo.save(masterRepo.create(rows.master));
    poUid = String(masterRow.uid);
    const details = m.getRepository(DetailsPurchaseOrder);
    await details.save(rows.details.map((d) => details.create({ ...d, shipmentOrderId: masterRow.uid })));

    const issues = m.getRepository(PoIssue);
    const actions = m.getRepository(PoIssueAction);
    for (const issue of open) {
      const isAccepted = acceptRemark.has(String(issue.id));
      const remark = (isAccepted ? acceptRemark.get(String(issue.id)) : body.remark) ?? null;
      const resolvedValues = isAccepted ? { accepted: true } : correction;
      await issues.save({ ...issue, status: ISSUE_STATUS.APPROVED, resolvedBy: actor, resolvedAt: now, remark, resolvedValues });
      await actions.save(
        actions.create({ issueId: issue.id, action: ISSUE_ACTION.APPROVED, actionBy: actor, remark, beforeValue: issue.originalValues, afterValue: resolvedValues }),
      );
    }

    await writeS3Text(correctedUrl, `${JSON.stringify({ ...fixedPo, review: { by: actor, at: now.toISOString(), ...correction, accepted: [...acceptRemark.keys()] } }, null, 2)}\n`);
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
  console.log(`[po-review] ${uploadId} ${v.poNumber}: resubmitted by ${actor}, sale order ${code}, CSV ${csvUrl}`);
  return { status: UPLOAD_STATUS.COMPLETED, poUid, saleOrderCode: code, uniwareCsv: csvUrl, resolvedIssues: open.map((i) => String(i.id)) };
};

export const rejectPo = async (uploadId: string, remark: string, actor: string): Promise<{ status: string; rejectedIssues: string[] }> => {
  const rejected: string[] = [];
  await AppDataSource.transaction(async (m) => {
    const upload = inReview(await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } }), uploadId);
    const issues = m.getRepository(PoIssue);
    const actions = m.getRepository(PoIssueAction);
    const now = new Date();
    for (const issue of await issues.findBy({ uploadId, status: ISSUE_STATUS.OPEN })) {
      await issues.save({ ...issue, status: ISSUE_STATUS.REJECTED, resolvedBy: actor, resolvedAt: now, remark });
      await actions.save(actions.create({ issueId: issue.id, action: ISSUE_ACTION.REJECTED, actionBy: actor, remark, beforeValue: issue.originalValues }));
      rejected.push(String(issue.id));
    }
    await m.getRepository(PoUpload).save({ ...upload, status: UPLOAD_STATUS.REJECTED });
  });
  console.log(`[po-review] ${uploadId}: rejected by ${actor}: ${remark}`);
  return { status: UPLOAD_STATUS.REJECTED, rejectedIssues: rejected };
};
