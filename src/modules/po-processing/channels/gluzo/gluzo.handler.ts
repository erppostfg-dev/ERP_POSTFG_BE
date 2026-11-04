import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { GLUZO_HEADER_NAMES, GLUZO_LINE_NAMES, GLUZO_MAPPING, GLUZO_TOTAL_TOLERANCE } from './gluzo.mapping';

/**
 * Gluzo's route (2026-11-02): raw OCR output of the EasyEcom PO PDF -> processed.json. Manual Upload only (no email).
 * Location by the Shipping Address pincode, SKU by Gluzo's SKU (validation); anything missing in the masters -> review.
 */
export const gluzoHandler: ChannelHandler = {
  channel: CHANNELS.GLUZO,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header (names as the OCR's header_notes ask; other spellings accepted).
    const header = ourNames(ctx.raw.header, GLUZO_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, GLUZO_MAPPING.header, po.warnings, 'header');
    markRawSources(po, GLUZO_MAPPING.header);
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    if (text(header['Expected Delivery Date'])) {
      usedHeader.add('Expected Delivery Date');
      po.expected_date = toDate(header['Expected Delivery Date'], 'Expected Delivery Date', po.warnings);
      if (po.expected_date) po.field_sources.expected_date = 'raw';
    }
    const totalQty = amount(header, 'Total Quantity', usedHeader, po.warnings);
    const grandTotal = amount(header, 'Grand Total', usedHeader, po.warnings);

    // 2. No email; no revision signal on Gluzo POs.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines: SKU / EAN cleaned, price with tax = Base Price + Tax per Item, Unit Total = the line total.
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(rawLine, GLUZO_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, GLUZO_MAPPING.line, po.warnings, where);
      line.line_no = i + 1;
      line.channel_sku_code = ['SKU', 'Vendor SKU'].map((k) => (raw[k] !== undefined ? (used.add(k), text(raw[k])) : '')).find(Boolean) ?? '';
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"SKU" / "Vendor SKU"', 'channel_sku_code'));
      if (raw['EAN/UPC'] !== undefined) { used.add('EAN/UPC'); line.ean = raw['EAN/UPC'].replace(/\D/g, ''); }
      if (raw['Product Tax Code'] !== undefined) { used.add('Product Tax Code'); line.hsn = raw['Product Tax Code'].replace(/\D/g, ''); }
      line.gst = raw['Tax Rate'] !== undefined ? (used.add('Tax Rate'), toNumber(raw['Tax Rate'].replace('%', ''), `${where} Tax Rate`, po.warnings)) : '';
      const tax = raw['Tax per Item'] !== undefined ? (used.add('Tax per Item'), toNumber(raw['Tax per Item'], `${where} Tax per Item`, po.warnings)) : '';
      if (typeof line.unit_cost === 'number' && typeof tax === 'number') line.landing_rate = round2(line.unit_cost + tax);
      const total = raw['Unit Total'] !== undefined ? (used.add('Unit Total'), toNumber(raw['Unit Total'], `${where} Unit Total`, po.warnings)) : '';
      line.line_total = total !== '' ? total : typeof line.qty === 'number' && typeof line.landing_rate === 'number' ? round2(line.qty * line.landing_rate) : '';
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.landing_rate'] = 'calculated (Base Price + Tax per Item)';
    po.field_sources['line_items.line_no'] = 'calculated';

    // 4. Totals: the last page's, else the lines' sums; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = grandTotal !== '' ? grandTotal : valueSum ?? '';
    po.field_sources.po_value = grandTotal !== '' ? 'raw (Grand Total)' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total Quantity', totalQty, 'SUM(Quantity)', qtySum));
    }
    if (grandTotal !== '' && valueSum !== null && Math.abs(valueSum - grandTotal) > GLUZO_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Grand Total', grandTotal, 'SUM(Unit Total)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on Gluzo POs: cart_discount 0, net_amount = po_value.
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A total as Gluzo prints it ("₹637495.24*", "1392"): the ₹ sign and the trailing * dropped. */
const amount = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return toNumber(values[name].replace(/\*/g, ''), name, warnings);
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2((values).reduce((a, v) => a + v, 0)) : null;
