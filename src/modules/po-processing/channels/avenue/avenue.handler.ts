import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { ourNames } from '../../common/our-names';
import { Num, ProcessedPo } from '../../common/processed-po';
import { unstack } from '../../common/stacked';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { AVENUE_HEADER_NAMES, AVENUE_LINE_NAMES, AVENUE_MAPPING, AVENUE_TOTAL_TOLERANCE } from './avenue.mapping';

/**
 * Avenue E-Commerce (DMart)'s route (2026-10-30): raw OCR output of the PO PDF -> processed.json. Manual Upload only
 * (no email: no subject / body sources). Location by the Ship To pincode, SKU by the Article No (validation).
 */
export const avenueHandler: ChannelHandler = {
  channel: CHANNELS.AVENUE,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header: the OCR's names turned into ours, then mapped; everything not mapped stays under unmapped.
    const header = ourNames(ctx.raw.header, AVENUE_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, AVENUE_MAPPING.header, po.warnings, 'header');
    markRawSources(po, AVENUE_MAPPING.header);
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    // "PO Validity : 16.09.2026 to 31.10.2026": the PO expires at the end date.
    const validity = header['PO Validity'];
    if (validity !== undefined) {
      usedHeader.add('PO Validity');
      const end = text(validity).split(/\s+to\s+/i)[1];
      po.expiry_date = end ? toDate(end, 'PO Validity (end)', po.warnings) : '';
      if (po.expiry_date) po.field_sources.expiry_date = 'raw (end of PO Validity)';
    }
    const totalQty = optionalNumber(header, 'Total Qty', usedHeader, po.warnings);
    const totalValue = optionalNumber(header, 'Total Value', usedHeader, po.warnings);

    // 2. No email: no subject / body to cross-check; no revision signal on Avenue POs.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Line items (two printed rows each): stacked cells split, names turned into ours, mapped; the rest calculated.
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(unstack(rawLine), AVENUE_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, AVENUE_MAPPING.line, po.warnings, where);
      const codes = eanAndArticle(raw, used);
      line.ean = codes.ean;
      line.channel_sku_code = codes.article;
      if (!codes.article) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"Article No" (in "EAN/Article No")', 'channel_sku_code'));
      if (raw['HSN Code'] !== undefined) {
        used.add('HSN Code');
        line.hsn = raw['HSN Code'].replace(/[^\d]/g, '');
      }
      line.gst = lineGst(raw, used, where, po.warnings);
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.channel_sku_code'] = 'raw (Article No)';

    // 4. Totals: the PO's Total row when the OCR gives it, else the lines' sums; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = totalValue !== '' ? totalValue : valueSum ?? '';
    po.field_sources.po_value = totalValue !== '' ? 'raw' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total (qty)', totalQty, 'SUM(PO Qty)', qtySum));
    }
    if (totalValue !== '' && valueSum !== null && Math.abs(valueSum - totalValue) > AVENUE_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Total (value)', totalValue, 'SUM(Total Value)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on Avenue POs: cart_discount 0, net_amount = po_value.
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

/** A dash ("-") is Avenue's empty cell. */
const cell = (v: string | undefined): string | undefined => (v === undefined || /^\s*-?\s*$/.test(v) ? undefined : v);

const optionalNumber = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return toNumber(cell(values[name]), name, warnings);
};

/** The EAN (13 digits) and Article No (Avenue's item code) of a line, from their own cells or the stacked one. */
const eanAndArticle = (raw: Record<string, string>, used: Set<string>): { ean: string; article: string } => {
  const digits = (v: string | undefined) => (v ?? '').match(/\d{6,}/g) ?? [];
  let ean = '';
  let article = '';
  for (const name of ['EAN/Article No', 'EAN', 'Article No']) {
    if (raw[name] === undefined) continue;
    used.add(name);
    for (const d of digits(raw[name])) {
      if (d.length === 13 && !ean) ean = d;
      else if (d.length !== 13 && !article) article = d;
    }
  }
  return { ean, article };
};

/** IGST % when charged (inter-state), otherwise CGST % + SGST % (or UGST % in a union territory). */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  const rate = (name: string): Num => {
    if (raw[name] === undefined) return '';
    used.add(name);
    return toNumber(cell(raw[name]), `${where} ${name}`, warnings);
  };
  const igst = rate('IGST%');
  const cgst = rate('CGST%');
  const sgst = rate('SGST%');
  const ugst = rate('UGST%');
  if (typeof igst === 'number' && igst > 0) return igst;
  if (typeof cgst === 'number' && (typeof sgst === 'number' || typeof ugst === 'number')) return cgst + (typeof sgst === 'number' ? sgst : 0) + (typeof ugst === 'number' ? ugst : 0);
  warnings.push(poWarning(WARNING_CODES.GST_COLUMNS_MISSING, where, '"CGST%" + "SGST%" (or "UGST%") or "IGST%"'));
  return '';
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? Math.round((values).reduce((a, v) => a + v, 0) * 100) / 100 : null;
