import { MYNTRA_STR } from '../../../constants';
import { parseCsv } from '../../../utils/csv';
import { ProcessedLine, ProcessedPo } from '../../po-processing/common/processed-po';
import type { StrRef } from './str-email';

/*
 * One STR's CSV (Myntra partner portal "Download CSV", <STR>-summary.csv) -> processed.json (2026-11-03). One row per
 * SKU: GTIN, SKU Code (= our Myntra channel_code), Quantity, Vendor Article No / Name, HSN, Source WH, Destination WH,
 * MRP, List Price, Landed Price, IGST (or SGST + CGST) Rate / Amount. The CSV has no date: the STR code's date is the
 * PO date (as the team's Inventory Planning files have it). Price + GST (user, 3 Nov): OURS only (master margin 0.85 and
 * our GST); Myntra's List / Landed Price and GST % are NOT used, only kept per line as information (unmapped:
 * myntra_list_price / myntra_landed_price / myntra_gst) and shown next to ours; MRP is checked. The delivery location =
 * our Myntra location for the Destination WH (MYNTRA_STR.DESTINATIONS, the user's sheet), else '' (-> review).
 */

/** Our location for a Myntra destination: by the CSV's Destination WH name, else the STR code's destination. */
export const destinationOf = (name: string, code: string) => {
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return MYNTRA_STR.DESTINATIONS.find((d) => key(d.name) === key(name)) ?? MYNTRA_STR.DESTINATIONS.find((d) => d.code === code) ?? null;
};

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
  const items: ProcessedLine[] = rows.map((r, i): ProcessedLine => ({
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
    // our GST is used (master); Myntra's is information only
    gst: '',
    unmapped: {
      vendor_article_no: get(r, C.ARTICLE), brand: get(r, C.BRAND),
      myntra_list_price: get(r, MYNTRA_STR.PRICE_COLUMNS.LIST), myntra_landed_price: get(r, MYNTRA_STR.PRICE_COLUMNS.LANDED), myntra_gst: String(gstOf(r)),
    },
  }));
  const landedTotal = Math.round(rows.reduce((t, r) => t + (Number(num(get(r, MYNTRA_STR.PRICE_COLUMNS.LANDED))) || 0) * (Number(num(get(r, C.QTY))) || 0), 0) * 100) / 100;
  const distinct = (name: string) => [...new Set(rows.map((r) => get(r, name)).filter(Boolean))].join(' | ');
  const summary: StrSummary = {
    rows: items.length,
    units: items.reduce((n, l) => n + (Number(l.qty) || 0), 0),
    source: distinct(C.SOURCE),
    destination: distinct(C.DESTINATION),
    missingColumns,
  };
  const dest = destinationOf(summary.destination, ref.destination);
  const sources: Record<string, string> = { po_number: 'STR code', po_date: 'STR code', delivery_facility_code: dest ? 'Myntra location sheet' : 'missing', line_items: 'STR csv' };
  const po: ProcessedPo = {
    'subject line if email': `Myntra STR ${ref.str} (${summary.destination || ref.destination})`,
    channel_name: MYNTRA_STR.CHANNEL,
    input_type: MYNTRA_STR.INPUT_TYPE,
    ref_file_urls: [],
    po_number: ref.str,
    po_date: ref.date,
    type_delivery_facility: '',
    // our Myntra location for the destination (the user's sheet); unknown -> '' (review for the location)
    delivery_facility_code: dest?.location ?? '',
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
      source_wh: summary.source, destination_wh: summary.destination, destination_code: ref.destination, str_group: ref.group, str_priority: ref.priority,
      // information only: what Myntra's STR says the whole STR is worth (Landed Price with GST); ours is used
      myntra_landed_total: String(landedTotal), price_basis: 'our master rate (margin) and our GST; Myntra prices not used',
      missing_columns: missingColumns.join(', '),
    },
    field_sources: sources,
    cross_checks: [],
    warnings: [],
    processed_at: new Date().toISOString(),
  };
  return { po, summary };
};
