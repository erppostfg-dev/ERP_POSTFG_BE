import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Amazon RK World (Amazon Vendor Central, vendor XN8TZ; master AMAZON RK WORLD id 26): common name <- column of the
 * "PO Item Export" (.xls by Manual Upload, read by our sheet reader: no OCR; 2026-11-06). Built from
 * Downloads/NEEDS TO ADD/AMAZON RK WORLD "POItemExport_2026-09-22.xls" (3 POs, 16 lines, all Unconfirmed).
 *
 * Sheet "Line Items" (the first): one row per PO line, the PO details repeated on every line. Columns:
 *   PO, Vendor code, Order date, Status, Product name, ASIN, External ID type, External ID, Model number, Merchant SKU,
 *   Catalog number, Availability, Requested / Accepted / ASN / Received / Cancelled / Remaining quantity, Ship-to location,
 *   Window start, Window end, Case size, Cost, Currency, Total requested / accepted / received / cancelled cost,
 *   Expected date, Freight terms, Consolidation ID, Cancellation deadline
 * Dates are yyyy-mm-dd. No MRP, HSN, GST or address in the export.
 *
 * Rules (user 2026-11-05 / 06):
 * - Status: the export is taken BEFORE the PO is confirmed in Vendor Central ("Unconfirmed", accepted 0). For now an
 *   Unconfirmed PO counts as Confirmed: qty = Requested quantity - Cancelled quantity.
 * - Cancelled lines are left out: Availability CA / OS / R2 / CP (LINE_SKIPPED warning).
 * - Cost is BEFORE GST (Cost x 1.18 = exactly 57% of MRP on CMB560 / CMB559): unit_cost; GST from our SKU master.
 * - SKU: ASIN = channel_sku_code (the masters team's channel_code), External ID = ean when its type is EAN, Model number =
 *   our pep code (validation falls back to EAN, then Model number: SKU_EAN_THEN_PEP).
 * - Ship-to location = Amazon's FC code = details_channels.channel_location_code; Window end = PO expiry.
 */
export const RK_MAPPING: ChannelMapping = {
  header: [],
  headerFromLine: [
    { common: 'po_number', raw: 'PO', kind: 'text' },
    { common: 'po_date', raw: 'Order date', kind: 'date' },
    { common: 'expected_date', raw: 'Expected date', kind: 'date' },
    // Saved as the PO Expiry Date (master_purchase_orders.labelsLink, as PEPIMS): the end of Amazon's delivery window.
    { common: 'expiry_date', raw: 'Window end', kind: 'date' },
    { common: 'delivery_facility_code', raw: 'Ship-to location', kind: 'text' },
  ],
  line: [
    { common: 'channel_sku_code', raw: 'ASIN', kind: 'text' },
    // Model number = our PEP code (12 of 13 exactly, Mcaf396_WB by case; checked on dev 2026-11-06).
    { common: 'pep_sku_code', raw: 'Model number', kind: 'text' },
    { common: 'description', raw: 'Product name', kind: 'text' },
    // Price per unit BEFORE GST.
    { common: 'unit_cost', raw: 'Cost', kind: 'number' },
  ],
};

/** The column that tells the POs apart (one export holds many POs). */
export const RK_PO_COLUMN = 'PO';
export const RK_STATUS_COLUMN = 'Status';
/** Statuses taken as an open order: Unconfirmed counts as Confirmed for now (user 2026-11-06). Compared lower-case. */
export const RK_STATUS_TAKEN: readonly string[] = ['unconfirmed', 'confirmed'];

export const RK_COLUMNS = {
  REQUESTED: 'Requested quantity',
  CANCELLED: 'Cancelled quantity',
  ACCEPTED: 'Accepted quantity',
  AVAILABILITY: 'Availability',
  EXTERNAL_ID_TYPE: 'External ID type',
  EXTERNAL_ID: 'External ID',
} as const;

/** Availability codes (the part before " - ") of a cancelled line: left out (user 2026-11-05). */
export const RK_CANCELLED_AVAILABILITY: readonly string[] = ['CA', 'OS', 'R2', 'CP'];

/** PO-level columns repeated on every line that have no common name: kept once in the PO's unmapped. */
export const RK_PO_LEVEL_COLUMNS = ['Vendor code', 'Status', 'Window start', 'Freight terms', 'Currency', 'Consolidation ID', 'Cancellation deadline'];
