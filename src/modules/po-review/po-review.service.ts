import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  TABLES,
  isAcceptableIssue,
  ChannelName,
  ERROR_CODES,
  IST_OFFSET_MS,
  ISSUE_STATUS,
  ISSUE_TYPE,
  IssueType,
  PO_REVIEW_LINK_MINUTES,
  PoWarning,
  REVIEW_SUBMISSION_STATUS,
  REVIEW_SUBMISSION_TYPE,
  UPLOAD_STATUS,
  UploadStatus,
} from '../../constants';
import { DetailsChannel, DetailsPurchaseOrder, PoIssue, PoReopen, PoReviewSubmission, PoUpload, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { openS3File, readS3JsonCached, s3DownloadLink } from '../email-intake/s3-mirror.service';
import { Num, ProcessedPo } from '../po-processing/common/processed-po';
import { matchKey, panelMasterFor } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';
import { verifyStatesOf, type VerifyStateItem } from '../po-verify/po-verify.service';

/*
 * GET /po-review (API contract "PO review"): po_uploads of one status, newest first, with what the review screens
 * list: the PO's lines, units and value from the PO tables (once saved), and its open issues. Reads only.
 */

export interface PoReviewListQuery {
  status: UploadStatus;
  channel?: string;
  q?: string;
  /** Calendar days (YYYY-MM-DD) in Indian time, both included. */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface PoReviewListItem {
  uploadId: string;
  poNumber: string | null;
  channel: string | null;
  status: UploadStatus;
  ocrStatus: string;
  source: string;
  /** The email's subject; for an API PO the channel's own name for it (Amazon: the shipment name). Copied on the screen. */
  subject: string | null;
  fileName: string;
  /** The PO's own date: the saved PO's, else as read from the PO (po_uploads.po_date, for POs in review). */
  poDate: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  /**
   * When the system processed it (2026-10-29): completed = completedAt; otherwise when the PO was read (OCR finished),
   * or, for POs read without OCR (sheets, API), when the row was made.
   */
  processedAt: string | null;
  brand: string | null;
  saleOrderCode: string | null;
  lines: number | null;
  units: number | null;
  poValue: number | null;
  openIssues: number;
  issueTypes: string[];
  /** Uniware hand-off (completed POs): first CSV download and the "uploaded into Uniware" mark, with who. */
  csvDownloadedAt: string | null;
  csvDownloadedBy: string | null;
  uniwareUploadedAt: string | null;
  uniwareUploadedBy: string | null;
  /**
   * Failed POs (2026-11-02, user: "show the failed ones with why"): the step that failed (PIPELINE_STEP: ocr, processing,
   * save_po, uniware_csv, release), its code and reason as stored in po_uploads.error_details, and when. null otherwise.
   */
  failure: { step: string | null; code: string | null; reason: string | null; at: string | null; ocrAttempts: number } | null;
  /** Rejected POs: the latest rejection: by the reviewer (from PO review) or the approver (Approvals), who, when, why. */
  rejection: { by: string | null; byEmail: string | null; at: string | null; reason: string | null; from: 'review' | 'approval' } | null;
  /**
   * Processed POs (2026-11-03): the verification state (To verify / Verified / In Uniware / not required), whether its
   * channel needs it, who verified and when; null for the other lists. Replaces the screen's GET /po-verify?uploadIds.
   */
  verify: Omit<VerifyStateItem, 'uploadId'> | null;
  /** Reopened after a rejection (2026-11-03): the latest reopen (when, why) and the rejection it undid; null = never. */
  reopened: { at: string; remark: string; rejectedReason: string | null; rejectedFrom: string | null; times: number } | null;
}

/** po_uploads.error_details as the pipeline writes it ({ step, code?, reason? | message? }). */
const failureOf = (u: PoUpload): PoReviewListItem['failure'] => {
  if (u.status !== UPLOAD_STATUS.FAILED) return null;
  const e: Record<string, unknown> = u.errorDetails ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { step: str(e.step), code: str(e.code), reason: str(e.reason) ?? str(e.message) ?? str(e.error), at: iso(u.updatedAt), ocrAttempts: u.ocrAttempts };
};

const reopenedFor = (e: { latest: PoReopen; times: number } | undefined): PoReviewListItem['reopened'] =>
  e ? { at: e.latest.reopenedAt.toISOString(), remark: e.latest.remark, rejectedReason: e.latest.rejectedReason, rejectedFrom: e.latest.rejectedFrom, times: e.times } : null;

const rejectionFor = (
  u: PoUpload, r: PoReviewSubmission | undefined, who: (id: number | null) => string | null, emailOf: (id: number | null) => string | null,
): PoReviewListItem['rejection'] => {
  if (u.status !== UPLOAD_STATUS.REJECTED) return null;
  if (!r) return { by: null, byEmail: null, at: iso(u.updatedAt), reason: null, from: 'review' };
  return {
    by: who(r.decidedBy), byEmail: emailOf(r.decidedBy), at: iso(r.decidedAt), reason: r.decisionRemark,
    from: r.type === REVIEW_SUBMISSION_TYPE.REVIEWER_REJECT ? 'review' : 'approval',
  };
};

/** Start of an Indian-time calendar day, as the UTC instant the DB stores (timezone 'Z'). */
const istDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const listPoReview = async (query: PoReviewListQuery): Promise<{ items: PoReviewListItem[]; total: number }> => {
  // Completed POs are listed and filtered by when they finished, newest first; the rest by when they arrived,
  // oldest first (the PO waiting longest for a reviewer is on top).
  const dateColumn = query.status === UPLOAD_STATUS.COMPLETED ? 'u.completedAt' : 'u.createdAt';
  // Rejected / failed (2026-11-02): the latest first, by when it was rejected / failed.
  const ended = query.status === UPLOAD_STATUS.REJECTED || query.status === UPLOAD_STATUS.FAILED;
  const order = query.status === UPLOAD_STATUS.COMPLETED || ended ? 'DESC' : 'ASC';
  const orderColumn = ended ? 'u.updatedAt' : dateColumn;

  const qb = AppDataSource.getRepository(PoUpload)
    .createQueryBuilder('u')
    .leftJoinAndSelect('u.purchaseOrder', 'po')
    .where('u.status = :status', { status: query.status });
  // Failed: a dismissed PO (Failed tab "Dismiss", 2026-11-04) is kept but not listed
  if (query.status === UPLOAD_STATUS.FAILED) qb.andWhere("JSON_EXTRACT(u.errorDetails, '$.dismissed') IS NULL");
  if (query.channel) qb.andWhere('u.channel = :channel', { channel: query.channel });
  if (query.q) qb.andWhere('(u.poNumber LIKE :q OR u.fileName LIKE :q)', { q: `%${query.q}%` });
  // Completed POs not yet uploaded into Uniware always show, whatever the date range (user, 2026-10-19).
  const range: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.from) { range.push(`${dateColumn} >= :from`); params.from = istDayStart(query.from); }
  if (query.to) { range.push(`${dateColumn} < :toEnd`); params.toEnd = new Date(istDayStart(query.to).getTime() + DAY_MS); }
  if (range.length) {
    const inRange = range.join(' AND ');
    qb.andWhere(query.status === UPLOAD_STATUS.COMPLETED ? `((${inRange}) OR u.uniwareUploadedAt IS NULL)` : inRange, params);
  }

  const [uploads, total] = await qb
    .orderBy(orderColumn, order)
    .addOrderBy('u.id', order)
    .skip((query.page - 1) * query.pageSize)
    .take(query.pageSize)
    .getManyAndCount();
  if (!uploads.length) return { items: [], total };

  // Lines and value per saved PO (details_purchase_orders), open issues per upload: one grouped query each.
  const poUids = uploads.map((u) => u.poUid).filter((v): v is string => v !== null);
  const lineTotals = poUids.length
    ? await AppDataSource.getRepository(DetailsPurchaseOrder)
        .createQueryBuilder('d')
        .select('d.shipmentOrderId', 'poUid')
        .addSelect('COUNT(*)', 'lines')
        .addSelect('SUM(d.poValue)', 'poValue')
        .where({ shipmentOrderId: In(poUids) })
        .groupBy('d.shipmentOrderId')
        .getRawMany<{ poUid: string; lines: string; poValue: string | null }>()
    : [];
  const linesByPo = new Map(lineTotals.map((r) => [String(r.poUid), r]));

  const openIssues = await AppDataSource.getRepository(PoIssue)
    .createQueryBuilder('i')
    .select('i.uploadId', 'uploadId')
    .addSelect('i.issueType', 'issueType')
    .addSelect('COUNT(*)', 'count')
    .where({ uploadId: In(uploads.map((u) => u.id)), status: ISSUE_STATUS.OPEN })
    .groupBy('i.uploadId')
    .addGroupBy('i.issueType')
    .getRawMany<{ uploadId: string; issueType: string; count: string }>();

  // Rejected ones: their latest rejected submission (reviewer reject from PO review, or the approver's reject).
  const rejectedIds = uploads.filter((u) => u.status === UPLOAD_STATUS.REJECTED).map((u) => u.id);
  const rejections = rejectedIds.length
    ? await AppDataSource.getRepository(PoReviewSubmission).find({
        select: { id: true, uploadId: true, type: true, decidedBy: true, decidedAt: true, decisionRemark: true },
        where: { uploadId: In(rejectedIds), status: REVIEW_SUBMISSION_STATUS.REJECTED },
        order: { id: 'DESC' },
      })
    : [];
  const rejectionOf = new Map<string, PoReviewSubmission>();
  for (const r of rejections) if (!rejectionOf.has(String(r.uploadId))) rejectionOf.set(String(r.uploadId), r);
  // Reopened ones (2026-11-03): their latest reopen + how many times (one read per page)
  const reopens = await AppDataSource.getRepository(PoReopen).find({ where: { uploadId: In(uploads.map((u) => u.id)) }, order: { id: 'DESC' } });
  const reopenOf = new Map<string, { latest: PoReopen; times: number }>();
  for (const r of reopens) {
    const e = reopenOf.get(String(r.uploadId));
    if (e) e.times++;
    else reopenOf.set(String(r.uploadId), { latest: r, times: 1 });
  }

  const userIds = [...new Set([
    ...uploads.flatMap((u) => [u.csvDownloadedBy, u.uniwareUploadedBy]),
    ...[...rejectionOf.values()].map((r) => r.decidedBy),
  ].filter((v): v is number => v !== null))];
  // Processed: each PO's verification state, worked out here (no separate call with every id from the screen)
  const verifyOf = new Map(
    query.status === UPLOAD_STATUS.COMPLETED ? (await verifyStatesOf(uploads)).items.map(({ uploadId, ...v }) => [uploadId, v] as const) : [],
  );
  const people = userIds.length ? await AppDataSource.getRepository(User).findBy({ id: In(userIds) }) : [];
  const names = new Map(people.map((x) => [x.id, x.name] as const));
  const emails = new Map(people.map((x) => [x.id, x.email] as const));
  const who = (id: number | null) => (id === null ? null : names.get(id) ?? null);

  const items = uploads.map((u): PoReviewListItem => {
    const po = u.purchaseOrder;
    const totals = u.poUid ? linesByPo.get(String(u.poUid)) : undefined;
    const issues = openIssues.filter((i) => String(i.uploadId) === String(u.id));
    return {
      uploadId: String(u.id),
      poNumber: u.poNumber,
      channel: u.channel,
      status: u.status,
      ocrStatus: u.ocrStatus,
      source: u.source,
      subject: u.emailSubject,
      fileName: u.fileName,
      poDate: po?.poDate ? String(po.poDate) : u.poDate ? String(u.poDate) : null,
      receivedAt: iso(u.emailReceivedAt ?? u.createdAt),
      completedAt: iso(u.completedAt),
      processedAt: iso(u.completedAt ?? u.ocrFinishedAt ?? u.createdAt),
      brand: po?.brandName ?? null,
      saleOrderCode: po?.orderNo1 ?? null,
      // Before the PO is saved, the line count comes from the OCR summary.
      lines: totals ? Number(totals.lines) : num(u.ocrResult?.lines),
      units: po?.totalUnits ?? null,
      poValue: totals ? num(totals.poValue) : null,
      openIssues: issues.reduce((s, i) => s + Number(i.count), 0),
      issueTypes: issues.map((i) => i.issueType),
      csvDownloadedAt: iso(u.csvDownloadedAt),
      csvDownloadedBy: who(u.csvDownloadedBy),
      uniwareUploadedAt: iso(u.uniwareUploadedAt),
      uniwareUploadedBy: who(u.uniwareUploadedBy),
      failure: failureOf(u),
      rejection: rejectionFor(u, rejectionOf.get(String(u.id)), who, (id) => (id === null ? null : emails.get(id) ?? null)),
      reopened: reopenedFor(reopenOf.get(String(u.id))),
      verify: verifyOf.get(String(u.id)) ?? null,
    };
  });
  return { items, total };
};

// ---- GET /po-review/:uploadId ---------------------------------------------------------------------------------

export interface PoReviewLocation {
  detailsChannelId: string;
  locationCode: string | null;
  customerCode: string | null;
  facilityCode: string | null;
  address: string | null;
  pincode: string | null;
}

export interface PoReviewLine {
  lineNo: Num;
  channelSkuCode: string;
  ean: string;
  description: string;
  qty: Num;
  freeQty: Num;
  poMrp: Num;
  poUnitPrice: Num;
  poLineValue: Num;
  /**
   * The line's values AS READ from the PO (processed.json, 2026-11-05): what the review panel finds on the PO when a
   * value is clicked (poUnitPrice / poLineValue are worked out with tax, so a PO priced before tax does not print them).
   */
  printed: { unitCost: Num; landingRate: Num; lineTotal: Num };
  /** Ours, from the master ("" when the SKU is not mapped). */
  pepCode: string;
  /** The code the sale order is punched with: the _S code of a combo when our master has it, else pepCode. */
  punchCode: string;
  skuName: string;
  ourMrp: Num;
  ourRate: Num;
}

export interface PoReviewIssue {
  issueId: string;
  type: IssueType;
  field: string | null;
  lineNo: number | null;
  details: string | null;
  originalValues: Record<string, unknown> | null;
  status: string;
  /** OTHER, PO_EXPIRED and TOTAL_MISMATCH can be accepted (not a gap in our master: no rate / GST, isAcceptableIssue); the rest must be corrected or the PO rejected. */
  canAccept: boolean;
}

export interface PoReviewDetail {
  upload: {
    uploadId: string;
    status: UploadStatus;
    channel: string | null;
    source: string;
    fileName: string;
    emailFrom: string | null;
    emailSubject: string | null;
    receivedAt: string | null;
  };
  po: {
    poNumber: string;
    poDate: string;
    expiryDate: string;
    poType: string;
    revised: boolean;
    deliveryFacility: string;
    shippingAddress: string;
    pincode: string;
    deliveryGstin: string;
    totalQty: Num;
    poValue: Num;
    netAmount: Num;
  };
  /** The delivery location validation matched, or null. */
  location: PoReviewLocation | null;
  /** For a location issue: the channel's locations with the PO's pincode (or all of them when none has it). */
  locationCandidates: PoReviewLocation[];
  lines: PoReviewLine[];
  /** PO value with tax, the same at our rates, and the difference ("" when a line could not be priced). */
  totals: { poValue: Num; ourValue: Num; difference: Num };
  /** Open issues first, then the closed ones (approved / rejected) for history. */
  issues: PoReviewIssue[];
  /** processed.json warnings (values the OCR could not read cleanly). */
  warnings: PoWarning[];
  /** The channel's SKUs a line can be mapped to (master_channel_skus, one per pep_code). */
  skuOptions: PoReviewSkuOption[];
  /**
   * The latest approval round of this PO (po_review_submissions), or null: lets In Review show why a PO came back
   * (returned by the system / earlier rounds) and the Approvals page who submitted it.
   */
  lastSubmission: { id: string; type: string; status: string; submittedBy: string | null; submittedAt: string; decidedBy: string | null; decidedAt: string | null; remark: string | null } | null;
  /** Short-lived https links (PO_REVIEW_LINK_MINUTES); null when the file is not in S3. */
  files: {
    poFile: string | null;
    /** The same file as an attachment, so the browser saves it instead of opening it. */
    poFileDownload: string | null;
    poFileType: string | null;
    processedJson: string | null;
    uniwareCsv: string | null;
  };
}

export interface PoReviewSkuOption {
  pepCode: string;
  skuName: string | null;
  channelSkuCode: string | null;
  mrp: number | null;
  rate: number | null;
}

/** A download link for an s3:// URL, or null when there is none. */
const link = async (s3Url: unknown, disposition: 'inline' | 'attachment' = 'inline'): Promise<string | null> =>
  typeof s3Url === 'string' && s3Url.startsWith('s3://') ? s3DownloadLink(s3Url, PO_REVIEW_LINK_MINUTES, disposition) : null;

const toLocation = (d: DetailsChannel): PoReviewLocation => ({
  detailsChannelId: String(d.id),
  locationCode: d.channelLocationCode,
  customerCode: d.uniwareCustomerCode,
  facilityCode: d.facilityCode,
  address: d.finalShippingAddress,
  pincode: d.consigneePinCode ?? d.buyerPinCode,
});

/**
 * One PO for the review panel. processed.json is read from S3 (never local disk); validation runs again, read-only,
 * to give our SKU, MRP and rate next to each line; issues come from po_issues (what the reviewer must act on).
 */
export const getPoReview = async (uploadId: string): Promise<PoReviewDetail> => {
  const upload = await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId });
  if (!upload) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);

  const processedUrl = upload.ocrResult?.processed_json;
  // a panel (what a person looks at): processed.json + the channel's master data from the shared cache (2026-11-10)
  const po = typeof processedUrl === 'string' ? await readS3JsonCached<ProcessedPo>(processedUrl) : undefined;
  if (!po) throw appError(ERROR_CODES.PROCESSED_JSON_MISSING, uploadId);

  const master = await panelMasterFor(AppDataSource, po.channel_name as ChannelName);
  const validation = await validatePo(po, master);

  const issueRows = await AppDataSource.getRepository(PoIssue).find({ where: { uploadId }, order: { id: 'ASC' } });
  const issues = issueRows
    .map((i): PoReviewIssue => ({
      issueId: String(i.id),
      type: i.issueType,
      field: i.fieldName,
      lineNo: i.lineNo,
      details: i.details,
      originalValues: i.originalValues,
      status: i.status,
      canAccept: isAcceptableIssue(i.issueType, i.fieldName),
    }))
    .sort((a, b) => Number(b.status === ISSUE_STATUS.OPEN) - Number(a.status === ISSUE_STATUS.OPEN));

  const locationIssue = issueRows.some((i) => i.status === ISSUE_STATUS.OPEN && i.issueType === ISSUE_TYPE.LOCATION_NOT_MAPPED);
  const channelLocations = master?.locations ?? [];
  const samePincode = channelLocations.filter(
    (d) => matchKey(po.delivery_pincode) !== '' && [d.consigneePinCode, d.buyerPinCode].some((p) => matchKey(p) === matchKey(po.delivery_pincode)),
  );
  const matched = validation.location
    ? channelLocations.find((d) => d.channelLocationCode === validation.location!.locationCode && d.uniwareCustomerCode === validation.location!.customerCode)
    : undefined;

  const checked = new Map(validation.lines.map((l) => [String(l.lineNo), l]));
  const [last] = (await AppDataSource.query(
    `SELECT s.id, s.type, s.status, su.name sub, s.submitted_at, du.name decider, s.decided_at, s.decision_remark
       FROM ${TABLES.PO_REVIEW_SUBMISSIONS} s
       LEFT JOIN ${TABLES.USERS} su ON su.id = s.submitted_by LEFT JOIN ${TABLES.USERS} du ON du.id = s.decided_by
      WHERE s.upload_id = ? ORDER BY s.id DESC LIMIT 1`,
    [uploadId],
  )) as { id: string | number; type: string; status: string; sub: string | null; submitted_at: Date; decider: string | null; decided_at: Date | null; decision_remark: string | null }[];
  const lastSubmission = last
    ? {
        id: String(last.id), type: last.type, status: last.status, submittedBy: last.sub, submittedAt: new Date(last.submitted_at).toISOString(),
        decidedBy: last.decider, decidedAt: last.decided_at ? new Date(last.decided_at).toISOString() : null, remark: last.decision_remark,
      }
    : null;
  return {
    lastSubmission,
    upload: {
      uploadId: String(upload.id),
      status: upload.status,
      channel: upload.channel,
      source: upload.source,
      fileName: upload.fileName,
      emailFrom: upload.emailFrom,
      emailSubject: upload.emailSubject,
      receivedAt: iso(upload.emailReceivedAt ?? upload.createdAt),
    },
    po: {
      poNumber: po.po_number,
      poDate: po.po_date,
      expiryDate: po.expiry_date,
      poType: po.po_type,
      revised: po.revised,
      deliveryFacility: po.delivery_facility_code,
      shippingAddress: po['shipping address'],
      pincode: po.delivery_pincode,
      deliveryGstin: po.delivery_gstin,
      totalQty: po.total_qty,
      poValue: po.po_value,
      netAmount: po.net_amount,
    },
    location: matched ? toLocation(matched) : null,
    locationCandidates: locationIssue ? (samePincode.length ? samePincode : channelLocations).map(toLocation) : [],
    lines: po.line_items.map((l): PoReviewLine => {
      const v = checked.get(String(l.line_no));
      return {
        lineNo: l.line_no,
        channelSkuCode: l.channel_sku_code,
        ean: l.ean,
        description: l.description,
        qty: l.qty,
        freeQty: l.free_qty,
        poMrp: l.channel_mrp,
        poUnitPrice: v?.poUnitPrice ?? l.landing_rate,
        poLineValue: v?.poLineValue ?? l.line_total,
        printed: { unitCost: l.unit_cost, landingRate: l.landing_rate, lineTotal: l.line_total },
        pepCode: v?.pepCode ?? '',
        punchCode: v?.punchCode || v?.pepCode || '',
        skuName: v?.skuName ?? '',
        ourMrp: v?.ourMrp ?? '',
        ourRate: v?.ourRate ?? '',
      };
    }),
    totals: validation.totals,
    issues,
    warnings: po.warnings,
    skuOptions: [...(master?.skusByPep.values() ?? [])]
      .map((rows): PoReviewSkuOption => {
        const r = rows.find((x) => x.rateAfterMargin !== null) ?? rows[0];
        return { pepCode: r.pepCode, skuName: r.productName, channelSkuCode: r.channelCode, mrp: r.mrp, rate: r.rateAfterMargin };
      })
      .sort((a, b) => a.pepCode.localeCompare(b.pepCode)),
    files: {
      poFile: await link(upload.fileUrl),
      poFileDownload: await link(upload.fileUrl, 'attachment'),
      poFileType: upload.fileType,
      processedJson: await link(processedUrl),
      uniwareCsv: await link(upload.uniwareCsvUrl),
    },
  };
};

/**
 * The PO file itself (GET /po-review/:uploadId/file), read from S3 and passed on to the browser, for the panel's
 * page-by-page PDF viewer (the browser cannot read the S3 link directly without a CORS rule on the bucket).
 */
export const getPoFile = async (uploadId: string): Promise<NonNullable<Awaited<ReturnType<typeof openS3File>>>> => {
  const upload = await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId });
  if (!upload) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  const file = typeof upload.fileUrl === 'string' && upload.fileUrl.startsWith('s3://') ? await openS3File(upload.fileUrl) : undefined;
  if (!file) throw appError(ERROR_CODES.PO_FILE_MISSING, uploadId);
  return file;
};
