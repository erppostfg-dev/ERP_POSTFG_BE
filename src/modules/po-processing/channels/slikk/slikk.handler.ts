import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, text, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { addReviewReason } from '../../common/review';
import { unstack } from '../../common/stacked';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { SLIKK_HEADER_NAMES, SLIKK_LINE_NAMES, SLIKK_MAPPING, SLIKK_TOTAL_TOLERANCE } from './slikk.mapping';

/**
 * Slikk's route (2026-11-02): raw OCR output (PDF + sheet, or the PDF alone) -> processed.json. Manual Upload only.
 * A sheet whose "Order" is not the PDF's PO number sends the PO to review. Location by the Shipped To pincode; SKU by
 * channel code or pep code (validation); prices through the price check.
 */
export const slikkHandler: ChannelHandler = {
  channel: CHANNELS.SLIKK,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the PDF (the OCR's header_notes names; other spellings accepted).
    const header = ourNames(ctx.raw.header, SLIKK_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, SLIKK_MAPPING.header, po.warnings, 'header');
    markRawSources(po, SLIKK_MAPPING.header);
    po.po_number = code(po.po_number);
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    const totalQty = amount(header, 'Total Quantity', usedHeader, po.warnings);
    const totalAmount = amount(header, 'Total Amount', usedHeader, po.warnings);

    // 2. No email; no revision signal on Slikk POs.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines (from the sheet, or from the PDF): code cleaned, price with tax = line with tax / qty.
    const otherPos = new Set<string>();
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(unstack(rawLine), SLIKK_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, SLIKK_MAPPING.line, po.warnings, where);
      const take = (k: string) => (raw[k] !== undefined ? (used.add(k), raw[k]) : undefined);

      const order = take('Order');
      if (order && po.po_number && code(order) !== po.po_number) otherPos.add(code(order));
      const no = take('S.No');
      line.line_no = no !== undefined ? toNumber(no, `${where} S.No`, po.warnings) : i + 1;
      line.channel_sku_code = code(take('SKU') ?? '');
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"SKU Id" / "SKU"', 'channel_sku_code'));
      if (/^\d{13}$/.test(line.channel_sku_code)) line.ean = line.channel_sku_code;
      const hsn = take('HSN');
      if (hsn !== undefined) line.hsn = hsn.replace(/\.0$/, '').replace(/\D/g, '');

      const lineTotal = number(take('Line Total'), `${where} line total`, po.warnings);
      const taxable = number(take('Taxable'), `${where} before tax`, po.warnings);
      const tax = number(take('Tax'), `${where} tax`, po.warnings);
      line.line_total = lineTotal !== '' ? lineTotal : taxable !== '' && tax !== '' ? round2(taxable + tax) : '';
      if (typeof line.line_total === 'number' && typeof line.qty === 'number' && line.qty > 0) line.landing_rate = round2(line.line_total / line.qty);
      const gst = number(take('GST %'), `${where} GST %`, po.warnings);
      line.gst = gst !== '' ? gst : taxable !== '' && tax !== '' && taxable > 0 ? Math.round((tax / taxable) * 100) : '';
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.landing_rate'] = 'calculated (line with GST / qty)';
    if (otherPos.size) addReviewReason(po, `the sheet is for PO ${[...otherPos].join(', ')}, the PDF for ${po.po_number}: upload the PDF with its own sheet`, true);

    // 4. Totals: the PDF's, else the lines' sums; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = totalAmount !== '' ? totalAmount : valueSum ?? '';
    po.field_sources.po_value = totalAmount !== '' ? 'raw (Total Amount)' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total Quantity', totalQty, 'SUM(qty)', qtySum));
    }
    if (totalAmount !== '' && valueSum !== null && Math.abs(valueSum - totalAmount) > SLIKK_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Total Amount', totalAmount, 'SUM(line with GST)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on top of the lines: cart_discount 0, net_amount = po_value.
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A code as Slikk / Excel write it -> as stored: wrapped cells joined ("HYPMUBX042 F010", "HYPMUBX042 / F010"), Excel's
 * number forms of an EAN ("8.906129575332E12", "8906129575332.0") back to its digits. Upper / lower case kept.
 */
const code = (value: string): string => {
  const v = text(value).replace(/\s*\/\s*/g, '').replace(/\s+/g, '');
  if (/^\d(\.\d+)?E\+?\d+$/i.test(v)) return BigInt(Math.round(Number(v))).toString();
  return v.replace(/^(\d+)\.0+$/, '$1');
};

/** A number as printed: "580223.72 INR", "₹ 1,234", "18.00%" -> 580223.72, 1234, 18. */
const number = (value: string | undefined, label: string, warnings: PoWarning[]): Num =>
  value === undefined ? '' : toNumber(value.replace(/INR|%/gi, ''), label, warnings);

const amount = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return number(values[name], name, warnings);
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2((values).reduce((a, v) => a + v, 0)) : null;
