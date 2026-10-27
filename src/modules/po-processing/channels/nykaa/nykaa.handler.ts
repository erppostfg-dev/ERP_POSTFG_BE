import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, findKey, leftover, markRawSources } from '../../common/apply-mapping';
import { text, toNumber } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import {
  NYKAA_MAPPING,
  NYKAA_PO_AMOUNT_COLUMN,
  NYKAA_PO_AMOUNT_TOLERANCE_PER_LINE,
  NYKAA_PO_COLUMN,
  NYKAA_PO_LEVEL_COLUMNS,
  NYKAA_TAX_COLUMN,
} from './nykaa.mapping';

/**
 * Nykaa's route (2026-10-27). A Manual Upload of the vendor portal's "Purchase Orders" CSV, read by the sheet reader
 * (no OCR) into one list of rows; split here by PO Number into one processed.json per PO (POs/<PO number>/).
 */
export const nykaaHandler: ChannelHandler = {
  channel: CHANNELS.NYKAA,

  async process(ctx: PoContext): Promise<ProcessedPo[]> {
    const byPo = new Map<string, Record<string, string>[]>();
    for (const raw of ctx.raw.lines) {
      const key = findKey(raw, NYKAA_PO_COLUMN);
      const poNumber = text(key === undefined ? '' : raw[key]);
      byPo.set(poNumber, [...(byPo.get(poNumber) ?? []), raw]);
    }
    return [...byPo.values()].map((lines) => processOne(ctx, lines));
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** GST % from the line's tax in rupees; a value within 0.05 of a whole number is that number (18.0004 -> 18). */
const gstPercent = (tax: number, base: number): number => {
  const pct = (tax / base) * 100;
  return Math.abs(pct - Math.round(pct)) < 0.05 ? Math.round(pct) : round2(pct);
};

const processOne = (ctx: PoContext, rawLines: Record<string, string>[]): ProcessedPo => {
  const po = basePo(ctx);
  const headerMaps = NYKAA_MAPPING.headerFromLine ?? [];

  // 1. Header from the PO's first line (the CSV repeats the PO details on every line).
  const fromLine = applyMapping(po, rawLines[0], headerMaps, po.warnings, 'header (first line)');
  markRawSources(po, headerMaps);
  for (const col of fromLine) {
    const values = new Set(rawLines.map((l) => text(l[col])));
    if (values.size > 1) po.warnings.push(poWarning(WARNING_CODES.HEADER_DIFFERS_BETWEEN_LINES, col, [...values].join(' | ')));
  }
  po.type_delivery_facility = '';
  // PO-level columns that have no common name (billing entity, Nykaa's PO Amount): once on the PO.
  const poLevel = new Set<string>();
  for (const name of NYKAA_PO_LEVEL_COLUMNS) {
    const key = findKey(rawLines[0], name);
    if (key === undefined) continue;
    poLevel.add(key);
    po.unmapped[key] = text(rawLines[0][key]);
  }

  // 2. No revision signal in the export.
  po.revised = false;
  po.field_sources.revised = '';
  po.field_sources.revision_of = '';

  // 3. Line items. GST % from Tax Amount; landing rate = Unit Cost with GST; line total = Qty x Unit Cost + Tax Amount.
  //    Tax Amount stays in the line's unmapped (nothing from the file is lost).
  po.line_items = rawLines.map((raw, i) => {
    const where = `line ${i + 1}`;
    const line = emptyLine();
    const used = applyMapping(line, raw, NYKAA_MAPPING.line, po.warnings, where);
    if (line.line_no === '') line.line_no = i + 1;
    const taxKey = findKey(raw, NYKAA_TAX_COLUMN);
    const tax = taxKey === undefined ? '' : toNumber(raw[taxKey], `${where}: ${NYKAA_TAX_COLUMN}`, po.warnings);
    if (typeof line.qty === 'number' && typeof line.unit_cost === 'number' && typeof tax === 'number') {
      const base = line.qty * line.unit_cost;
      if (base > 0) line.gst = gstPercent(tax, base);
      line.line_total = round2(base + tax);
    }
    if (typeof line.unit_cost === 'number' && typeof line.gst === 'number') line.landing_rate = round2(line.unit_cost * (1 + line.gst / 100));
    fromLine.forEach((k) => used.add(k));
    poLevel.forEach((k) => used.add(k));
    line.unmapped = leftover(raw, used);
    return line;
  });
  po.field_sources['line_items.gst'] = 'calculated (Tax Amount / (PO Qty x Unit Cost))';
  po.field_sources['line_items.landing_rate'] = 'calculated (Unit Cost with GST)';
  po.field_sources['line_items.line_total'] = 'calculated (PO Qty x Unit Cost + Tax Amount)';

  // 4. Totals: line count, SUM(PO Qty), SUM(line totals) with GST; no discount (cart_discount 0, net = po_value).
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

  // 5. Nykaa's own PO Amount vs our total (a warning only; the lines stay as Nykaa sent them).
  const amountKey = findKey(rawLines[0], NYKAA_PO_AMOUNT_COLUMN);
  const amount = amountKey === undefined ? '' : toNumber(rawLines[0][amountKey], NYKAA_PO_AMOUNT_COLUMN, po.warnings);
  const tolerance = NYKAA_PO_AMOUNT_TOLERANCE_PER_LINE * po.line_items.length;
  if (typeof amount === 'number' && typeof po.po_value === 'number' && Math.abs(amount - po.po_value) > tolerance) {
    po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'calculated', po.po_value, NYKAA_PO_AMOUNT_COLUMN, amount, tolerance));
  }

  finishSources(po);
  return po;
};
