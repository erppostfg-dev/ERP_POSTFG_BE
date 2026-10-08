import { CHANNELS } from '../../../../constants/channels';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, findKey, leftover, markRawSources } from '../../common/apply-mapping';
import { applyEmailSources } from '../../common/email-sources';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { unstack } from '../../common/stacked';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import {
  RELIANCE_BASE_VALUE,
  RELIANCE_EMAIL,
  RELIANCE_MAPPING,
  RELIANCE_RATES,
  RELIANCE_TAX_AMOUNTS,
  RELIANCE_TOTAL_BASIC,
  RELIANCE_TOTAL_TOLERANCE,
} from './reliance.mapping';

/**
 * Reliance's route. Today: raw OCR output (+ email subject and body) -> processed.json.
 * Later: location match on delivery_facility_code (site code, e.g. S4ZD), SKU match on the Article No, checks.
 */
export const relianceHandler: ChannelHandler = {
  channel: CHANNELS.RELIANCE,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the raw OCR output; everything not mapped stays under unmapped.
    const usedHeader = applyMapping(po, ctx.raw.header, RELIANCE_MAPPING.header, po.warnings, 'header');
    markRawSources(po, RELIANCE_MAPPING.header);
    po.type_delivery_facility = '';
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. Email subject and body: PO number (subject + body) and PO date (body) cross-checked.
    applyEmailSources(po, ctx.body, ctx.subject, RELIANCE_EMAIL);

    // 3. No revision signal seen for Reliance.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 4. Line items: stacked cells split first, then mapped; gst, line_total and landing_rate calculated.
    let baseSum = 0;
    let baseOk = true;
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = unstack(rawLine);
      const line = emptyLine();
      const used = applyMapping(line, raw, RELIANCE_MAPPING.line, po.warnings, where);

      line.gst = lineGst(raw, used, where, po.warnings);

      const base = toNumber(raw[RELIANCE_BASE_VALUE], `${where} ${RELIANCE_BASE_VALUE}`, po.warnings);
      if (typeof base === 'number') baseSum += base;
      else baseOk = false;
      const taxes = RELIANCE_TAX_AMOUNTS.filter((k) => raw[k] !== undefined).map((k) => toNumber(raw[k], `${where} ${k}`, po.warnings));
      if (typeof base === 'number' && taxes.every((t) => typeof t === 'number')) {
        line.line_total = round2(base + (taxes as number[]).reduce((a, t) => a + t, 0));
        if (typeof line.qty === 'number' && line.qty > 0) line.landing_rate = round2(line.line_total / line.qty);
      }

      // The line's Delivery Date and Site repeat the header's: checked, and left out of unmapped when they match.
      checkRepeat(raw, 'Delivery Date', po.expected_date, (v) => toDate(v, `${where} Delivery Date`, po.warnings), used, where, po.warnings);
      checkRepeat(raw, 'Site', po.delivery_facility_code, text, used, where, po.warnings);

      line.unmapped = leftover(raw, used);
      return line;
    });
    if (po.line_items.some((l) => l.line_total !== '')) po.field_sources['line_items.line_total'] = 'calculated';
    if (po.line_items.some((l) => l.landing_rate !== '')) po.field_sources['line_items.landing_rate'] = 'calculated';

    // 5. Totals: last Sr.No; Reliance's own totals checked against the lines.
    po.total_line_items = po.line_items.length ? po.line_items[po.line_items.length - 1].line_no : '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtys = po.line_items.map((l) => l.qty);
    if (po.total_qty !== '' && qtys.every((q) => typeof q === 'number')) {
      const sum = (qtys as number[]).reduce((a, q) => a + q, 0);
      if (Math.abs(sum - po.total_qty) > 0.001) po.warnings.push(`total_qty: Grand Total of Qty ${po.total_qty} differs from SUM(Quantity) ${sum}`);
    }
    const totalBasic = toNumber(ctx.raw.header[findKey(ctx.raw.header, RELIANCE_TOTAL_BASIC) ?? ''], RELIANCE_TOTAL_BASIC, po.warnings);
    if (baseOk && typeof totalBasic === 'number' && Math.abs(round2(baseSum) - totalBasic) > RELIANCE_TOTAL_TOLERANCE) {
      po.warnings.push(`${RELIANCE_TOTAL_BASIC} ${totalBasic} differs from SUM(${RELIANCE_BASE_VALUE}) ${round2(baseSum)}`);
    }
    const totals = po.line_items.map((l) => l.line_total);
    if (po.po_value !== '' && totals.every((t) => typeof t === 'number')) {
      const sum = round2((totals as number[]).reduce((a, t) => a + t, 0));
      if (Math.abs(sum - po.po_value) > RELIANCE_TOTAL_TOLERANCE) po.warnings.push(`po_value: Total Order Value ${po.po_value} differs from SUM(line_total) ${sum}`);
    }

    // 6. Reliance POs have no discount: cart_discount 0, net_amount = po_value (calculated).
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** IGST % when charged (inter-state PO), otherwise CGST % + SGST %. */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: string[]): Num => {
  const igstKey = findKey(raw, RELIANCE_RATES.igst);
  if (igstKey !== undefined) {
    used.add(igstKey);
    return toNumber(raw[igstKey], `${where} ${RELIANCE_RATES.igst}`, warnings);
  }
  const cgstKey = findKey(raw, RELIANCE_RATES.cgst);
  const sgstKey = findKey(raw, RELIANCE_RATES.sgst);
  if (cgstKey === undefined || sgstKey === undefined) {
    warnings.push(`${where}: no GST rate columns (${RELIANCE_RATES.cgst} + ${RELIANCE_RATES.sgst}, or ${RELIANCE_RATES.igst})`);
    return '';
  }
  used.add(cgstKey).add(sgstKey);
  const cgst = toNumber(raw[cgstKey], `${where} ${RELIANCE_RATES.cgst}`, warnings);
  const sgst = toNumber(raw[sgstKey], `${where} ${RELIANCE_RATES.sgst}`, warnings);
  return typeof cgst === 'number' && typeof sgst === 'number' ? cgst + sgst : '';
};

/** A line value that repeats a header value: a match is marked used, a difference is a warning (kept under unmapped). */
const checkRepeat = (
  raw: Record<string, string>,
  column: string,
  headerValue: string,
  read: (v: string) => string,
  used: Set<string>,
  where: string,
  warnings: string[],
): void => {
  const key = findKey(raw, column);
  if (key === undefined || !headerValue) return;
  const value = read(raw[key]);
  if (value.toLowerCase() === headerValue.toLowerCase()) used.add(key);
  else warnings.push(`${where}: ${column} "${raw[key]}" differs from the header's "${headerValue}"`);
};
