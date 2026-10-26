import { AMAZON, ERROR_CODES } from '../../constants';
import { appError } from '../../utils/AppError';
import { ExternalPo } from '../channel-api/connector';
import { ProcessedPo } from '../po-processing/common/processed-po';

/*
 * Amazon's shipment file from Seller Central (user, 2026-10-22: "for Amazon they send a .tsv"), e.g. FBA15MR12K8V.tsv:
 *   Shipment ID <tab> FBA15MR12K8V      Name <tab> FBA STA (22/10/2026 05:40)-IDX2      Plan ID      Ship To <tab> IDX2
 *   Total SKUs <tab> 12                 Total Units <tab> 260
 *   (blank line)
 *   Merchant SKU | Title | ASIN | FNSKU | external-id ("EAN: 8906…") | Condition | Who will prep? | Prep Type |
 *   Who will label? | Shipped
 * Checked on 4 files of 22 Oct against the SP-API: same SKUs and quantities. It is turned into the same shape the
 * Amazon connector builds from the API (shipment + items), so amazonConnector.toProcessed makes processed.json exactly
 * as for an API PO; the file's Title and EAN are added to each line.
 */

export interface AmazonTsvLine { sku: string; title: string; asin: string; fnsku: string; ean: string; shipped: number }
export interface AmazonTsv {
  shipmentId: string;
  name: string;
  planId: string;
  shipTo: string;
  totalSkus: number | null;
  totalUnits: number | null;
  lines: AmazonTsvLine[];
}

const HEAD = { ID: 'Shipment ID', NAME: 'Name', PLAN: 'Plan ID', SHIP_TO: 'Ship To', SKUS: 'Total SKUs', UNITS: 'Total Units' } as const;
const COL = { SKU: 'Merchant SKU', TITLE: 'Title', ASIN: 'ASIN', FNSKU: 'FNSKU', EXT: 'external-id', SHIPPED: 'Shipped' } as const;
const FBA_ID = /^FBA[0-9A-Z]{6,}$/;

/** Reads the file; refuses anything that is not an Amazon shipment file (wrong layout, no id, no lines). */
export const parseAmazonTsv = (fileName: string, text: string): AmazonTsv => {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  const head = new Map<string, string>();
  const start = rows.findIndex((r) => r.startsWith(`${COL.SKU}\t`));
  for (const r of rows.slice(0, start < 0 ? rows.length : start)) {
    const [k, ...v] = r.split('\t');
    if (k) head.set(k.trim(), v.join('\t').trim());
  }
  const shipmentId = head.get(HEAD.ID) ?? '';
  if (start < 0 || !FBA_ID.test(shipmentId)) throw appError(ERROR_CODES.MANUAL_AMAZON_FILE, fileName);
  const cols = rows[start].split('\t').map((c) => c.trim());
  const at = (name: string) => cols.indexOf(name);
  const lines = rows.slice(start + 1).filter((r) => r.trim()).map((r) => {
    const c = r.split('\t');
    const get = (name: string) => (at(name) >= 0 ? (c[at(name)] ?? '').trim() : '');
    return {
      sku: get(COL.SKU), title: get(COL.TITLE), asin: get(COL.ASIN), fnsku: get(COL.FNSKU),
      ean: get(COL.EXT).replace(/^EAN:\s*/i, ''), shipped: Number(get(COL.SHIPPED)) || 0,
    };
  }).filter((l) => l.sku);
  if (!lines.length) throw appError(ERROR_CODES.MANUAL_AMAZON_FILE, fileName);
  const num = (k: string) => (head.get(k) ? Number(head.get(k)) : null);
  return { shipmentId, name: head.get(HEAD.NAME) ?? '', planId: head.get(HEAD.PLAN) ?? '', shipTo: head.get(HEAD.SHIP_TO) ?? '', totalSkus: num(HEAD.SKUS), totalUnits: num(HEAD.UNITS), lines };
};

/** "FBA STA (22/10/2026 05:40)-IDX2" -> 2026-10-22; else today (as the connector does). */
const createdOf = (name: string): string => {
  const m = name.match(AMAZON.NAME_DATE);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().slice(0, 10);
};

/** The file as the connector's ExternalPo (v0 shipment + items), with the status read from Amazon at upload. */
export const toExternalPo = (t: AmazonTsv, status: string): ExternalPo => {
  const shipment = { ShipmentId: t.shipmentId, ShipmentName: t.name, ShipmentStatus: status, DestinationFulfillmentCenterId: t.shipTo };
  const items = t.lines.map((l) => ({ SellerSKU: l.sku, FulfillmentNetworkSKU: l.fnsku, QuantityShipped: l.shipped }));
  return { externalId: t.shipmentId, status, label: t.name, raw: shipment, poNumber: t.shipmentId, createdAt: createdOf(t.name), rawFull: { shipment, items, file: t } };
};

/** Adds the file's own Title, EAN and ASIN to the lines toProcessed made (same order as the file). */
export const withFileDetails = (po: ProcessedPo, t: AmazonTsv, fileName: string): ProcessedPo => ({
  ...po,
  input_type: 'amazon_tsv',
  line_items: po.line_items.map((l, i) => {
    const f = t.lines[i];
    return f ? { ...l, description: f.title || l.description, ean: f.ean || l.ean, unmapped: { ...l.unmapped, asin: f.asin, file_title: f.title } } : l;
  }),
  unmapped: { ...po.unmapped, source_file: fileName, plan_id: t.planId, file_total_skus: String(t.totalSkus ?? ''), file_total_units: String(t.totalUnits ?? '') },
  field_sources: { ...po.field_sources, po_number: 'file', po_date: 'file', delivery_facility_code: 'file', total_qty: 'file', 'line_items.description': 'file', 'line_items.ean': 'file' },
});
