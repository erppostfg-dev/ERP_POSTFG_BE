import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { applyEmailSources } from '../../common/email-sources';
import { gstRate } from '../../common/gst';
import { pincodeFrom, text } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { SCOOTSY_EMAIL, SCOOTSY_GST_COLUMNS, SCOOTSY_MAPPING, SCOOTSY_SHIPPING_NAME } from './scootsy.mapping';

/**
 * Scootsy's route. Today: raw OCR output (+ email subject and body) -> processed.json.
 * Later: Scootsy's DB save, location match on delivery_facility_code (e.g. JAI IM1), SKU match on Item Code, checks.
 */
export const scootsyHandler: ChannelHandler = {
  channel: CHANNELS.SCOOTSY,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the raw OCR output (the main source).
    const usedHeader = applyMapping(po, ctx.raw.header, SCOOTSY_MAPPING.header, po.warnings, 'header');
    markRawSources(po, SCOOTSY_MAPPING.header);
    po.type_delivery_facility = ''; // Scootsy sends no facility type
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. Email subject and body: the facility code comes from the subject (the user's choice), the PO number is
    //    cross-checked with both.
    applyEmailSources(po, ctx.body, ctx.subject, SCOOTSY_EMAIL);

    // 3. Cross-check the facility with the raw Shipping Name when it carries one ("... LIMITED Jai IM1"; case-insensitive).
    const shipName = SCOOTSY_SHIPPING_NAME.exec(ctx.raw.header['Shipping Name'] ?? '');
    const rawFacility = text(shipName?.[1]);
    if (rawFacility && po.delivery_facility_code) {
      const ok = rawFacility.toLowerCase() === po.delivery_facility_code.toLowerCase();
      po.cross_checks.push({ field: 'delivery_facility_code', against: 'subject', raw: rawFacility, value: po.delivery_facility_code, result: ok ? 'match' : 'mismatch' });
      if (!ok) po.warnings.push(poWarning(WARNING_CODES.FACILITY_MISMATCH, rawFacility, po.delivery_facility_code));
    }

    // 4. No revision signal seen for Scootsy.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 5. Line items from the raw OCR output; landing_rate = Total (INR) / Qty (no landing price column).
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, SCOOTSY_MAPPING.line, po.warnings, where);
      line.gst = gstRate(raw, SCOOTSY_GST_COLUMNS, used, where, po.warnings);
      if (typeof line.line_total === 'number' && typeof line.qty === 'number' && line.qty > 0) {
        line.landing_rate = Math.round((line.line_total / line.qty) * 100) / 100;
      }
      line.unmapped = leftover(raw, used);
      return line;
    });
    if (po.line_items.some((l) => l.landing_rate !== '')) po.field_sources['line_items.landing_rate'] = 'calculated';

    // 6. Totals: last S. No and SUM(Qty), calculated; no discount (cart_discount 0, net_amount = po_value).
    po.total_line_items = po.line_items.length ? po.line_items[po.line_items.length - 1].line_no : '';
    const qtys = po.line_items.map((l) => l.qty);
    po.total_qty = qtys.length && qtys.every((q) => typeof q === 'number') ? (qtys as number[]).reduce((a, q) => a + q, 0) : '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};
