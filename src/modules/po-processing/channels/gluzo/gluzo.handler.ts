import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { GLUZO_HEADER_NAMES, GLUZO_LINE_NAMES, GLUZO_LINE_RULES, GLUZO_MAPPING, GLUZO_TOTAL_TOLERANCE } from './gluzo.mapping';

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

    // 3. Lines: read by name first, then every value checked by its shape and the line's arithmetic (readLine).
    po.line_items = ctx.raw.lines.map((rawLine, i) => readLine(rawLine, i, po.warnings));
    po.field_sources['line_items.landing_rate'] = 'calculated (Base Price + Tax per Item; Unit Total / Quantity when they do not fit)';
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
const R = GLUZO_LINE_RULES;
type Line = ReturnType<typeof emptyLine>;

/** A number as Gluzo prints it ("2,100.00", "₹19368*", "18%"), or null (no warning: a guess, not the value used). */
const numOf = (value: string | undefined): number | null => {
  const s = text(value).replace(/[,\s₹*%]/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};
/** "18%", "18" or "IGST-18% CESS-0%" -> 18 when it is a GST rate. */
const rateOf = (value: string | undefined, inText = false): number | null => {
  const s = text(value);
  const m = inText ? /(\d+(?:\.\d+)?)\s*%/.exec(s) : /^(\d+(?:\.\d+)?)\s*%?$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return R.GST_RATES.includes(n) ? n : null;
};
const fits = (qty: number, rate: number, total: number): boolean =>
  Math.abs(qty * rate - total) <= Math.max(R.LINE_TOTAL_TOLERANCE, total * R.LINE_TOTAL_SHARE);

/**
 * One Gluzo line. The OCR's names are a first guess (they changed per PO and were shifted on wrapped headers), so:
 * GST = "Tax Rate" only when it is a real rate, else the % in "Tax Type", else any "n%" value; tax per unit = "Tax per
 * Item", else a value = Base x GST, else Base x GST worked out; qty x (Base + Tax) must give Unit Total, else the price
 * with tax = Unit Total / Quantity; a missing qty = Unit Total / price when whole; EAN = 13 digits from 89, HSN = 4-8 digits
 * (found among the line's values when the named one does not fit). Every fix is a LINE_VALUE_FIXED warning.
 */
const readLine = (rawLine: Record<string, string>, i: number, warnings: PoWarning[]): Line => {
  const where = `line ${i + 1}`;
  const raw = ourNames(rawLine, GLUZO_LINE_NAMES);
  const line = emptyLine();
  const used = applyMapping(line, raw, GLUZO_MAPPING.line, warnings, where);
  const fixed = (field: string, how: string) => warnings.push(poWarning(WARNING_CODES.LINE_VALUE_FIXED, where, field, how));
  const entries = Object.entries(raw);
  /** The first value (not of these names) that passes `ok`, with its name marked used. */
  const findValue = <T>(ok: (v: string) => T | null, skip: string[] = []): { name: string; value: T } | null => {
    for (const [name, v] of entries) {
      if (skip.includes(name)) continue;
      const value = ok(v);
      if (value !== null) {
        used.add(name);
        return { name, value };
      }
    }
    return null;
  };
  line.line_no = i + 1;

  // SKU (Gluzo's code = our channel_code)
  line.channel_sku_code = ['SKU', 'Vendor SKU'].map((k) => (raw[k] !== undefined ? (used.add(k), text(raw[k])) : '')).find(Boolean) ?? '';
  if (!line.channel_sku_code) warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"SKU" / "Vendor SKU"', 'channel_sku_code'));
  const skip = ['SKU', 'Vendor SKU', 'Product Name'];

  // EAN: 13 digits from 89 (it wraps over two lines: digits joined); else found among the values; else none.
  const eanOk = (v: string) => { const d = v.replace(/\D/g, ''); return R.EAN.test(d) ? d : null; };
  const namedEan = raw['EAN/UPC'] !== undefined ? (used.add('EAN/UPC'), eanOk(raw['EAN/UPC'])) : null;
  const ean = namedEan ?? findValue((v) => (/^[\d\s]+$/.test(v.trim()) ? eanOk(v) : null), skip)?.value ?? null;
  line.ean = ean ?? '';
  if (!namedEan && raw['EAN/UPC'] !== undefined) fixed('ean', ean ? `"${raw['EAN/UPC']}" is not an EAN: ${ean} from the line` : `"${raw['EAN/UPC']}" is not an EAN: left empty`);

  // HSN: 4-8 digits (not an EAN); "Tax Code" may hold the 18% when the names are shifted.
  const hsnOk = (v: string) => (R.HSN.test(v.trim()) ? v.trim() : null);
  const namedHsn = raw['Product Tax Code'] !== undefined ? (used.add('Product Tax Code'), hsnOk(raw['Product Tax Code'])) : null;
  line.hsn = namedHsn ?? findValue((v) => (/^\d{8}$/.test(v.trim()) ? hsnOk(v) : null), skip)?.value ?? '';

  // GST %
  const namedRate = raw['Tax Rate'] !== undefined ? (used.add('Tax Rate'), rateOf(raw['Tax Rate'])) : null;
  let gst: number | null = namedRate;
  if (gst === null && raw['Tax Type'] !== undefined) { used.add('Tax Type'); gst = rateOf(raw['Tax Type'], true); }
  if (gst === null) gst = findValue((v) => (/%/.test(v) ? rateOf(v) : null), skip)?.value ?? null;
  if (raw['Tax Type'] !== undefined) used.add('Tax Type');
  line.gst = gst ?? '';
  if (namedRate === null && raw['Tax Rate'] !== undefined) fixed('gst', `"Tax Rate" ${raw['Tax Rate']} is not a GST rate: ${gst === null ? 'left empty' : `${gst}% from the line`}`);

  // Tax per unit (rupees): named, else a line value = Base x GST (e.g. under "Tax Rate"), else worked out.
  const base = typeof line.unit_cost === 'number' ? line.unit_cost : null;
  let tax = numOf(raw['Tax per Item']);
  if (raw['Tax per Item'] !== undefined) used.add('Tax per Item');
  if (tax === null && base !== null && gst !== null) {
    const expected = base * gst / 100;
    tax = findValue((v) => { const n = numOf(v); return n !== null && !/%/.test(v) && Math.abs(n - expected) <= 0.05 ? n : null; }, skip)?.value ?? null;
    if (tax === null) { tax = round2(expected); fixed('tax per unit', `not on the line: Base Price x ${gst}% = ${tax}`); }
  }

  // Line total, qty, price with tax: qty x (Base + Tax) must give Unit Total.
  const total = numOf(raw['Unit Total']);
  if (raw['Unit Total'] !== undefined) used.add('Unit Total');
  let qty = typeof line.qty === 'number' ? line.qty : null;
  let rate = base !== null && tax !== null ? round2(base + tax) : null;
  if (qty === null && total !== null && rate) {
    const q = total / rate;
    if (Math.abs(q - Math.round(q)) <= R.WHOLE_QTY && Math.round(q) > 0) { qty = Math.round(q); line.qty = qty; fixed('qty', `not on the line: Unit Total ${total} / price ${rate} = ${qty}`); }
  }
  if (qty !== null && qty > 0 && total !== null && (rate === null || !fits(qty, rate, total))) {
    const fromTotal = round2(total / qty);
    fixed('price', rate === null
      ? `not on the line: Unit Total ${total} / Quantity ${qty} = ${fromTotal} with tax`
      : `Base ${base} + Tax ${tax} = ${rate} does not give Unit Total ${total} for ${qty}: ${fromTotal} with tax (Unit Total / Quantity)`);
    rate = fromTotal;
    if (gst !== null) line.unit_cost = round2(fromTotal / (1 + gst / 100));
  }
  line.landing_rate = rate ?? '';
  line.line_total = total ?? (qty !== null && rate !== null ? round2(qty * rate) : '');
  line.unmapped = leftover(raw, used);
  return line;
};

/** A total as Gluzo prints it ("₹637495.24*", "1392"): the ₹ sign and the trailing * dropped. */
const amount = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined) return '';
  used.add(name);
  return toNumber(values[name].replace(/\*/g, ''), name, warnings);
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2((values).reduce((a, v) => a + v, 0)) : null;
