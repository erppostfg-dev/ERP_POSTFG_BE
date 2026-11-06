import { PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { addReviewReason, missingFields } from '../../common/review';
import { basePo, finishSources, PoContext } from '../channel-handler';
import {
  PURPLLE_FOC,
  PURPLLE_ITEM_CODE,
  PURPLLE_PDF_HEADER_NAMES,
  PURPLLE_PDF_LINE_NAMES,
  PURPLLE_PDF_MAPPING,
  PURPLLE_PDF_REQUIRED,
  PURPLLE_PDF_TOTAL_TOLERANCE,
} from './purplle.mapping';

/**
 * Purplle's PO PDF -> one processed.json (2026-11-06, Manual Upload). The same fields as a PO of the daily summary
 * (purplle.handler.ts), so both routes give the same PO: prices and values BEFORE GST, no discount. The PDF also gives
 * what the summary does not (HSN, GST %, the delivery and our GSTIN); it has no Plant code.
 */
export const processPurpllePdf = (ctx: PoContext): ProcessedPo => {
  const po = basePo(ctx);

  // 1. Header.
  const header = ourNames(ctx.raw.header, PURPLLE_PDF_HEADER_NAMES);
  const usedHeader = applyMapping(po, header, PURPLLE_PDF_MAPPING.header, po.warnings, 'header');
  markRawSources(po, PURPLLE_PDF_MAPPING.header);
  po.po_number = po.po_number.replace(/\s+/g, '');
  // Printed empty on most POs: read only when there (no warning when missing).
  if (text(header['PO Type'])) {
    usedHeader.add('PO Type');
    po.po_type = text(header['PO Type']);
    po.field_sources.po_type = 'raw (PO Type)';
  }
  if (text(header['Validity End Date'])) {
    usedHeader.add('Validity End Date');
    po.expiry_date = toDate(header['Validity End Date'], 'Validity End Date', po.warnings);
    po.field_sources.expiry_date = po.expiry_date ? 'raw (Validity End Date)' : '';
  }
  po.delivery_pincode = pincodeFrom(po['shipping address']);
  if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
  const printedQty = optionalNumber(header, 'Total Qty', usedHeader, po.warnings);
  const printedTotal = optionalNumber(header, 'Total Amount (INR)', usedHeader, po.warnings);
  po.unmapped = leftover(header, usedHeader);

  // 2. No revision signal on the PDF.
  po.revised = false;
  po.field_sources.revised = '';
  po.field_sources.revision_of = '';

  // 3. Lines: Item Code -> Purplle's PPLB code; GST % from the tax columns; line_total = Qty x Rate/Unit (before GST).
  po.line_items = ctx.raw.lines.map((rawLine, i) => {
    const where = `line ${i + 1}`;
    const raw = ourNames(rawLine, PURPLLE_PDF_LINE_NAMES);
    const line = emptyLine();
    const used = applyMapping(line, raw, PURPLLE_PDF_MAPPING.line, po.warnings, where);
    if (line.line_no === '') line.line_no = i + 1;
    if (raw['Item Code'] !== undefined) {
      used.add('Item Code');
      const code = text(raw['Item Code']);
      line.channel_sku_code = PURPLLE_ITEM_CODE.exec(code)?.[0].toUpperCase() ?? code.split(' ')[0];
    }
    if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"Item Code"', 'channel_sku_code'));
    line.ean = line.ean.replace(/\D/g, '');
    line.gst = lineGst(raw, used, where, po.warnings);
    if (typeof line.qty === 'number' && typeof line.unit_cost === 'number') line.line_total = round2(line.qty * line.unit_cost);
    line.unmapped = leftover(raw, used);
    return line;
  });
  po.field_sources['line_items.channel_sku_code'] = 'raw (Item Code)';
  if (po.line_items.some((l) => l.line_total !== '')) po.field_sources['line_items.line_total'] = 'calculated (before GST)';

  // 4. Totals, as for the summary: line count, SUM(Qty), SUM(Qty x Rate/Unit) before GST; checked against the PDF's
  //    Total row (quantity) and Total Amount (INR) (with tax: the lines' values x (1 + GST %)).
  po.total_line_items = po.line_items.length || '';
  po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
  const qtySum = sum(po.line_items.map((l) => l.qty));
  po.total_qty = qtySum ?? '';
  po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
  const valueSum = sum(po.line_items.map((l) => l.line_total));
  po.po_value = valueSum ?? '';
  po.field_sources.po_value = po.po_value === '' ? '' : 'calculated (before GST)';
  noDiscountAmounts(po);
  if (po.net_amount !== '') po.field_sources.net_amount = 'calculated (before GST)';

  if (printedQty !== '' && qtySum !== null && printedQty !== qtySum) {
    po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'SUM(Qty)', qtySum, 'the PDF\'s Total Qty', printedQty));
  }
  const withTax = sum(po.line_items.map((l) => (typeof l.line_total === 'number' && typeof l.gst === 'number' ? l.line_total * (1 + l.gst / 100) : '')));
  if (printedTotal !== '' && withTax !== null && Math.abs(withTax - printedTotal) > PURPLLE_PDF_TOTAL_TOLERANCE) {
    po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'SUM(Qty x Rate/Unit x (1 + GST %))', withTax, 'the PDF\'s Total Amount (INR)', printedTotal,
      PURPLLE_PDF_TOTAL_TOLERANCE));
  }

  // 5. Review: what is missing; a free-of-cost PO (PO Type FOC, or every price 0) always by hand.
  po.needs_review = false;
  po.review_reasons = [];
  po.missing_fields = missingFields(po, PURPLLE_PDF_REQUIRED);
  if (po.missing_fields.length) addReviewReason(po, 'missing fields');
  const allFree = po.line_items.length > 0 && po.line_items.every((l) => l.unit_cost === 0);
  if (po.po_type.toUpperCase() === PURPLLE_FOC || allFree) addReviewReason(po, 'FOC PO (free of cost): always reviewed by hand', true);

  finishSources(po);
  return po;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

const optionalNumber = (values: Record<string, string>, name: string, used: Set<string>, warnings: PoWarning[]): Num => {
  if (values[name] === undefined || !text(values[name])) return '';
  used.add(name);
  return toNumber(values[name], name, warnings);
};

/** IGST % when charged (another state), else SGST % + CGST % (same state: 9 + 9, or 2.5 + 2.5). */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  const rate = (name: string): Num => {
    if (raw[name] === undefined || !text(raw[name])) return '';
    used.add(name);
    return toNumber(raw[name].replace(/[()%\s]/g, ''), `${where} ${name}`, warnings);
  };
  const igst = rate('IGST Rate');
  const sgst = rate('SGST Rate');
  const cgst = rate('CGST Rate');
  if (typeof igst === 'number' && igst > 0) return igst;
  if (typeof sgst === 'number' && typeof cgst === 'number' && sgst + cgst > 0) return round2(sgst + cgst);
  warnings.push(poWarning(WARNING_CODES.GST_COLUMNS_MISSING, where, '"IGST Rate" or "SGST Rate" + "CGST Rate"'));
  return '';
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2(values.reduce((a, v) => a + v, 0)) : null;
