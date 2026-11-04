import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { pincodeFrom, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { POP_TECH_HEADER_NAMES, POP_TECH_LINE_NAMES, POP_TECH_MAPPING, POP_TECH_TOTAL_TOLERANCE } from './pop-tech.mapping';

/**
 * Pop Tech's route (2026-11-02): raw OCR output of the Unicommerce PO PDF -> processed.json. Manual Upload only (emails
 * later). Location by the Ship to pincode, SKU by the EAN (= Pop Tech's channel_code); anything missing -> review.
 */
export const popTechHandler: ChannelHandler = {
  channel: CHANNELS.POP_TECH,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header (names as the OCR's header_notes ask; other spellings accepted) + the unlabeled totals row.
    const header = ourNames(ctx.raw.header, POP_TECH_HEADER_NAMES);
    const usedHeader = applyMapping(po, header, POP_TECH_MAPPING.header, po.warnings, 'header');
    markRawSources(po, POP_TECH_MAPPING.header);
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    const totalQty = optionalNumber(header, 'Total QTY', usedHeader, po.warnings);
    const totalAmount = optionalNumber(header, 'Total Amount', usedHeader, po.warnings);

    // 2. No email; no revision signal on Pop Tech POs.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines: EAN = the channel code; GST from the split tax cells; price with tax = Rate x (1 + GST %).
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(rawLine, POP_TECH_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, POP_TECH_MAPPING.line, po.warnings, where);
      if (line.line_no === '') line.line_no = i + 1;
      if (raw['EAN code'] !== undefined) {
        used.add('EAN code');
        line.ean = raw['EAN code'].replace(/\D/g, '');
        line.channel_sku_code = line.ean;
      }
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"EAN code"', 'channel_sku_code'));
      line.gst = lineGst(raw, used, where, po.warnings);
      if (typeof line.unit_cost === 'number' && typeof line.gst === 'number') line.landing_rate = round2(line.unit_cost * (1 + line.gst / 100));
      if (line.line_total === '' && typeof line.qty === 'number' && typeof line.landing_rate === 'number') line.line_total = round2(line.qty * line.landing_rate);
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.channel_sku_code'] = 'raw (EAN code)';
    po.field_sources['line_items.landing_rate'] = 'calculated (Rate x (1 + GST %))';

    // 4. Totals: the PO's totals row, else the lines' sums; checked against the lines.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtySum = sum(po.line_items.map((l) => l.qty));
    const valueSum = sum(po.line_items.map((l) => l.line_total));
    po.total_qty = totalQty !== '' ? totalQty : qtySum ?? '';
    po.field_sources.total_qty = totalQty !== '' ? 'raw (totals row)' : po.total_qty === '' ? '' : 'calculated';
    po.po_value = totalAmount !== '' ? totalAmount : valueSum ?? '';
    po.field_sources.po_value = totalAmount !== '' ? 'raw (totals row)' : po.po_value === '' ? '' : 'calculated';
    if (totalQty !== '' && qtySum !== null && Math.abs(qtySum - totalQty) > 0.001) {
      po.warnings.push(poWarning(WARNING_CODES.TOTAL_QTY_MISMATCH, 'Total QTY', totalQty, 'SUM(QTY)', qtySum));
    }
    if (totalAmount !== '' && valueSum !== null && Math.abs(valueSum - totalAmount) > POP_TECH_TOTAL_TOLERANCE) {
      po.warnings.push(poWarning(WARNING_CODES.PO_VALUE_MISMATCH, 'Total Amount', totalAmount, 'SUM(Amount)', valueSum));
    }
    po.unmapped = leftover(header, usedHeader);

    // 5. No discount on Pop Tech POs: cart_discount 0, net_amount = po_value.
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

/** IGST % when charged (inter-state), else SGST % + CGST % ("9.000%" each). */
const lineGst = (raw: Record<string, string>, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  const rate = (name: string): Num => {
    if (raw[name] === undefined) return '';
    used.add(name);
    return toNumber(raw[name].replace('%', ''), `${where} ${name}`, warnings);
  };
  const igst = rate('IGST Rate');
  const sgst = rate('SGST Rate');
  const cgst = rate('CGST Rate');
  if (typeof igst === 'number' && igst > 0) return igst;
  if (typeof sgst === 'number' && typeof cgst === 'number') return round2(sgst + cgst);
  warnings.push(poWarning(WARNING_CODES.GST_COLUMNS_MISSING, where, '"SGST Rate" + "CGST Rate" or "IGST Rate"'));
  return '';
};

/** The sum rounded to paise, or null when any value is missing. */
const sum = (values: Num[]): number | null =>
  values.length && values.every((v) => typeof v === 'number') ? round2(values.reduce((a, v) => a + v, 0)) : null;
