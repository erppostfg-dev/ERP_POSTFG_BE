import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { FIRST_CLUB_HEADER_NAMES, FIRST_CLUB_LINE_NAMES, FIRST_CLUB_MAPPING, FIRST_CLUB_TOTAL_TOLERANCE } from './first-club.mapping';

/**
 * First Club's route (2026-11-05): raw OCR output of its PO PDF -> processed.json. Manual Upload only (user: no other
 * source). Location by the Shipping Address pincode, SKU by First Club's SKU Code (= its channel_code; a code on several
 * of our codes: the item description decides, in validation); anything missing -> review.
 */
export const firstClubHandler: ChannelHandler = {
  channel: CHANNELS.FIRST_CLUB,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header (names as the OCR's header_notes ask; other spellings accepted).
    const header = ourNames(ctx.raw.header, FIRST_CLUB_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, FIRST_CLUB_MAPPING.header, po.warnings, 'header');
    markRawSources(po, FIRST_CLUB_MAPPING.header);
    // "PO-199751- FRHHYDMDL01" (the top box prints it over two lines): one value without spaces
    po.po_number = po.po_number.replace(/\s+/g, '');
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    const grandTotal = optionalNumber(header, 'Grand Total', usedHeader, po.warnings);
    const totalAmount = optionalNumber(header, 'Total Amount', usedHeader, po.warnings);

    // 2. No email; a revised First Club PO gets a new number.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines: SKU Code = the channel code; GST from the tax rates; price with tax = Unit Cost x (1 + GST %).
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(rawLine, FIRST_CLUB_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, FIRST_CLUB_MAPPING.line, po.warnings, where);
      if (line.line_no === '') line.line_no = i + 1;
      if (raw['SKU Code'] !== undefined) {
        used.add('SKU Code');
        line.channel_sku_code = raw['SKU Code'].replace(/\s+/g, '');
      }
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"SKU Code"', 'channel_sku_code'));
      line.description = line.description.replace(/\s+/g, ' ').trim();
      line.gst = lineGst(raw, used, where, po.warnings);
      if (typeof line.unit_cost === 'number' && typeof line.gst === 'number') line.landing_rate = round2(line.unit_cost * (1 + line.gst / 100));
      if (line.line_total === '' && typeof line.qty === 'number' && typeof line.landing_rate === 'number') line.line_total = round2(line.qty * line.landing_rate);
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.channel_sku_code'] = 'raw (SKU Code)';
    po.field_sources['line_items.landing_rate'] = 'calculated (Unit Cost x (1 + GST %))';

    // 4. Totals: Grand Total (else Total Amount), else the lines' sum; checked against the lines. No total qty printed.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = qtySum ?? '';
    po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
    const printed = grandTotal !== '' ? grandTotal : totalAmount;
    const printedName = grandTotal !== '' ? 'Grand Total' : 'Total Amount';
    po.po_value = printed !== '' ? printed : valueSum ?? '';
    po.field_sources.po_value = printed !== '' ? `raw (${printedName})` : po.po_value === '' ? '' : 'calculated';
    if (printed !== '' && valueSum !== null && Math.abs(valueSum - printed) > FIRST_CLUB_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, printedName, printed, 'SUM(Total)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on First Club POs: cart_discount 0, net_amount = po_value.
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

/** IGST % when charged (inter-state), else CGST % + SGST % ("18.00%", "(9.00%)"). */
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
