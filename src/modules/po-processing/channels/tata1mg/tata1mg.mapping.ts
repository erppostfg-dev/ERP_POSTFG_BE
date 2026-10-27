import { ChannelMapping } from '../../common/apply-mapping';
import { GstColumns } from '../../common/gst';

/*
 * Tata 1mg: common name <- CSV column. Read from the CSVs of POs 6419161 / 6419170 (12 Oct 2026), 6351660 / 6351666,
 * 6284505 / 6284507 (user, 2026-10-26). No OCR: the sheet reader puts every CSV row in the raw JSON as it is.
 *
 * One CSV per PO, the same 29 columns every time; the PO details (POID, StoreCode, Created_At ...) repeat on every
 * line, so the header is read from the PO's first line (headerFromLine). Columns:
 *   Supplier_ID, StoreCode, POID, MRID, Itemcode, Supplier_Itemcode, HSNCode, Company, Item_Name, UOM, Flavour, Color,
 *   SKUSize, Pack, MRP, Cost_PerUnit_WithGST, CGST, SGST, IGST, Margin, Final_Amount, Quantity, Supplier_Name,
 *   Expected_Delivery_Time, Status, Created_At, fDLNo, fgstno, FSSAINo
 * Filled in tata1mg.handler.ts, not here: line_no (row order), gst (IGST, else CGST + SGST), unit_cost (landing rate
 * before GST, calculated), the location code (TATA1MG_STORES), totals, cart_discount 0 / net_amount = po_value.
 * Not sent: EAN, expiry date, appointment date, shipping address / pincode (the location comes from StoreCode).
 */
export const TATA1MG_MAPPING: ChannelMapping = {
  header: [],
  headerFromLine: [
    { common: 'po_number', raw: 'POID', kind: 'text' },
    { common: 'po_date', raw: 'Created_At', kind: 'date' },
    { common: 'expected_date', raw: 'Expected_Delivery_Time', kind: 'date' },
    // 1mg's warehouse code (1MG_MKL ...): turned into our channel_location_code by TATA1MG_STORES.
    { common: 'delivery_facility_code', raw: 'StoreCode', kind: 'text' },
    // The 1mg warehouse's own GSTIN (fgstno = facility GST no).
    { common: 'delivery_gstin', raw: 'fgstno', kind: 'text' },
  ],
  line: [
    // Itemcode = 1mg's SKU id = master_channel_skus.channel_code (Supplier_Itemcode is the same number).
    { common: 'channel_sku_code', raw: 'Itemcode', kind: 'text' },
    { common: 'description', raw: 'Item_Name', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price WITH GST = our rate_after_margin (161.45 for 689776, checked).
    { common: 'landing_rate', raw: 'Cost_PerUnit_WithGST', kind: 'number' },
    // Qty x price with GST (18 x 161.45 = 2906.06 after 1mg's rounding).
    { common: 'line_total', raw: 'Final_Amount', kind: 'number' },
    { common: 'margin', raw: 'Margin', kind: 'number' },
    { common: 'hsn', raw: 'HSNCode', kind: 'text' },
  ],
};

export const TATA1MG_GST_COLUMNS: GstColumns = { cgst: 'CGST', sgst: 'SGST', igst: 'IGST' };

/** The CSV column that tells the POs apart (one email = one CSV per PO, all read into one list). */
export const TATA1MG_PO_COLUMN = 'POID';

/**
 * PO-level columns repeated on every line that are not mapped to a common name: kept once in the PO's unmapped
 * (and left out of each line's unmapped).
 */
export const TATA1MG_PO_LEVEL_COLUMNS = ['Supplier_ID', 'MRID', 'Company', 'Supplier_Name', 'Status', 'fDLNo', 'FSSAINo'];

/**
 * 1mg's StoreCode -> our channel_location_code (details_channels of Tata 1MG, master_channels id 11).
 * Only 1MG_MKL (Makali, Bangalore) has been seen so far. A store not listed here keeps its own code, so its PO goes to
 * review (location not found) and the code is added here then.
 */
export const TATA1MG_STORES: Record<string, string> = {
  '1MG_MKL': 'Bangalore',
};
