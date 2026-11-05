import { CHANNELS, ChannelName } from './channels';
import { ISSUE_TYPE, IssueType } from './db';
import { MYNTRA_STR } from './channel-api';

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
  [CHANNELS.MYNTRA]: DEFAULT_TOLERANCE,
  [CHANNELS.AVENUE]: DEFAULT_TOLERANCE,
  [CHANNELS.FLIPKART_QCOM]: DEFAULT_TOLERANCE,
  [CHANNELS.GLUZO]: DEFAULT_TOLERANCE,
  [CHANNELS.SLIKK]: DEFAULT_TOLERANCE,
  [CHANNELS.POP_TECH]: DEFAULT_TOLERANCE,
  [CHANNELS.FIRST_CLUB]: DEFAULT_TOLERANCE,
  [CHANNELS.OCTAVOS]: DEFAULT_TOLERANCE,
  [CHANNELS.NOBLE_CHEMIST]: DEFAULT_TOLERANCE,
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
  /** master_channels "Myntra" (B2C, 208 SKU rows; checked 2026-11-02), not Myntra-OR (17, no SKUs). */
  [CHANNELS.MYNTRA]: 5,
  /** "Avenue E-Commerce" (DMart). */
  [CHANNELS.AVENUE]: 15,
  /** "Flipkart Qcom" (not "Flipkart", id 8: its rates differ). */
  [CHANNELS.FLIPKART_QCOM]: 16,
  /** "GLUZO". */
  [CHANNELS.GLUZO]: 24,
  /** "SLIKK". */
  [CHANNELS.SLIKK]: 40,
  /** "POP TECH". */
  [CHANNELS.POP_TECH]: 37,
  /** "FIRST CLUB" (35 SKU rows with rates, 2 locations; checked 2026-11-05). */
  [CHANNELS.FIRST_CLUB]: 41,
  /** "OCTAVOS ENTERPRISE" (Smytten; 49 SKU rows, prices from the Smytten Minis Master loaded 2026-11-05; 4 locations). */
  [CHANNELS.OCTAVOS]: 22,
  /** "NOBLE CHEMIST" (15 SKU rows by EAN with rates, 1 location GOREGOAN_WEST; checked 2026-11-05). Not "NOBLE PLUS" (36). */
  [CHANNELS.NOBLE_CHEMIST]: 35,
};

/**
 * Channels whose PO line gives their channel code, OR our pep code, OR the EAN in the same column (Slikk's "SKU Id": the
 * EAN for some mCaffeine items, our code for the rest; 2026-11-02): looked up among the channel's rows as channel_code,
 * then pep_code, then ean_code (SLIKK rows hold some EANs only in ean_code: MCaf371 / MCaf40 carry another item's
 * channel_code on 2 Nov).
 */
export const SKU_ANY_CODE: ReadonlySet<ChannelName> = new Set([CHANNELS.SLIKK]);

/**
 * Channels whose channel_code is the EAN (Pop Tech, user 2026-11-02): when the code gives rows of several of our codes,
 * only the rows whose ean_code is the PO line's EAN are kept (8906129570856: channel_code on MTOOL7_NL_S + MTOOL7_NL,
 * ean_code only on MTOOL7_NL_S). Still several -> review (MCaf383_WB / _N1, Mcaf396_WB / Mcaf396 carry both).
 */
/**
 * Several locations match one PO (shared pincode): how the PO's own address must match one of them to pick it
 * (po-validation/location-tiebreak.ts; user 2026-11-02). Score = shared words / the smaller word count (0-1).
 */
export const LOCATION_TIEBREAK = {
  /** the best address must share at least this share of words */
  ADDRESS_MIN: 0.8,
  /** and be this far ahead of the next one (Avenue Thane 2 (Kukse) 1.0 vs Mouje Borivali 0.93: same building -> review) */
  ADDRESS_MARGIN: 0.2,
  /** a PO address shorter than this (e.g. only "BLINK COMMERCE PRIVATE LIMITED") is not used */
  ADDRESS_MIN_WORDS: 6,
} as const;

export const SKU_EAN_TIEBREAK: ReadonlySet<ChannelName> = new Set([CHANNELS.POP_TECH]);

/**
 * Channels whose channel code may sit on rows of several of our codes, told apart by the PO's item description (user
 * 2026-11-05, First Club: SKU263395202 on MCaf383_WB_N1, MCaf369, MCaf87 and 55MCaf40; the PO line says "mCaffeine
 * Brightening Raspberry Rush Body Wash 300 ml"): the row whose product name (channel row, else our SKU master) is
 * contained word for word in the description is taken, when it is the only one. None or several -> review, as before.
 * Runs after the EAN tie-break (po-validation/sku-name-tiebreak.ts).
 */
export const SKU_NAME_TIEBREAK: ReadonlySet<ChannelName> = new Set([CHANNELS.FIRST_CLUB]);

export const SKU_NAME_MATCH = {
  /** words that say nothing about the product (brand, joiners) */
  IGNORE_WORDS: ['mcaffeine', 'and', 'with', 'for', 'the', 'of', 'amp'],
  /** sizes / units ("300 ml", "15gm", "(55 g)", "Rs 129"): the PO's size differs from the master's pack name */
  IGNORE_WORD_RE: /^(\d+(\.\d+)?(ml|l|g|gm|gms|kg|mg|pc|pcs|n)?|ml|l|g|gm|gms|kg|mg|rs|pc|pcs)$/,
  /** a product name must keep at least this many words to be used */
  MIN_WORDS: 2,
} as const;


/**
 * How the PO's delivery location is found in details_channels:
 *   code_then_pincode: delivery_facility_code = channel_location_code (case-insensitive); if no row, delivery_pincode =
 *                      consignee_pin_code
 *   pincode:           delivery_pincode = consignee_pin_code only (Purplle: its plant codes W502 ... are not in the master)
 * Both, every channel (2026-11-02): no row by consignee_pin_code -> a location WITHOUT consignee_pin_code whose
 * final_shipping_address ends with the pincode (last 6 digits; Slikk / Gluzo / Pop Tech / Octavos ... keep it only there).
 * Exactly one row must match; none or several -> review.
 */
/** Pep Technologies' PAN: inside every GSTIN of ours (27AAICP2804J1ZC ...), so a PO's other GSTIN is the buyer's. */
export const OUR_PAN = 'AAICP2804J';

/**
 * only (2026-11-05, Noble Chemist: its order form carries neither a location code nor a pincode, and the channel has
 * ONE location): the channel's only active location; none or several -> review.
 */
export const LOCATION_MATCH = { CODE_THEN_PINCODE: 'code_then_pincode', PINCODE: 'pincode', ONLY: 'only' } as const;
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
  [CHANNELS.MYNTRA]: LOCATION_MATCH.CODE_THEN_PINCODE,
  /** No site code on the PO: the Ship To pincode (two locations share 421302 on 30 Oct: the reviewer picks). */
  [CHANNELS.AVENUE]: LOCATION_MATCH.PINCODE,
  /** No location code on the PO: the SHIPPED TO ADDRESS pincode (Hillway 387570 -> "Ahmedabad"). */
  [CHANNELS.FLIPKART_QCOM]: LOCATION_MATCH.PINCODE,
  /** No location code on the PO: the Shipping Address pincode (110092; the master's DELHI row has none on 2 Nov: review). */
  [CHANNELS.GLUZO]: LOCATION_MATCH.PINCODE,
  /** No location code on the PO: the Shipped To Address pincode (562114 Hosakote / 560102 HSR; none in the master on 2 Nov). */
  [CHANNELS.SLIKK]: LOCATION_MATCH.PINCODE,
  /** No location code on the PO: the Ship to pincode (562114 BANGLORE / 122001 GURGOAN; the 28 Oct master has the pincode
   *  only inside the address, consignee_pin_code empty: matched by the address, as for every channel). */
  [CHANNELS.POP_TECH]: LOCATION_MATCH.PINCODE,
  /** The PO number ends in First Club's warehouse code (FHYBLRNLM01 / FRHHYDMDL01), not our location code: the Shipping
   *  Address pincode (562123 BENGALURU, 500078 HYDERABAD; only in the master's address on 5 Nov: matched by the address). */
  [CHANNELS.FIRST_CLUB]: LOCATION_MATCH.PINCODE,
  /** No location code on the PO: the pincode of Octavos' warehouse block at the top (382427 AHMEDABAD_2, 122503 GURGAON,
   *  387570 HARYALA / HARYALA_2 = the address decides; 122506 Farukh Nagar not in the master on 5 Nov: review). */
  [CHANNELS.OCTAVOS]: LOCATION_MATCH.PINCODE,
  /** One location (GOREGOAN_WEST, New Welcome Agencies); the form has no pincode. */
  [CHANNELS.NOBLE_CHEMIST]: LOCATION_MATCH.ONLY,
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
  /** A rejected PO reopened (2026-11-03): one OTHER issue that a person must accept before it goes for approval. */
  REOPENED: 'reopened',
} as const;
export type IssueField = (typeof ISSUE_FIELDS)[keyof typeof ISSUE_FIELDS];

/**
 * Issue types a reviewer may ACCEPT as they are for one PO (user, 2026-10-08): rule issues with nothing to correct
 * (FOC / revised = OTHER, expired). Data issues (SKU, MRP, price, total, location, qty, OCR) must be corrected or the PO
 * rejected; DUPLICATE_PO can only be rejected.
 */
/**
 * Channels whose PO price is NOT checked (2026-11-03, user: Myntra STRs; Noble Chemist's order form prints no price,
 * 2026-11-05): the sale order takes our master rate (margin)
 * and our GST; the PO's own price is only shown as information. No "price missing", no price / total check; MRP is.
 */
export const OUR_PRICE_ONLY_CHANNELS: readonly ChannelName[] = [CHANNELS.MYNTRA, CHANNELS.NOBLE_CHEMIST];

/** What a location's Uniware channel should be (a channel's own sheet); our master differing -> review (OTHER). */
export const EXPECTED_UNIWARE_CHANNEL: Partial<Record<ChannelName, Record<string, string>>> = {
  [CHANNELS.MYNTRA]: Object.fromEntries(MYNTRA_STR.DESTINATIONS.map((d) => [d.location, d.uniwareChannel])),
};

export const ACCEPTABLE_ISSUE_TYPES: readonly IssueType[] = [ISSUE_TYPE.OTHER, ISSUE_TYPE.PO_EXPIRED, ISSUE_TYPE.TOTAL_MISMATCH];

/**
 * OTHER issues that are a gap in OUR master (2026-11-05, user: "if it is not in the masters keep it in review with proper
 * errors; the masters team adds the data"): no rate after margin, no GST for our SKU. They are NOT accepted by a reviewer
 * (a sale order needs our price and GST) and the re-check closes them once the master has the value (the PO then goes on
 * by itself).
 */
export const MASTER_GAP_FIELDS: readonly string[] = [ISSUE_FIELDS.RATE, ISSUE_FIELDS.GST];

/** Can a reviewer accept this issue with a remark? (type acceptable, and not a gap in our master) */
export const isAcceptableIssue = (type: string, field: string | null | undefined): boolean =>
  ACCEPTABLE_ISSUE_TYPES.includes(type as IssueType) && !(type === ISSUE_TYPE.OTHER && MASTER_GAP_FIELDS.includes(field ?? ''));
/** Price check (2026-10-30): a total still off after the line choices is accepted ("go with the line total") only with a remark. */
export const REMARK_REQUIRED_ISSUE_TYPES: readonly IssueType[] = [ISSUE_TYPE.TOTAL_MISMATCH];

/** Rupee amounts are compared after rounding to paise, so 0.004 of float noise is never an issue. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

const rs = (n: number): string => n.toFixed(2);
const signed = (n: number): string => `${n > 0 ? '+' : ''}${rs(n)}`;

/** Issue messages, by po_issues.issue_type. `where` is "PO" or "line <n> (<channel SKU code>)". */
const ISSUE_MESSAGES = {
  [ISSUE_TYPE.DUPLICATE_PO]: (channel: string, poNumber: string, copyOf?: string) =>
    copyOf
      ? `PO ${poNumber} of ${channel} is already in POST_FG as ${copyOf}: reject this copy (or open that one)`
      : `PO ${poNumber} of ${channel} is already in master_purchase_orders`,
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
  /** Appended to "pincode …" when the channel has locations without consignee_pin_code (their address is searched too). */
  /** LOCATION_MATCH.ONLY: how the match is named in the messages. */
  LOCATION_ONLY: "the channel's only location",
  LOCATION_BY_ADDRESS: ' (consignee_pin_code, else the pincode in the location address)',
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
  SKU_NO_RATE: (pepCode: string) => `no price in our master: our SKU ${pepCode} has no rate after margin for this channel (master_channel_skus); the masters team adds it, then the re-check completes this PO`,
  /** Switched off on the Masters page (2026-10-28): the PO line or location goes to review. */
  SKU_INACTIVE: (pepCode: string) => `our SKU ${pepCode} is inactive in the PEP SKU master (switch it on, or map the line to another SKU)`,
  FACILITY_INACTIVE: (code: string, facility: string) => `location "${code}" is served by warehouse ${facility}, which is inactive in the Warehouses master`,
  QTY_MISSING: 'no quantity on the PO line',
  PRICE_MISSING: 'no unit price on the PO line (neither landing rate nor unit cost)',
  GST_MISSING: (pepCode: string) => `no GST rate for ${pepCode} (neither on the PO nor in master_skus)`,
  FOC_REVIEW: (reasons: string) => `marked for manual review by processing: ${reasons}`,
  UNIWARE_CHANNEL_DIFFERS: (location: string, ours: string, expected: string) =>
    `Uniware channel of ${location}: our master says ${ours || '(none)'}, the channel's location sheet says ${expected}: fix the master (or accept)`,
  REVISED: (revisionOf: string) => `revised PO${revisionOf ? ` of ${revisionOf}` : ''}: updating the earlier PO is not built yet`,
  OCR_NO_PO_NUMBER: 'no PO number was read',
  OCR_NO_LINES: 'no line items were read',
  /** po_issues.remark when a re-run no longer finds an open issue (e.g. the master data was fixed). */
  AUTO_CLOSED: 'no longer found by validation',
};
