import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { OCTAVOS_HEADER_NAMES, OCTAVOS_LINE_NAMES, OCTAVOS_MAPPING, OCTAVOS_TOTAL_TOLERANCE } from './octavos.mapping';

/**
 * Octavos' route (Smytten, 2026-11-05): raw OCR output of its PO PDF -> processed.json. Manual Upload only (user).
 * Location by the pincode of the company block at the top (Octavos' warehouse), SKU by the Octavos item code; the PO
 * prints prices BEFORE tax and no MRP; anything missing -> review.
 */
export const octavosHandler: ChannelHandler = {
  channel: CHANNELS.OCTAVOS,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header (names as the OCR's header_notes ask; other spellings accepted).
    const header = ourNames(ctx.raw.header, OCTAVOS_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, OCTAVOS_MAPPING.header, po.warnings, 'header');
    markRawSources(po, OCTAVOS_MAPPING.header);
    // "OG/00381/2026-27" kept as printed (with its slashes), without spaces the OCR may add around them
    po.po_number = po.po_number.replace(/\s+/g, '');
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from the buyer address)';
    const totalQty = optionalNumber(header, 'Total Quantity', usedHeader, po.warnings);
    const grandTotal = optionalNumber(header, 'Grand Total', usedHeader, po.warnings);

    // 2. No email; a revised Octavos PO gets a new number.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines: Item Code = the channel code; GST from the tax rates; price with tax = Price x (1 + GST %); the
    //    printed Amount is before tax, so the line total with tax is worked out.
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(rawLine, OCTAVOS_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, OCTAVOS_MAPPING.line, po.warnings, where);
      if (line.line_no === '') line.line_no = i + 1;
      if (raw['Item Code'] !== undefined) {
        used.add('Item Code');
        line.channel_sku_code = raw['Item Code'].replace(/\s+/g, '');
      }
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"Item Code"', 'channel_sku_code'));
      line.description = line.description.replace(/\s+/g, ' ').trim();
      line.gst = lineGst(raw, used, where, po.warnings);
      const amount = optionalNumber(raw, 'Amount', used, po.warnings);
      if (typeof line.unit_cost === 'number' && typeof line.gst === 'number') line.landing_rate = round2(line.unit_cost * (1 + line.gst / 100));
      const beforeTax = typeof amount === 'number' ? amount : typeof line.qty === 'number' && typeof line.unit_cost === 'number' ? line.qty * line.unit_cost : null;
      if (beforeTax !== null && typeof line.gst === 'number') line.line_total = round2(beforeTax * (1 + line.gst / 100));
      line.unmapped = { ...leftover(raw, used), ...(typeof amount === 'number' ? { 'Amount (before tax)': String(amount) } : {}) };
      return line;
    });
    po.field_sources['line_items.channel_sku_code'] = 'raw (Item Code)';
    po.field_sources['line_items.landing_rate'] = 'calculated (Price x (1 + GST %))';
    po.field_sources['line_items.line_total'] = 'calculated (Amount x (1 + GST %))';

    // 4. Totals: Grand Total (with tax, after Octavos' rounding), else the lines' sum; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw (Total Quantity)' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = grandTotal !== '' ? grandTotal : valueSum ?? '';
    po.field_sources.po_value = grandTotal !== '' ? 'raw (Grand Total)' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total Quantity', totalQty, 'SUM(Qty)', qtySum));
    }
    if (grandTotal !== '' && valueSum !== null && Math.abs(valueSum - grandTotal) > OCTAVOS_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Grand Total', grandTotal, 'SUM(Amount x (1 + GST))', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on Octavos POs: cart_discount 0, net_amount = po_value.
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const optionalNumber = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return toNumber(values[name], name, warnings);
};

/** IGST % when charged (Octavos' warehouses are outside Maharashtra), else CGST % + SGST %. */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  const rate = (name: string): Num => {
    if (raw[name] === undefined) return '';
    used.add(name);
    return toNumber(raw[name].replace(/[()%\s]/g, ''), `${where} ${name}`, warnings);
  };
  const igst = rate('IGST Rate');
  const cgst = rate('CGST Rate');
  const sgst = rate('SGST Rate');
  if (typeof igst === 'number' && igst > 0) return igst;
  if (typeof cgst === 'number' && typeof sgst === 'number' && cgst + sgst > 0) return round2(cgst + sgst);
  warnings.push(poWarning(WARNING_CODES.GST_COLUMNS_MISSING, where, '"IGST Rate" or "CGST Rate" + "SGST Rate"'));
  return '';
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2(values.reduce((a, v) => a + v, 0)) : null;
