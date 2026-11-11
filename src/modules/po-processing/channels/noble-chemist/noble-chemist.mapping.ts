import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Noble Chemist (orders from New Welcome Agencies Pvt Ltd, Goregaon West): common name <- column of its order form
 * (.xls by Manual Upload, read by our sheet reader: no OCR; 2026-11-05). Built from Downloads/NEEDS TO ADD/Nobel Chemist
 * "Order No 88699.xls".
 *
 * The form: 5 title rows (raw header "Line 1" .. "Line 5", sheet-reader headerRow):
 *   Line 1 "NEW WELCOME AGENCIES PRIVATE LIMITED" (the buyer), Line 2 its address (+ "DL No. ... Email ..."),
 *   Line 3 "ORDER FORM", Line 4 "DATE : 15 Oct 2026 Order No :88699  Order Remarks : ...", Line 5 "NAME : PEP ..." (us);
 * then COMPANY | COMP UPC | ITEM NAME | PACK | QTY. | FREE | MRP | REMARKS (one row per item, a blank row may follow
 * the column names). COMP UPC = the EAN = Noble's channel_code in our master; FREE "-" = none.
 *
 * NO price on the form: our rate is used (OUR_PRICE_ONLY_CHANNELS), only SKU + MRP are checked. Location: the channel's
 * only location (LOCATION_MATCH.ONLY: GOREGOAN_WEST; the form has no pincode).
 */

/** Line 4: "DATE : 15 Oct 2026 Order No :88699  Order Remarks : ..." */
export const NOBLE_DATE_ORDER = /DATE\s*:\s*(.+?)\s+Order\s*No\.?\s*:\s*([A-Za-z0-9/-]+)/i;
/** Line 2: the address, before its "DL No." / "Email" part. */
export const NOBLE_ADDRESS_END = /\s+DL\s*No\.?\s*:|\s+Email\s*:/i;

export const NOBLE_LINE_NAMES: Record<string, string[]> = {
  'COMP UPC': ['COMP UPC', 'UPC', 'EAN', 'Barcode'],
  'ITEM NAME': ['ITEM NAME', 'Item', 'Product Name', 'Description'],
  'QTY.': ['QTY.', 'QTY', 'Quantity'],
  FREE: ['FREE', 'Free Qty'],
  MRP: ['MRP'],
};

export const NOBLE_MAPPING: ChannelMapping = {
  header: [],
  line: [
    { common: 'description', raw: 'ITEM NAME', kind: 'text' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
  ],
};
