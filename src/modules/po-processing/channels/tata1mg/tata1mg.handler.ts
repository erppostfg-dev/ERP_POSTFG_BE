import path from 'path';
import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, findKey, leftover, markRawSources } from '../../common/apply-mapping';
import { gstRate } from '../../common/gst';
import { text } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { s3UrlFor } from '../../common/processed-store';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { TATA1MG_GST_COLUMNS, TATA1MG_MAPPING, TATA1MG_PO_COLUMN, TATA1MG_PO_LEVEL_COLUMNS, TATA1MG_STORES } from './tata1mg.mapping';

/**
 * Tata 1mg's route (2026-10-26). One email = one CSV per PO (mCaffeine's and Hyphen's companies), read by the sheet
 * reader (no OCR) into one list of rows; split here by POID into one processed.json per PO (POs/<PO number>/).
 */
export const tata1mgHandler: ChannelHandler = {
  channel: CHANNELS.TATA1MG,

  async process(ctx: PoContext): Promise<ProcessedPo[]> {
    const byPo = new Map<string, Record<string, string>[]>();
    for (const raw of ctx.raw.lines) {
      const key = findKey(raw, TATA1MG_PO_COLUMN);
      const poNumber = text(key === undefined ? '' : raw[key]);
      byPo.set(poNumber, [...(byPo.get(poNumber) ?? []), raw]);
    }
    return [...byPo.values()].map((lines) => processOne(ctx, lines));
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const processOne = (ctx: PoContext, rawLines: Record<string, string>[]): ProcessedPo => {
  const po = basePo(ctx);
  const headerMaps = TATA1MG_MAPPING.headerFromLine ?? [];

  // 1. Header from the PO's first line (the CSV repeats the PO details on every line).
  const fromLine = applyMapping(po, rawLines[0], headerMaps, po.warnings, 'header (first line)');
  markRawSources(po, headerMaps);
  for (const col of fromLine) {
    const values = new Set(rawLines.map((l) => text(l[col])));
    if (values.size > 1) po.warnings.push(poWarning(WARNING_CODES.HEADER_DIFFERS_BETWEEN_LINES, col, [...values].join(' | ')));
  }
  // 1mg's store code -> our location code; an unknown store keeps its own code (-> review: location not found).
  const location = TATA1MG_STORES[po.delivery_facility_code.toUpperCase()];
  if (location) {
    po.unmapped.StoreCode = po.delivery_facility_code;
    po.delivery_facility_code = location;
    po.field_sources.delivery_facility_code = 'raw (StoreCode -> location)';
  }
  po.type_delivery_facility = '';
  // Its own files only (1mg names them "<PO>_..."): the email holds every PO's PDF + CSV.
  const ownFiles = (ctx.meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename)).filter((n) => po.po_number && n.startsWith(`${po.po_number}_`));
  if (ownFiles.length) po.ref_file_urls = [...ownFiles, ctx.raw.sourceFile].map((f) => s3UrlFor(ctx.folder, ctx.meta, path.basename(f)));
  // PO-level columns that have no common name: once on the PO.
  const poLevel = new Set<string>();
  for (const name of TATA1MG_PO_LEVEL_COLUMNS) {
    const key = findKey(rawLines[0], name);
    if (key === undefined) continue;
    poLevel.add(key);
    po.unmapped[key] = text(rawLines[0][key]);
  }

  // 2. The subject lists the email's PO numbers: this PO must be one of them.
  if (po.po_number && ctx.subject) {
    const inSubject = new RegExp(`\\b${po.po_number}\\b`).test(ctx.subject);
    po.cross_checks.push({ field: 'po_number', against: 'subject', raw: po.po_number, value: ctx.subject, result: inSubject ? 'match' : 'mismatch' });
    if (!inSubject) po.warnings.push(poWarning(WARNING_CODES.CROSS_CHECK_MISMATCH, 'po_number', po.po_number, 'subject', ctx.subject));
  }

  // 3. No revision signal seen so far.
  po.revised = false;
  po.field_sources.revised = '';
  po.field_sources.revision_of = '';

  // 4. Line items, numbered in file order; unit_cost = the price with GST taken back to before GST.
  po.line_items = rawLines.map((raw, i) => {
    const where = `line ${i + 1}`;
    const line = emptyLine();
    const used = applyMapping(line, raw, TATA1MG_MAPPING.line, po.warnings, where);
    line.line_no = i + 1;
    line.gst = gstRate(raw, TATA1MG_GST_COLUMNS, used, where, po.warnings);
    if (typeof line.landing_rate === 'number' && typeof line.gst === 'number') line.unit_cost = round2(line.landing_rate / (1 + line.gst / 100));
    fromLine.forEach((k) => used.add(k));
    poLevel.forEach((k) => used.add(k));
    line.unmapped = leftover(raw, used);
    return line;
  });
  po.field_sources['line_items.line_no'] = 'calculated (row order)';
  po.field_sources['line_items.unit_cost'] = 'calculated (landing rate before GST)';

  // 5. Totals: line count, SUM(Quantity), SUM(Final_Amount) with GST; no discount (cart_discount 0, net = po_value).
  po.total_line_items = po.line_items.length;
  po.field_sources.total_line_items = 'calculated';
  const qtys = po.line_items.map((l) => l.qty);
  if (qtys.every((q) => typeof q === 'number')) {
    po.total_qty = (qtys as number[]).reduce((a, q) => a + q, 0);
    po.field_sources.total_qty = 'calculated';
  }
  const totals = po.line_items.map((l) => l.line_total);
  if (totals.every((t) => typeof t === 'number')) {
    po.po_value = round2((totals as number[]).reduce((a, t) => a + t, 0));
    po.field_sources.po_value = 'calculated';
  }
  noDiscountAmounts(po);

  finishSources(po);
  return po;
};
