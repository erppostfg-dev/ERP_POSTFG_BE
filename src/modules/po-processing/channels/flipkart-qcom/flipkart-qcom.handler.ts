import { CHANNELS, OUR_PAN, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import {
  FLIPKART_QCOM_HEADER_NAMES,
  FLIPKART_QCOM_MAPPING,
  FLIPKART_QCOM_RATES,
  FLIPKART_QCOM_TOTAL_TOLERANCE,
} from './flipkart-qcom.mapping';

/**
 * Flipkart Quick Commerce's route (2026-10-30): raw output of the OCR sheet pipeline -> processed.json. Manual Upload
 * only (no email). Location by the SHIPPED TO ADDRESS pincode, SKU by the FSN (validation).
 */
export const flipkartQcomHandler: ChannelHandler = {
  channel: CHANNELS.FLIPKART_QCOM,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header (the OCR's model names the labels; footer totals are merged in by the raw reader).
    const header = ourNames(ctx.raw.header, FLIPKART_QCOM_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, FLIPKART_QCOM_MAPPING.header, po.warnings, 'header');
    markRawSources(po, FLIPKART_QCOM_MAPPING.header);
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.po_date = shortDate(header, 'ORDER DATE', usedHeader, po.warnings);
    po.expiry_date = shortDate(header, 'PO Expiry', usedHeader, po.warnings);
    // Billed by / Shipped from are ours, Billed to / Shipped to are Flipkart's: the first GSTIN that is not ours.
    const gstinKey = Object.keys(header).find((k) => /gstin/i.test(k) && /^\d{2}[A-Z]{5}\d{4}[A-Z]/i.test(text(header[k])) && !text(header[k]).toUpperCase().includes(OUR_PAN));
    if (gstinKey) {
      po.delivery_gstin = text(header[gstinKey]).toUpperCase();
      po.field_sources.delivery_gstin = `raw (${gstinKey})`;
    }
    const totalQty = optionalNumber(header, 'Total Quantity', usedHeader, po.warnings);
    const totalAmount = optionalNumber(header, 'Total Amount', usedHeader, po.warnings);

    // 2. No email; no revision signal on these POs.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Line items: mapped as printed; gst from the rate columns; the Required by Date is the PO's expected date.
    const required = new Set<string>();
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, FLIPKART_QCOM_MAPPING.line, po.warnings, where);
      line.gst = lineGst(raw, used, where, po.warnings);
      if (raw['Required by Date'] !== undefined) {
        used.add('Required by Date');
        const d = toDate(raw['Required by Date'], `${where} Required by Date`, po.warnings);
        if (d) required.add(d);
      }
      line.unmapped = leftover(raw, used);
      return line;
    });
    if (required.size) {
      po.expected_date = [...required].sort()[0];
      po.field_sources.expected_date = required.size > 1 ? 'raw (earliest Required by Date)' : 'raw (Required by Date)';
    }

    // 4. Totals: the footer when the OCR gives it, else the lines' sums; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = totalAmount !== '' ? totalAmount : valueSum ?? '';
    po.field_sources.po_value = totalAmount !== '' ? 'raw' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total Quantity', totalQty, 'SUM(Quantity)', qtySum));
    }
    if (totalAmount !== '' && valueSum !== null && Math.abs(valueSum - totalAmount) > FLIPKART_QCOM_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Total Amount', totalAmount, 'SUM(Total Amount)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on these POs: cart_discount 0, net_amount = po_value.
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};

/** "17-09-26" (day-month-two-digit year, as Flipkart prints it) or any date toDate reads -> YYYY-MM-DD. */
const shortDate = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): string => {
  if (values[name] === undefined) return '';
  used.add(name);
  const v = text(values[name]);
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(v);
  return toDate(m ? `${m[1]}-${m[2]}-20${m[3]}` : v, name, warnings);
};

const optionalNumber = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return toNumber(values[name], name, warnings);
};

/** The line's GST % = IGST + SGST/UTGST + CGST rates ("18.0%"); the per-unit amounts stay under unmapped. */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  const rates = FLIPKART_QCOM_RATES.filter((k) => raw[k] !== undefined).map((k) => {
    used.add(k);
    return toNumber(raw[k].replace('%', ''), `${where} ${k}`, warnings);
  });
  if (!rates.length || rates.some((r) => r === '')) {
    warnings.push(poWarning(WARNING_CODES.GST_COLUMNS_MISSING, where, FLIPKART_QCOM_RATES.map((r) => `"${r}"`).join(' + ')));
    return '';
  }
  return Math.round((rates as number[]).reduce((a, r) => a + r, 0) * 100) / 100;
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? Math.round((values).reduce((a, v) => a + v, 0) * 100) / 100 : null;
