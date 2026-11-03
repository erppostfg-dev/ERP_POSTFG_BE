import { MYNTRA_STR } from '../../../constants';
import { parseCsv } from '../../../utils/csv';
import { ProcessedLine, ProcessedPo } from '../../po-processing/common/processed-po';
import type { StrRef } from './str-email';

/*
 * One STR's CSV (Myntra partner portal "Download CSV", <STR>-summary.csv) -> processed.json (2026-11-03). One row per
 * SKU: GTIN, SKU Code (= our Myntra channel_code), Quantity, Vendor Article No / Name, HSN, Source WH, Destination WH,
 * MRP, List Price, Landed Price, IGST (or SGST + CGST) Rate / Amount. The CSV has no date: the STR code's date is the
 * PO date (as the team's Inventory Planning files have it). Price (user): List / Landed Price and tax amounts are NOT
 * used, our rate from the master margin makes the value later, so landing_rate stays empty; MRP and GST % are kept for
 * the checks (later).
 */

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
/** GTIN as an EAN: Myntra writes 14 digits with a leading 0 (08906129573567 -> 8906129573567). */
const ean = (gtin: string): string => (/^0\d{13}$/.test(gtin) ? gtin.slice(1) : gtin);

export interface StrSummary {
  rows: number;
  units: number;
  source: string;
  destination: string;
  missingColumns: string[];
}

export const strToProcessed = (ref: Pick<StrRef, 'str' | 'date' | 'destination' | 'group' | 'priority'>, csv: string): { po: ProcessedPo; summary: StrSummary } => {
  const C = MYNTRA_STR.CSV;
  const [head, ...rest] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const names = new Set((head ?? []).map((h) => h.trim().toLowerCase()));
  const missingColumns = [C.SKU, C.QTY, C.MRP, C.DESTINATION].filter((c) => !names.has(c.toLowerCase()));
  const get = byName(head ?? []);
  const rows = rest.filter((r) => r.some((c) => c.trim()));
  const gstOf = (r: string[]): number | '' => {
    const igst = num(get(r, C.IGST));
    if (igst !== '') return igst;
    const s = num(get(r, C.SGST));
    const c = num(get(r, C.CGST));
    return s !== '' && c !== '' ? s + c : '';
  };
  const items: ProcessedLine[] = rows.map((r, i) => ({
    line_no: i + 1,
    pep_sku_code: '',
    listing_sku_code: get(r, C.ARTICLE),
    channel_sku_code: get(r, C.SKU),
    ean: ean(get(r, C.GTIN)),
    description: [get(r, C.NAME), get(r, C.SIZE)].filter(Boolean).join(' '),
    qty: num(get(r, C.QTY)),
    free_qty: '',
    pep_mrp: '',
    channel_mrp: num(get(r, C.MRP)),
    landing_rate: '',
    unit_cost: '',
    line_total: '',
    margin: '',
    hsn: get(r, C.HSN),
    gst: gstOf(r),
    unmapped: { vendor_article_no: get(r, C.ARTICLE), brand: get(r, C.BRAND) },
  }));
  const distinct = (name: string) => [...new Set(rows.map((r) => get(r, name)).filter(Boolean))].join(' | ');
  const summary: StrSummary = {
    rows: items.length,
    units: items.reduce((n, l) => n + (Number(l.qty) || 0), 0),
    source: distinct(C.SOURCE),
    destination: distinct(C.DESTINATION),
    missingColumns,
  };
  const sources: Record<string, string> = { po_number: 'STR code', po_date: 'STR code', delivery_facility_code: 'STR code', line_items: 'STR csv' };
  const po: ProcessedPo = {
    'subject line if email': `Myntra STR ${ref.str} (${summary.destination || ref.destination})`,
    channel_name: MYNTRA_STR.CHANNEL,
    input_type: MYNTRA_STR.INPUT_TYPE,
    ref_file_urls: [],
    po_number: ref.str,
    po_date: ref.date,
    type_delivery_facility: '',
    // the destination code (BP, FKME ...); its location mapping comes with the checks (later)
    delivery_facility_code: ref.destination,
    'shipping address': summary.destination,
    delivery_pincode: '',
    total_line_items: items.length,
    total_qty: summary.units,
    po_value: '',
    expected_date: '',
    appointment_date: '',
    expiry_date: '',
    delivery_gstin: '',
    vendor_gstin: '',
    cart_discount: 0,
    net_amount: '',
    po_type: MYNTRA_STR.PO_TYPE,
    revised: false,
    revision_of: '',
    line_items: items,
    unmapped: {
      source_wh: summary.source, destination_wh: summary.destination, str_group: ref.group, str_priority: ref.priority,
      missing_columns: missingColumns.join(', '),
    },
    field_sources: sources,
    cross_checks: [],
    warnings: [],
    processed_at: new Date().toISOString(),
  };
  return { po, summary };
};
