import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, findKey, leftover, markRawSources } from '../../common/apply-mapping';
import { text, toNumber } from '../../common/parse';
import { ProcessedLine, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import {
  RK_CANCELLED_AVAILABILITY, RK_COLUMNS, RK_MAPPING, RK_PO_COLUMN, RK_PO_LEVEL_COLUMNS, RK_STATUS_COLUMN, RK_STATUS_TAKEN,
} from './amazon-rk-world.mapping';

/**
 * Amazon RK World's route (2026-11-06): a Manual Upload of the Vendor Central "PO Item Export" (.xls), read by the sheet
 * reader (no OCR) into one list of rows; split here by PO into one processed.json per PO (as Nykaa). Unconfirmed counts
 * as Confirmed for now (qty = requested - cancelled); cancelled lines are left out; Cost is before GST.
 */
export const amazonRkWorldHandler: ChannelHandler = {
  channel: CHANNELS.AMAZON_RK_WORLD,

  async process(ctx: PoContext): Promise<ProcessedPo[]> {
    const byPo = new Map<string, Record<string, string>[]>();
    for (const raw of ctx.raw.lines) {
      const key = findKey(raw, RK_PO_COLUMN);
      const poNumber = text(key === undefined ? '' : raw[key]);
      byPo.set(poNumber, [...(byPo.get(poNumber) ?? []), raw]);
    }
    return [...byPo.values()].map((lines) => processOne(ctx, lines));
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const cell = (raw: Record<string, string>, name: string): string => {
  const key = findKey(raw, name);
  return key === undefined ? '' : text(raw[key]);
};

const processOne = (ctx: PoContext, rawLines: Record<string, string>[]): ProcessedPo => {
  const po = basePo(ctx);
  const headerMaps = RK_MAPPING.headerFromLine ?? [];

  // 1. Header from the PO's first line (the export repeats the PO details on every line).
  const fromLine = applyMapping(po, rawLines[0], headerMaps, po.warnings, 'header (first line)');
  markRawSources(po, headerMaps);
  for (const col of fromLine) {
    const values = new Set(rawLines.map((l) => text(l[col])));
    if (values.size > 1) po.warnings.push(poWarning(WARNING_CODES.HEADER_DIFFERS_BETWEEN_LINES, col, [...values].join(' | ')));
  }
  po.type_delivery_facility = '';
  const poLevel = new Set<string>();
  for (const name of RK_PO_LEVEL_COLUMNS) {
    const key = findKey(rawLines[0], name);
    if (key === undefined) continue;
    poLevel.add(key);
    po.unmapped[key] = text(rawLines[0][key]);
  }

  // 2. No revision signal in the export (the same PO in a later export: backlog G15).
  po.revised = false;
  po.field_sources.revised = '';
  po.field_sources.revision_of = '';

  // 3. A status we don't take (closed, cancelled ...): every line is left out, the PO goes to review with no lines.
  const status = cell(rawLines[0], RK_STATUS_COLUMN);
  const taken = RK_STATUS_TAKEN.includes(status.toLowerCase());
  if (!taken) po.warnings.push(poWarning(WARNING_CODES.PO_STATUS_NOT_TAKEN, status || '(empty)'));

  // 4. Lines: qty = Requested - Cancelled; cancelled availability or nothing left = left out (with why).
  const lines: ProcessedLine[] = [];
  rawLines.forEach((raw, i) => {
    const where = `line ${i + 1}`;
    if (!taken) return;
    const availability = cell(raw, RK_COLUMNS.AVAILABILITY);
    const code = availability.split(/\s+-\s+/)[0].trim().toUpperCase();
    if (RK_CANCELLED_AVAILABILITY.includes(code)) {
      po.warnings.push(poWarning(WARNING_CODES.LINE_SKIPPED, where, `${cell(raw, 'ASIN')} availability "${availability}"`));
      return;
    }
    const line = emptyLine();
    const used = applyMapping(line, raw, RK_MAPPING.line, po.warnings, where);
    line.line_no = i + 1;
    const requested = toNumber(cell(raw, RK_COLUMNS.REQUESTED), `${where}: ${RK_COLUMNS.REQUESTED}`, po.warnings);
    const cancelledText = cell(raw, RK_COLUMNS.CANCELLED);
    const cancelled = cancelledText ? toNumber(cancelledText, `${where}: ${RK_COLUMNS.CANCELLED}`, po.warnings) : 0;
    if (typeof requested === 'number') {
      const qty = requested - (typeof cancelled === 'number' ? cancelled : 0);
      if (qty <= 0) {
        po.warnings.push(poWarning(WARNING_CODES.LINE_SKIPPED, where, `${cell(raw, 'ASIN')} requested ${requested}, cancelled ${String(cancelled)}`));
        return;
      }
      line.qty = qty;
    }
    // External ID is the EAN only when its type says so (else it repeats the Model number: "SKU")
    if (cell(raw, RK_COLUMNS.EXTERNAL_ID_TYPE).toUpperCase() === 'EAN') line.ean = cell(raw, RK_COLUMNS.EXTERNAL_ID).replace(/\D/g, '');
    if (typeof line.qty === 'number' && typeof line.unit_cost === 'number') line.line_total = round2(line.qty * line.unit_cost);
    [RK_COLUMNS.REQUESTED, RK_COLUMNS.CANCELLED].forEach((n) => { const k = findKey(raw, n); if (k !== undefined) used.add(k); });
    fromLine.forEach((k) => used.add(k));
    poLevel.forEach((k) => used.add(k));
    const poKey = findKey(raw, RK_PO_COLUMN);
    if (poKey !== undefined) used.add(poKey);
    line.unmapped = leftover(raw, used);
    lines.push(line);
  });
  po.line_items = lines;
  po.field_sources['line_items.qty'] = 'calculated (Requested quantity - Cancelled quantity; Unconfirmed counts as Confirmed)';
  po.field_sources['line_items.ean'] = 'raw (External ID when External ID type is EAN)';
  po.field_sources['line_items.line_total'] = 'calculated (qty x Cost, before GST)';

  // 5. Totals: line count, SUM(qty); no GST in the export, so no PO value with GST (validation prices each line).
  po.total_line_items = po.line_items.length;
  po.field_sources.total_line_items = 'calculated';
  const qtys = po.line_items.map((l) => l.qty);
  const counted = qtys.filter((q): q is number => typeof q === 'number');
  po.total_qty = qtys.length && counted.length === qtys.length ? counted.reduce((a, q) => a + q, 0) : '';
  po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
  noDiscountAmounts(po);

  finishSources(po);
  return po;
};
