import { CHANNELS, ChannelName } from './channels';
import { ISSUE_TYPE, IssueType } from './db';

/*
 * Validation of a processed.json against our master data (before the PO is saved and its sale order is made).
 * Every value that may change per channel is here: the tolerances, the channel's id in master_channels and how its
 * delivery location is matched. Issue messages are at the end.
 */

/** Allowed differences in rupees. A difference above the limit is an issue and the PO goes to review. */
export interface Tolerance {
  /** PO MRP vs our MRP, per SKU (per unit). */
  mrpPerSku: number;
  /** PO unit price (with tax) vs our rate_after_margin, per SKU (per unit). */
  pricePerSku: number;
  /** PO value (with tax) vs the sum of qty x rate_after_margin, for the whole PO: at least this many rupees... */
  poTotal: number;
  /** ...or this percent of our value when that is more (paisa rounding grows with the quantities). */
  poTotalPercent: number;
}

/**
 * The same for every channel. 2026-10-29 (user): Rs 1 per SKU on MRP and on the unit price (was Rs 2); PO total
 * 0.02% of the value, at least Rs 10 (was a flat Rs 10: Reliance 5000501376 = -19.52 on 15 lakh, only paisa rounding).
 */
const DEFAULT_TOLERANCE: Tolerance = { mrpPerSku: 1, pricePerSku: 1, poTotal: 10, poTotalPercent: 0.02 };

/** The rupees a PO's total may differ by: poTotal, or poTotalPercent of our value when that is more. */
export const poTotalAllowed = (t: Tolerance, ourValue: number): number =>
  Math.max(t.poTotal, Math.round(Math.abs(ourValue) * t.poTotalPercent) / 100);

/** Change a channel's limits here. */
export const CHANNEL_TOLERANCES: Record<ChannelName, Tolerance> = {
  [CHANNELS.BIGBASKET]: DEFAULT_TOLERANCE,
  [CHANNELS.ZEPTO]: DEFAULT_TOLERANCE,
  [CHANNELS.FIRSTCRY]: DEFAULT_TOLERANCE,
  [CHANNELS.BLINKIT]: DEFAULT_TOLERANCE,
  [CHANNELS.RELIANCE]: DEFAULT_TOLERANCE,
  [CHANNELS.SCOOTSY]: DEFAULT_TOLERANCE,
  [CHANNELS.PURPLLE]: DEFAULT_TOLERANCE,
  [CHANNELS.AMAZON]: DEFAULT_TOLERANCE,
  [CHANNELS.TATA1MG]: DEFAULT_TOLERANCE,
  [CHANNELS.NYKAA]: DEFAULT_TOLERANCE,
  [CHANNELS.FLIPKART]: DEFAULT_TOLERANCE,
};

/**
 * Our channel -> master_channels.id. Matching is always by id, never by name (the names differ between tables).
 * Purplle's POs are SOR (Purplle SOR, id 18; Purplle SDR is 19).
 */
export const CHANNEL_MASTER_IDS: Record<ChannelName, number> = {
  [CHANNELS.BLINKIT]: 1,
  [CHANNELS.ZEPTO]: 2,
  [CHANNELS.BIGBASKET]: 3,
  [CHANNELS.FIRSTCRY]: 10,
  [CHANNELS.RELIANCE]: 12,
  [CHANNELS.PURPLLE]: 18,
  [CHANNELS.SCOOTSY]: 20,
  [CHANNELS.AMAZON]: 9,
  [CHANNELS.TATA1MG]: 11,
  [CHANNELS.NYKAA]: 6,
  [CHANNELS.FLIPKART]: 8,
};

/**
 * How the PO's delivery location is found in details_channels:
 *   code_then_pincode: delivery_facility_code = channel_location_code (case-insensitive); if no row, delivery_pincode =
 *                      consignee_pin_code
 *   pincode:           delivery_pincode = consignee_pin_code only (Purplle: its plant codes W502 ... are not in the master)
 * Exactly one row must match; none or several -> review.
 */
export const LOCATION_MATCH = { CODE_THEN_PINCODE: 'code_then_pincode', PINCODE: 'pincode' } as const;
export type LocationMatch = (typeof LOCATION_MATCH)[keyof typeof LOCATION_MATCH];

export const CHANNEL_LOCATION_MATCH: Record<ChannelName, LocationMatch> = {
  [CHANNELS.BIGBASKET]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.ZEPTO]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.FIRSTCRY]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.BLINKIT]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.RELIANCE]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.SCOOTSY]: LOCATION_MATCH.CODE_THEN_PINCODE,
  [CHANNELS.PURPLLE]: LOCATION_MATCH.PINCODE,
  /** The FC code (HYD8, BOM7 ...) = channel_location_code. */
  [CHANNELS.AMAZON]: LOCATION_MATCH.CODE_THEN_PINCODE,
  /** The handler turns the PO's StoreCode (1MG_MKL ...) into channel_location_code (Bangalore ...). */
  [CHANNELS.TATA1MG]: LOCATION_MATCH.CODE_THEN_PINCODE,
  /** Delivery Location ("Chennai Warehouse", "Nykaa Warehouse DEL1" ...) = channel_location_code. */
  [CHANNELS.NYKAA]: LOCATION_MATCH.CODE_THEN_PINCODE,
  /** The consignment's Warehouse Id (ahm_khe_wh_nl_01nl ...) = channel_location_code. */
  [CHANNELS.FLIPKART]: LOCATION_MATCH.CODE_THEN_PINCODE,
};

/** Result of validating one PO. */
export const VALIDATION_STATUS = {
  /** Every check passed: the PO can be saved and its sale order made. */
  VALID: 'valid',
  /** At least one issue: the PO goes to review, nothing is saved. */
  NEEDS_REVIEW: 'needs_review',
} as const;
export type ValidationStatus = (typeof VALIDATION_STATUS)[keyof typeof VALIDATION_STATUS];

/** po_issues.field_name: the PO field an issue is about. */
export const ISSUE_FIELDS = {
  CHANNEL: 'channel',
  CHANNEL_SKU_CODE: 'channel_sku_code',
  MRP: 'mrp',
  UNIT_PRICE: 'unit_price',
  RATE: 'rate_after_margin',
  GST: 'gst',
  QTY: 'qty',
  PO_VALUE: 'po_value',
  PO_NUMBER: 'po_number',
  LINE_ITEMS: 'line_items',
  DELIVERY_LOCATION: 'delivery_location',
  EXPIRY_DATE: 'expiry_date',
  PO_TYPE: 'po_type',
  REVISED: 'revised',
  /** A processed PO sent back to review by the person verifying it (constants/po-verify.ts). */
  VERIFICATION: 'verification',
} as const;
export type IssueField = (typeof ISSUE_FIELDS)[keyof typeof ISSUE_FIELDS];

/**
 * Issue types a reviewer may ACCEPT as they are for one PO (user, 2026-10-08): rule issues with nothing to correct
 * (FOC / revised = OTHER, expired). Data issues (SKU, MRP, price, total, location, qty, OCR) must be corrected or the PO
 * rejected; DUPLICATE_PO can only be rejected.
 */
export const ACCEPTABLE_ISSUE_TYPES: readonly IssueType[] = [ISSUE_TYPE.OTHER, ISSUE_TYPE.PO_EXPIRED];

/** Rupee amounts are compared after rounding to paise, so 0.004 of float noise is never an issue. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

const rs = (n: number): string => n.toFixed(2);
const signed = (n: number): string => `${n > 0 ? '+' : ''}${rs(n)}`;

/** Issue messages, by po_issues.issue_type. `where` is "PO" or "line <n> (<channel SKU code>)". */
const ISSUE_MESSAGES = {
  [ISSUE_TYPE.DUPLICATE_PO]: (channel: string, poNumber: string) =>
    `PO ${poNumber} of ${channel} is already in master_purchase_orders`,
  [ISSUE_TYPE.LOCATION_NOT_MAPPED]: (detail: string) => `delivery location: ${detail}`,
  [ISSUE_TYPE.SKU_NOT_MAPPED]: (where: string, detail: string) => `${where}: ${detail}`,
  [ISSUE_TYPE.MRP_MISMATCH]: (where: string, po: number, ours: number, tolerance: number) =>
    `${where}: MRP ${rs(po)} on the PO vs ${rs(ours)} in our master (${signed(po - ours)}, allowed +/-${rs(tolerance)})`,
  [ISSUE_TYPE.PRICE_MISMATCH]: (where: string, po: number, ours: number, tolerance: number) =>
    `${where}: unit price ${rs(po)} (with tax) on the PO vs our rate ${rs(ours)} (${signed(po - ours)}, allowed +/-${rs(tolerance)})`,
  [ISSUE_TYPE.TOTAL_MISMATCH]: (po: number, ours: number, tolerance: number) =>
    `PO value ${rs(po)} (with tax) vs ${rs(ours)} by our rates (${signed(po - ours)}, allowed +/-${rs(tolerance)})`,
  [ISSUE_TYPE.QTY_MISMATCH]: (where: string, detail: string) => `${where}: ${detail}`,
  [ISSUE_TYPE.PO_EXPIRED]: (expiry: string, today: string) => `PO expired on ${expiry} (today ${today})`,
  [ISSUE_TYPE.OCR_ISSUE]: (detail: string) => `OCR output incomplete: ${detail}`,
  [ISSUE_TYPE.OTHER]: (detail: string) => detail,
} satisfies Partial<Record<IssueType, (...args: never[]) => string>>;

type IssueMessages = typeof ISSUE_MESSAGES;
export type ValidationIssueType = keyof IssueMessages;

/** One problem found by validation; becomes a po_issues row when the review queue is built. */
export interface ValidationIssue {
  type: ValidationIssueType;
  message: string;
  /** po_issues.field_name. */
  field: IssueField;
  /** processed.json line_no, for line issues. */
  lineNo?: number | '';
  /** Our value and the PO's, for the reviewer (e.g. 599 and 649). */
  expected?: number | string;
  actual?: number | string;
}

export const validationIssue = <T extends ValidationIssueType>(
  type: T,
  extra: Omit<ValidationIssue, 'type' | 'message'>,
  ...args: Parameters<IssueMessages[T]>
): ValidationIssue => ({
  type,
  message: (ISSUE_MESSAGES[type] as (...a: Parameters<IssueMessages[T]>) => string)(...args),
  ...extra,
});

/** Fixed texts used in the issue messages above (detail arguments). */
export const VALIDATION_TEXT = {
  CHANNEL_NOT_CONFIGURED: (channel: string) => `channel "${channel}" has no master_channels id in constants/validation.ts`,
  NO_LOCATION_KEY: 'the PO has neither a delivery facility code nor a delivery pincode',
  LOCATION_NONE: (by: string) => `no details_channels row matches ${by}`,
  LOCATION_MANY: (by: string, n: number, codes: string) => `${n} details_channels rows match ${by} (${codes}); exactly one is needed`,
  LOCATION_INCOMPLETE: (code: string, missing: string) => `details_channels row "${code}" has no ${missing}`,
  SKU_CODE_EMPTY: 'the PO line has no channel SKU code',
  SKU_NONE: (code: string) => `channel SKU code ${code} is not in master_channel_skus for this channel`,
  /**
   * The PO itself names our SKU (Nykaa's Vendor SKU Code, 2026-10-27): told to the reviewer, never mapped by itself. Picking
   * it in review is not enough: validation needs this channel's row for it (its rate).
   */
  SKU_NONE_PO_GIVES_PEP: (code: string, pepCode: string) =>
    `channel SKU code ${code} is not in master_channel_skus for this channel; the PO says it is our SKU ${pepCode} (in master_skus): add ${code} -> ${pepCode} with its rate to this channel's SKUs, then Re-check`,
  SKU_MANY: (code: string, pepCodes: string) => `channel SKU code ${code} maps to several of our SKUs (${pepCodes})`,
  SKU_NO_RATE: (pepCode: string) => `our SKU ${pepCode} has no rate_after_margin in master_channel_skus`,
  /** Switched off on the Masters page (2026-10-28): the PO line or location goes to review. */
  SKU_INACTIVE: (pepCode: string) => `our SKU ${pepCode} is inactive in the PEP SKU master (switch it on, or map the line to another SKU)`,
  FACILITY_INACTIVE: (code: string, facility: string) => `location "${code}" is served by warehouse ${facility}, which is inactive in the Warehouses master`,
  QTY_MISSING: 'no quantity on the PO line',
  PRICE_MISSING: 'no unit price on the PO line (neither landing rate nor unit cost)',
  GST_MISSING: (pepCode: string) => `no GST rate for ${pepCode} (neither on the PO nor in master_skus)`,
  FOC_REVIEW: (reasons: string) => `marked for manual review by processing: ${reasons}`,
  REVISED: (revisionOf: string) => `revised PO${revisionOf ? ` of ${revisionOf}` : ''}: updating the earlier PO is not built yet`,
  OCR_NO_PO_NUMBER: 'no PO number was read',
  OCR_NO_LINES: 'no line items were read',
  /** po_issues.remark when a re-run no longer finds an open issue (e.g. the master data was fixed). */
  AUTO_CLOSED: 'no longer found by validation',
};
