import {
  CHANNEL_LOCATION_MATCH,
  CHANNEL_TOLERANCES,
  ChannelName,
  IST_OFFSET_MS,
  ISSUE_FIELDS,
  ISSUE_TYPE,
  LOCATION_MATCH,
  round2,
  VALIDATION_STATUS,
  VALIDATION_TEXT,
  validationIssue,
  ValidationIssue,
  ValidationStatus,
} from '../../constants';
import { DetailsChannel } from '../../entities';
import { Num, ProcessedLine, ProcessedPo } from '../po-processing/common/processed-po';
import { ChannelMasterData, matchKey } from './master-data';

/*
 * Validation of one processed.json against our master data (read-only). It runs every check and lists every issue,
 * so a reviewer sees all problems of a PO at once; any issue -> NEEDS_REVIEW, and nothing is saved.
 * It also resolves what the save step and the Uniware CSV need (location codes, pep_code, our MRP and rate per line).
 *
 * Prices are compared WITH tax: our rate_after_margin is MRP x (1 - margin) with tax (Zepto 599 x 0.69 = 413.31,
 * the Selling Price of the Uniware CSV). The PO's unit price with tax is its landing rate; channels that send only
 * the price before tax (Purplle) get unit_cost x (1 + GST %), the GST from the PO or else master_skus.
 */

/** The delivery location found in details_channels: the codes the Uniware CSV and the PO row need. */
export interface ValidatedLocation {
  /** details_channels.id -> master_purchase_orders.locationId */
  locationId: string;
  /** details_channels.channel_location_code -> master_purchase_orders.location */
  locationCode: string;
  /** -> Uniware Customer Code, master_purchase_orders.customerCode */
  customerCode: string;
  /** -> Uniware Facility Code, master_purchase_orders.facility: details_channels.facility_code EXACTLY as stored
   *  (case matters: MUM_WAREHOUSE2 is the main warehouse, MUM_Warehouse2 its child; user, 2026-10-14). */
  facilityCode: string;
  /** master_facilities.id -> master_purchase_orders.facilityId; null = the facility is not in master_facilities yet. */
  facilityId: number | null;
  /** -> Uniware Channel (e.g. ZEPTO_B2B) */
  uniwareChannel: string;
  matchedBy: 'code' | 'pincode' | 'reviewer';
}

/** A reviewer's choices on resubmit (po-review): they replace the automatic match for this PO only. */
export interface ReviewOverrides {
  /** details_channels.id of the delivery location the reviewer picked. */
  locationId?: string;
  /** pep_code the reviewer mapped a line to, by String(line_no). */
  pepCodeByLine?: Map<string, string>;
}

export interface ValidatedLine {
  lineNo: Num;
  channelSkuCode: string;
  /** "" when the SKU is not mapped. */
  pepCode: string;
  /** Our product name (master), for details_purchase_orders.skuName. */
  skuName: string;
  brandName: string;
  qty: Num;
  /** qty minus free units: the units the channel pays for. */
  chargedQty: Num;
  ourMrp: Num;
  poMrp: Num;
  /** Our rate_after_margin (with tax) = Uniware Selling Price. */
  ourRate: Num;
  /** PO unit price with tax. */
  poUnitPrice: Num;
  /** PO line value with tax. */
  poLineValue: Num;
}

export interface ValidationResult {
  channel: ChannelName;
  /** master_channels.display_name, the value of master_purchase_orders.channel. */
  channelDisplayName: string;
  poNumber: string;
  status: ValidationStatus;
  issues: ValidationIssue[];
  location: ValidatedLocation | null;
  lines: ValidatedLine[];
  /** PO value with tax, the same by our rates, and the difference; "" when not every line could be priced. */
  totals: { poValue: Num; ourValue: Num; difference: Num };
  validatedAt: string;
}

const num = (v: Num | string | null | undefined): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const orEmpty = (v: number | null): Num => (v === null ? '' : round2(v));

/** Today in IST as YYYY-MM-DD (PO dates are Indian dates). */
export const todayIst = (now = new Date()): string => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const findLocation = (po: ProcessedPo, master: ChannelMasterData, issues: ValidationIssue[], picked?: string): ValidatedLocation | null => {
  const code = matchKey(po.delivery_facility_code);
  const pin = matchKey(po.delivery_pincode);
  const byCode = CHANNEL_LOCATION_MATCH[po.channel_name as ChannelName] === LOCATION_MATCH.CODE_THEN_PINCODE;

  let rows: DetailsChannel[] = [];
  let matchedBy: ValidatedLocation['matchedBy'] = 'code';
  let by = '';
  if (picked) {
    rows = master.locations.filter((l) => String(l.id) === picked);
    matchedBy = 'reviewer';
    by = `the reviewer's choice ${picked}`;
  } else if (byCode && code) {
    rows = master.locations.filter((l) => matchKey(l.channelLocationCode) === code);
    by = `facility code "${po.delivery_facility_code}"`;
  }
  if (!picked && !rows.length && pin) {
    rows = master.locations.filter((l) => matchKey(l.consigneePinCode) === pin);
    matchedBy = 'pincode';
    by = `${by ? `${by} or ` : ''}pincode ${po.delivery_pincode}`;
  }

  const issue = (detail: string) =>
    issues.push(validationIssue(ISSUE_TYPE.LOCATION_NOT_MAPPED, { field: ISSUE_FIELDS.DELIVERY_LOCATION, actual: po.delivery_facility_code || po.delivery_pincode }, detail));
  if (!picked && !code && !pin) return issue(VALIDATION_TEXT.NO_LOCATION_KEY), null;
  if (!rows.length) return issue(VALIDATION_TEXT.LOCATION_NONE(by)), null;
  if (rows.length > 1) {
    const codes = rows.map((r) => r.channelLocationCode ?? r.uniwareCustomerCode ?? r.id).join(', ');
    return issue(VALIDATION_TEXT.LOCATION_MANY(by, rows.length, codes)), null;
  }

  const [row] = rows;
  // The Uniware facility is the location's own code, never a master spelling; the link is kept only when it points
  // at exactly that code (else the exact lookup decides).
  const facilityCode = row.facilityCode?.trim() ?? '';
  const linked = row.facilityId !== null ? master.facilities.byId.get(row.facilityId) : undefined;
  const facility = linked && linked.code === facilityCode ? linked : master.facilities.find(facilityCode);
  const missing = [
    !row.uniwareCustomerCode?.trim() && 'uniware_customer_code',
    !facilityCode && 'facility_code',
    !row.channelCode?.trim() && 'channel_code',
  ].filter(Boolean);
  if (missing.length) issue(VALIDATION_TEXT.LOCATION_INCOMPLETE(row.channelLocationCode ?? row.id, missing.join(', ')));
  return {
    locationId: String(row.id),
    locationCode: row.channelLocationCode?.trim() ?? '',
    customerCode: row.uniwareCustomerCode?.trim() ?? '',
    facilityCode,
    facilityId: facility?.id ?? null,
    uniwareChannel: row.channelCode?.trim() ?? '',
    matchedBy,
  };
};

const validateLine = (
  line: ProcessedLine,
  master: ChannelMasterData,
  channel: ChannelName,
  issues: ValidationIssue[],
  pickedPep?: string,
): ValidatedLine => {
  const tolerance = CHANNEL_TOLERANCES[channel];
  const where = `line ${line.line_no} (${line.channel_sku_code || '-'})`;
  const lineNo = line.line_no;
  const add = (issue: ValidationIssue) => issues.push(issue);

  const qty = num(line.qty);
  const chargedQty = qty === null ? null : qty - (num(line.free_qty) ?? 0);
  if (qty === null) add(validationIssue(ISSUE_TYPE.QTY_MISMATCH, { field: ISSUE_FIELDS.QTY, lineNo }, where, VALIDATION_TEXT.QTY_MISSING));

  const out: ValidatedLine = {
    lineNo,
    channelSkuCode: line.channel_sku_code,
    pepCode: '',
    skuName: '',
    brandName: '',
    qty: orEmpty(qty),
    chargedQty: orEmpty(chargedQty),
    ourMrp: '',
    poMrp: orEmpty(num(line.channel_mrp)),
    ourRate: '',
    poUnitPrice: '',
    poLineValue: '',
  };

  // SKU: exactly one master_channel_skus row for this channel + channel_code (user, 2026-10-08).
  // A reviewer's mapping replaces the lookup: the channel's row for that pep_code (one is enough, they share the rate).
  const byPep = pickedPep ? (master.skusByPep.get(matchKey(pickedPep)) ?? []) : [];
  const chosen = byPep.find((r) => r.rateAfterMargin !== null) ?? byPep[0];
  const candidates = pickedPep ? (chosen ? [chosen] : []) : (master.skusByCode.get(matchKey(line.channel_sku_code)) ?? []);
  const skuIssue = (detail: string) =>
    add(validationIssue(ISSUE_TYPE.SKU_NOT_MAPPED, { field: ISSUE_FIELDS.CHANNEL_SKU_CODE, lineNo, actual: line.channel_sku_code }, where, detail));
  if (pickedPep && !candidates.length) skuIssue(VALIDATION_TEXT.SKU_NONE(pickedPep));
  else if (!pickedPep && !line.channel_sku_code.trim()) skuIssue(VALIDATION_TEXT.SKU_CODE_EMPTY);
  else if (!candidates.length) skuIssue(VALIDATION_TEXT.SKU_NONE(line.channel_sku_code));
  else if (candidates.length > 1) skuIssue(VALIDATION_TEXT.SKU_MANY(line.channel_sku_code, candidates.map((c) => c.pepCode).join(', ')));
  const mapped = candidates.length === 1 ? candidates[0] : null;
  const sku = mapped ? master.skus.get(matchKey(mapped.pepCode)) : undefined;

  // The PO's unit price and line value, with tax.
  const landing = num(line.landing_rate);
  const unitCost = num(line.unit_cost);
  const lineTotal = num(line.line_total);
  const gst = num(line.gst) ?? num(sku?.gstTaxType);
  let poUnit: number | null = null;
  let poValue: number | null = null;
  if (landing !== null) {
    poUnit = landing;
    poValue = lineTotal ?? (chargedQty === null ? null : chargedQty * landing);
  } else if (unitCost !== null) {
    // An unmapped SKU has no master GST; its SKU_NOT_MAPPED issue already explains the missing price.
    if (gst === null) {
      if (mapped) add(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.GST, lineNo }, `${where}: ${VALIDATION_TEXT.GST_MISSING(mapped.pepCode)}`));
    } else {
      poUnit = unitCost * (1 + gst / 100);
      poValue = lineTotal !== null ? lineTotal * (1 + gst / 100) : chargedQty === null ? null : chargedQty * poUnit;
    }
  } else add(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.UNIT_PRICE, lineNo }, `${where}: ${VALIDATION_TEXT.PRICE_MISSING}`));
  out.poUnitPrice = orEmpty(poUnit);
  out.poLineValue = orEmpty(poValue);

  if (!mapped) return out;
  out.pepCode = mapped.pepCode;
  out.skuName = sku?.productName ?? mapped.productName ?? '';
  out.brandName = sku?.brandName ?? mapped.brandName ?? '';

  // MRP: the PO's vs ours (the channel's row, else master_skus).
  const ourMrp = mapped.mrp ?? sku?.mrp ?? null;
  const poMrp = num(line.channel_mrp);
  out.ourMrp = orEmpty(ourMrp);
  if (ourMrp !== null && poMrp !== null && Math.abs(round2(poMrp - ourMrp)) > tolerance.mrpPerSku) {
    add(validationIssue(ISSUE_TYPE.MRP_MISMATCH, { field: ISSUE_FIELDS.MRP, lineNo, expected: ourMrp, actual: poMrp }, where, poMrp, ourMrp, tolerance.mrpPerSku));
  }

  // Price: the PO's unit price vs our rate_after_margin.
  const rate = mapped.rateAfterMargin;
  out.ourRate = orEmpty(rate);
  if (rate === null) add(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.RATE, lineNo }, `${where}: ${VALIDATION_TEXT.SKU_NO_RATE(mapped.pepCode)}`));
  else if (poUnit !== null && Math.abs(round2(poUnit - rate)) > tolerance.pricePerSku) {
    add(validationIssue(ISSUE_TYPE.PRICE_MISMATCH, { field: ISSUE_FIELDS.UNIT_PRICE, lineNo, expected: rate, actual: round2(poUnit) }, where, round2(poUnit), rate, tolerance.pricePerSku));
  }
  return out;
};

/** Runs every check on one PO. `master` is null when the channel is not configured. */
export const validatePo = async (
  po: ProcessedPo,
  master: ChannelMasterData | null,
  now = new Date(),
  overrides: ReviewOverrides = {},
): Promise<ValidationResult> => {
  const channel = po.channel_name as ChannelName;
  const issues: ValidationIssue[] = [];
  const result = (location: ValidatedLocation | null, lines: ValidatedLine[], totals: ValidationResult['totals']): ValidationResult => ({
    channel,
    channelDisplayName: master?.channel.displayName ?? '',
    poNumber: po.po_number,
    status: issues.length ? VALIDATION_STATUS.NEEDS_REVIEW : VALIDATION_STATUS.VALID,
    issues,
    location,
    lines,
    totals,
    validatedAt: now.toISOString(),
  });
  const noTotals = { poValue: '' as Num, ourValue: '' as Num, difference: '' as Num };

  if (!master) {
    issues.push(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.CHANNEL }, VALIDATION_TEXT.CHANNEL_NOT_CONFIGURED(po.channel_name)));
    return result(null, [], noTotals);
  }

  // OCR completeness: without a PO number or lines nothing else can be checked properly.
  if (!po.po_number) issues.push(validationIssue(ISSUE_TYPE.OCR_ISSUE, { field: ISSUE_FIELDS.PO_NUMBER }, VALIDATION_TEXT.OCR_NO_PO_NUMBER));
  if (!po.line_items.length) issues.push(validationIssue(ISSUE_TYPE.OCR_ISSUE, { field: ISSUE_FIELDS.LINE_ITEMS }, VALIDATION_TEXT.OCR_NO_LINES));

  // PO-level checks.
  if (po.needs_review) issues.push(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.PO_TYPE }, VALIDATION_TEXT.FOC_REVIEW((po.review_reasons ?? []).join(', '))));
  if (po.revised) issues.push(validationIssue(ISSUE_TYPE.OTHER, { field: ISSUE_FIELDS.REVISED }, VALIDATION_TEXT.REVISED(po.revision_of)));
  if (po.po_number && (await master.poExists(po.po_number))) {
    issues.push(validationIssue(ISSUE_TYPE.DUPLICATE_PO, { field: ISSUE_FIELDS.PO_NUMBER, actual: po.po_number }, master.channel.displayName, po.po_number));
  }
  const today = todayIst(now);
  if (po.expiry_date && po.expiry_date < today) {
    issues.push(validationIssue(ISSUE_TYPE.PO_EXPIRED, { field: ISSUE_FIELDS.EXPIRY_DATE, actual: po.expiry_date }, po.expiry_date, today));
  }
  const location = findLocation(po, master, issues, overrides.locationId);

  // Line checks.
  const lines = po.line_items.map((l) => validateLine(l, master, channel, issues, overrides.pepCodeByLine?.get(String(l.line_no))));

  // PO total: only when every line is mapped and priced; otherwise the line issues already explain why.
  const tolerance = CHANNEL_TOLERANCES[channel];
  const priced = lines.filter((l) => l.poLineValue !== '' && l.ourRate !== '' && l.chargedQty !== '');
  if (priced.length !== lines.length) {
    return result(location, lines, noTotals);
  }
  const poValue = round2(priced.reduce((s, l) => s + (l.poLineValue as number), 0));
  const ourValue = round2(priced.reduce((s, l) => s + (l.chargedQty as number) * (l.ourRate as number), 0));
  const difference = round2(poValue - ourValue);
  if (Math.abs(difference) > tolerance.poTotal) {
    issues.push(validationIssue(ISSUE_TYPE.TOTAL_MISMATCH, { field: ISSUE_FIELDS.PO_VALUE, expected: ourValue, actual: poValue }, poValue, ourValue, tolerance.poTotal));
  }
  return result(location, lines, { poValue, ourValue, difference });
};
