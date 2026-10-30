import { FLIPKART } from '../../../constants';
import { parseCsv } from '../../../utils/csv';
import { ProcessedLine, ProcessedPo } from '../../po-processing/common/processed-po';

/*
 * Flipkart consignments, the parts with no browser (2026-10-30): the Bulk Consignment File (one row per consignment
 * and category: warehouse, creation date, status) and one consignment's CSV (its lines) -> our processed.json.
 * Columns are read by NAME (constants FLIPKART.CSV / BULK); a missing column leaves the value empty, so the PO goes to
 * review with the reason instead of a guessed value.
 */

/** One consignment as the Bulk Consignment File describes it (its rows of one id taken together). */
export interface ConsignmentHeader {
  id: string;
  /** YYYY-MM-DD of "Creation Date" ("2026-10-24 10:30:09"). */
  createdOn: string;
  warehouse: string;
  status: string;
  dispatchType: string;
  pickupDate: string;
  dropDate: string;
  /** Sum of "Promised Qty" over the consignment's rows. */
  promisedQty: number;
}

/** A header row's cells by column name. */
const byName = (head: string[]) => {
  const ix = new Map(head.map((h, i) => [h.trim().toLowerCase(), i]));
  return (row: string[], name: string): string => {
    const i = ix.get(name.trim().toLowerCase());
    return i === undefined ? '' : (row[i] ?? '').trim();
  };
};

const num = (v: string): number | '' => {
  const n = Number(v.replace(/,/g, ''));
  return v.trim() && Number.isFinite(n) ? n : '';
};

/** The Bulk Consignment File -> consignment id -> its header (several rows per id: one per category). */
export const parseBulkConsignments = (text: string): Map<string, ConsignmentHeader> => {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  const out = new Map<string, ConsignmentHeader>();
  if (!head) return out;
  const get = byName(head);
  const B = FLIPKART.BULK;
  for (const r of rows) {
    const id = get(r, B.ID);
    if (!id) continue;
    const was = out.get(id);
    const promised = Number(get(r, B.PROMISED_QTY)) || 0;
    if (was) {
      was.promisedQty += promised;
      continue;
    }
    out.set(id, {
      id,
      createdOn: get(r, B.CREATED).slice(0, 10),
      warehouse: get(r, B.WAREHOUSE),
      status: get(r, B.STATUS),
      dispatchType: get(r, B.DISPATCH_TYPE),
      pickupDate: get(r, B.PICKUP_DATE),
      dropDate: get(r, B.DROP_DATE),
      promisedQty: promised,
    });
  }
  return out;
};

export interface ConsignmentLine {
  name: string;
  fsn: string;
  skuId: string;
  brand: string;
  qtySent: number | '';
  qtyReceived: number | '';
  cost: number | '';
}

/** One consignment's CSV -> its lines; missingColumns names the expected columns it did not have. */
export const parseConsignmentCsv = (text: string): { lines: ConsignmentLine[]; missingColumns: string[] } => {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!head) return { lines: [], missingColumns: Object.values(FLIPKART.CSV) };
  const names = new Set(head.map((h) => h.trim().toLowerCase()));
  const C = FLIPKART.CSV;
  const missingColumns = [C.FSN, C.QTY_SENT, C.COST].filter((c) => !names.has(c.toLowerCase()));
  const get = byName(head);
  const lines = rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => ({
      name: get(r, C.NAME), fsn: get(r, C.FSN), skuId: get(r, C.SKU_ID), brand: get(r, C.BRAND),
      qtySent: num(get(r, C.QTY_SENT)), qtyReceived: num(get(r, C.QTY_RECEIVED)), cost: num(get(r, C.COST)),
    }));
  return { lines, missingColumns };
};

/** What the robot stored for one consignment (channel_pull_items.data). */
export interface ConsignmentData {
  /** The Scheduled table row's text, as shown. */
  row: string;
  /** Its Bulk Consignment File row; null when the file did not have it yet. */
  header: ConsignmentHeader | null;
  /** The consignment CSV as downloaded. */
  csv: string;
}

/** One consignment -> processed.json. Lines are matched later by FSN (= our Flipkart channel SKU code). */
export const consignmentToProcessed = (id: string, data: ConsignmentData, fallbackDate: string): ProcessedPo => {
  const { lines, missingColumns } = parseConsignmentCsv(data.csv);
  const h = data.header;
  let total = 0;
  let priced = true;
  const items: ProcessedLine[] = lines.map((l, i) => {
    const lineTotal = l.cost === '' || l.qtySent === '' ? '' : Math.round(l.cost * l.qtySent * 100) / 100;
    if (lineTotal === '') priced = false;
    else total += lineTotal;
    return {
      line_no: i + 1,
      // Flipkart's own SKU Id is sometimes stale (MCaf88 for 75MCaf42_WB): a hint only; the FSN decides
      pep_sku_code: l.skuId,
      listing_sku_code: l.skuId,
      channel_sku_code: l.fsn,
      ean: '',
      description: l.name,
      qty: l.qtySent,
      free_qty: '',
      pep_mrp: '',
      // the CSV has no MRP: none to check (the sale order uses our master)
      channel_mrp: '',
      // Cost Price = what Flipkart pays per unit, the same basis as our rate_after_margin (22 / 23 lines equal, 2026-10-30)
      landing_rate: l.cost,
      unit_cost: '',
      line_total: lineTotal,
      margin: '',
      hsn: '',
      gst: '',
      unmapped: { brand: l.brand, quantity_received: String(l.qtyReceived) },
    };
  });
  const value = priced ? Math.round(total * 100) / 100 : '';
  const poDate = h?.createdOn || fallbackDate;
  const sources: Record<string, string> = {};
  for (const f of ['po_number', 'line_items']) sources[f] = 'consignment csv';
  for (const f of ['po_date', 'delivery_facility_code']) sources[f] = h ? 'bulk consignment file' : 'missing';
  return {
    'subject line if email': `Flipkart consignment ${id}${h?.warehouse ? ` (${h.warehouse})` : ''}`,
    channel_name: FLIPKART.CHANNEL,
    input_type: FLIPKART.INPUT_TYPE,
    ref_file_urls: [],
    po_number: id,
    po_date: poDate,
    type_delivery_facility: '',
    delivery_facility_code: h?.warehouse ?? '',
    'shipping address': '',
    delivery_pincode: '',
    total_line_items: items.length,
    total_qty: items.reduce((n, l) => n + (Number(l.qty) || 0), 0),
    po_value: value,
    expected_date: h?.dropDate.slice(0, 10) ?? '',
    appointment_date: '',
    expiry_date: '',
    delivery_gstin: '',
    vendor_gstin: '',
    cart_discount: 0,
    net_amount: value,
    po_type: FLIPKART.PO_TYPE,
    revised: false,
    revision_of: '',
    line_items: items,
    unmapped: {
      flipkart_status: h?.status ?? '', dispatch_type: h?.dispatchType ?? '', scheduled_pickup: h?.pickupDate ?? '',
      promised_qty: h ? String(h.promisedQty) : '', missing_columns: missingColumns.join(', '),
    },
    field_sources: sources,
    cross_checks: [],
    warnings: [],
    processed_at: new Date().toISOString(),
  };
};
