import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCEPTABLE_ISSUE_TYPES,
  ChannelName,
  ERROR_CODES,
  IST_OFFSET_MS,
  ISSUE_STATUS,
  ISSUE_TYPE,
  IssueType,
  PO_REVIEW_LINK_MINUTES,
  PoWarning,
  UPLOAD_STATUS,
  UploadStatus,
} from '../../constants';
import { DetailsChannel, DetailsPurchaseOrder, PoIssue, PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { openS3File, readS3Json, s3DownloadLink } from '../email-intake/s3-mirror.service';
import { Num, ProcessedPo } from '../po-processing/common/processed-po';
import { MasterDataReader, matchKey } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';

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
  fileName: string;
  poDate: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  brand: string | null;
  saleOrderCode: string | null;
  lines: number | null;
  units: number | null;
  poValue: number | null;
  openIssues: number;
  issueTypes: string[];
}

/** Start of an Indian-time calendar day, as the UTC instant the DB stores (timezone 'Z'). */
const istDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const listPoReview = async (query: PoReviewListQuery): Promise<{ items: PoReviewListItem[]; total: number }> => {
  // Completed POs are listed and filtered by when they finished, newest first; the rest by when they arrived,
  // oldest first (the PO waiting longest for a reviewer is on top).
  const dateColumn = query.status === UPLOAD_STATUS.COMPLETED ? 'u.completedAt' : 'u.createdAt';
  const order = query.status === UPLOAD_STATUS.COMPLETED ? 'DESC' : 'ASC';

  const qb = AppDataSource.getRepository(PoUpload)
    .createQueryBuilder('u')
    .leftJoinAndSelect('u.purchaseOrder', 'po')
    .where('u.status = :status', { status: query.status });
  if (query.channel) qb.andWhere('u.channel = :channel', { channel: query.channel });
  if (query.q) qb.andWhere('(u.poNumber LIKE :q OR u.fileName LIKE :q)', { q: `%${query.q}%` });
  if (query.from) qb.andWhere(`${dateColumn} >= :from`, { from: istDayStart(query.from) });
  if (query.to) qb.andWhere(`${dateColumn} < :toEnd`, { toEnd: new Date(istDayStart(query.to).getTime() + DAY_MS) });

  const [uploads, total] = await qb
    .orderBy(dateColumn, order)
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
      fileName: u.fileName,
      poDate: po?.poDate ? String(po.poDate) : null,
      receivedAt: iso(u.emailReceivedAt ?? u.createdAt),
      completedAt: iso(u.completedAt),
      brand: po?.brandName ?? null,
      saleOrderCode: po?.orderNo1 ?? null,
      // Before the PO is saved, the line count comes from the OCR summary.
      lines: totals ? Number(totals.lines) : num(u.ocrResult?.lines),
      units: po?.totalUnits ?? null,
      poValue: totals ? num(totals.poValue) : null,
      openIssues: issues.reduce((s, i) => s + Number(i.count), 0),
      issueTypes: issues.map((i) => i.issueType),
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
  /** Ours, from the master ("" when the SKU is not mapped). */
  pepCode: string;
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
  /** Only OTHER and PO_EXPIRED can be accepted as they are; the rest must be corrected or the PO rejected. */
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
  const po = typeof processedUrl === 'string' ? await readS3Json<ProcessedPo>(processedUrl) : undefined;
  if (!po) throw appError(ERROR_CODES.PROCESSED_JSON_MISSING, uploadId);

  const master = await new MasterDataReader(AppDataSource).forChannel(po.channel_name as ChannelName);
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
      canAccept: ACCEPTABLE_ISSUE_TYPES.includes(i.issueType),
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
  return {
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
        pepCode: v?.pepCode ?? '',
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
