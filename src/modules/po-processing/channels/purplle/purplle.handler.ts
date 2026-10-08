import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, findKey, leftover, markRawSources } from '../../common/apply-mapping';
import { pincodeFrom, text } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { addReviewReason, missingFields } from '../../common/review';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { PURPLLE_FOC, PURPLLE_MAPPING, PURPLLE_PO_COLUMN, PURPLLE_REQUIRED, PURPLLE_VALUE_TOLERANCE } from './purplle.mapping';

/**
 * Purplle's route. One email = a summary of all POs raised that day, so it returns one processed.json per
 * PO Document Number (saved under POs/<PO number>/ in the email folder).
 * Later: location match on delivery_pincode (details_channels.consignee_pin_code), SKU match on Sku, master fills
 * for HSN / GST / GSTIN / full address, and the manual review of what is still missing.
 */
export const purplleHandler: ChannelHandler = {
  channel: CHANNELS.PURPLLE,

  async process(ctx: PoContext): Promise<ProcessedPo[]> {
    // Group the summary's lines by PO, in file order.
    const byPo = new Map<string, Record<string, string>[]>();
    for (const raw of ctx.raw.lines) {
      const key = findKey(raw, PURPLLE_PO_COLUMN);
      const poNumber = text(key === undefined ? '' : raw[key]);
      byPo.set(poNumber, [...(byPo.get(poNumber) ?? []), raw]);
    }
    return [...byPo.values()].map((lines) => processOne(ctx, lines));
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "000008906171511081'" -> "8906171511081": digits only, leading zeros dropped down to a 13-digit EAN. */
const cleanEan = (value: string): string => value.replace(/\D/g, '').replace(/^0+(?=\d{13}$)/, '');

const processOne = (ctx: PoContext, rawLines: Record<string, string>[]): ProcessedPo => {
  const po = basePo(ctx);
  const headerMaps = PURPLLE_MAPPING.headerFromLine ?? [];

  // 1. Header from the PO's first line (the summary repeats the PO details on every line).
  const fromLine = applyMapping(po, rawLines[0], headerMaps, po.warnings, 'header (first line)');
  markRawSources(po, headerMaps);
  po.type_delivery_facility = ''; // no int_code in the summary
  po.delivery_pincode = pincodeFrom(po['shipping address']);
  if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
  po.unmapped = leftover(ctx.raw.header, new Set());

  // The PO details must be the same on every line of the PO.
  for (const col of fromLine) {
    const values = new Set(rawLines.map((l) => text(l[col])));
    if (values.size > 1) po.warnings.push(poWarning(WARNING_CODES.HEADER_DIFFERS_BETWEEN_LINES, col, [...values].join(' | ')));
  }

  // 2. No revision signal in Purplle's summary.
  po.revised = false;
  po.field_sources.revised = '';
  po.field_sources.revision_of = '';

  // 3. Line items; line_total = Qty x Price (before GST: Purplle sends no tax).
  po.line_items = rawLines.map((raw, i) => {
    const where = `line ${i + 1}`;
    const line = emptyLine();
    const used = applyMapping(line, raw, PURPLLE_MAPPING.line, po.warnings, where);
    line.ean = cleanEan(line.ean);
    if (typeof line.qty === 'number' && typeof line.unit_cost === 'number') line.line_total = round2(line.qty * line.unit_cost);
    fromLine.forEach((k) => used.add(k)); // PO details repeated on every line: already in the header
    line.unmapped = leftover(raw, used);
    return line;
  });
  if (po.line_items.some((l) => l.line_total !== '')) po.field_sources['line_items.line_total'] = 'calculated (before GST)';

  // 4. Totals: line count, SUM(Qty), SUM(line_total) before GST; no discount (cart_discount 0, net_amount = po_value).
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
    po.field_sources.po_value = 'calculated (before GST)';
  }
  noDiscountAmounts(po);
  if (po.net_amount !== '') po.field_sources.net_amount = 'calculated (before GST)';

  // 5. Cross-check with the body's PO Summary row "<PO> <PO Qty> <PO Value>".
  crossCheckSummary(po, ctx.body);

  // 6. Review: what Purplle doesn't send is listed; FOC POs always go to manual review.
  po.needs_review = false;
  po.review_reasons = [];
  po.missing_fields = missingFields(po, PURPLLE_REQUIRED);
  if (po.missing_fields.length) addReviewReason(po, 'missing fields');
  if (po.po_type.toUpperCase() === PURPLLE_FOC) addReviewReason(po, 'FOC PO (free of cost): always reviewed by hand', true);

  finishSources(po);
  return po;
};

const crossCheckSummary = (po: ProcessedPo, body: string): void => {
  if (!po.po_number) return;
  const num = '([\\d,]+(?:\\.\\d+)?)';
  const m = new RegExp(`\\b${po.po_number}\\s+${num}\\s+${num}`).exec(body);
  if (!m) {
    po.warnings.push(poWarning(WARNING_CODES.PO_NOT_IN_BODY_SUMMARY, po.po_number));
    return;
  }
  const qty = Number(m[1].replace(/,/g, ''));
  const value = Number(m[2].replace(/,/g, ''));

  if (po.total_qty !== '') {
    const ok = po.total_qty === qty;
    po.cross_checks.push({ field: 'total_qty', against: 'body', raw: po.total_qty, value: qty, result: ok ? 'match' : 'mismatch' });
    if (!ok) po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'SUM(Qty)', po.total_qty, "the body's PO Qty", qty));
  }
  if (po.po_value !== '') {
    const ok = Math.abs(po.po_value - value) <= PURPLLE_VALUE_TOLERANCE;
    po.cross_checks.push({ field: 'po_value', against: 'body', raw: po.po_value, value, result: ok ? 'match' : 'mismatch' });
    if (!ok) {
      po.warnings.push(
        poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'SUM(Qty x Price)', po.po_value, "the body's PO Value", value, PURPLLE_VALUE_TOLERANCE),
      );
    }
  }
};
