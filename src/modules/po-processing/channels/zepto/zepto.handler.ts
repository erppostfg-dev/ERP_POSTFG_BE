import { CHANNELS } from '../../../../constants/channels';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { noDiscountAmounts } from '../../common/amounts';
import { applyEmailSources } from '../../common/email-sources';
import { gstRate } from '../../common/gst';
import { pincodeFrom } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { ZEPTO_EMAIL, ZEPTO_GST_COLUMNS, ZEPTO_MAPPING } from './zepto.mapping';

/**
 * Zepto's route. Today: raw OCR output (+ email body and subject) -> processed.json.
 * Later: Zepto's DB save, location match on delivery_facility_code (StoreName), SKU match on the Sku UUID, checks.
 */
export const zeptoHandler: ChannelHandler = {
  channel: CHANNELS.ZEPTO,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);
    const first = ctx.raw.lines[0] ?? {};

    // 1. Header from the raw OCR output: three fields from the PDF, the rest from the CSV's first line
    //    (Zepto's CSV repeats the PO details on every line).
    const usedHeader = applyMapping(po, ctx.raw.header, ZEPTO_MAPPING.header, po.warnings, 'header');
    const fromLine = applyMapping(po, first, ZEPTO_MAPPING.headerFromLine ?? [], po.warnings, 'header (CSV)');
    markRawSources(po, [...ZEPTO_MAPPING.header, ...(ZEPTO_MAPPING.headerFromLine ?? [])]);
    po.type_delivery_facility = ''; // Zepto sends no facility type; StoreName is only the location code
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. Email body and subject: cross-check, and fill what the raw output lacks.
    applyEmailSources(po, ctx.body, ctx.subject, ZEPTO_EMAIL);

    // 3. Zepto has no revision signal seen so far.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 4. Line items: always from the raw OCR output.
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, ZEPTO_MAPPING.line, po.warnings, where);
      line.gst = gstRate(raw, ZEPTO_GST_COLUMNS, used, where, po.warnings);
      fromLine.forEach((k) => used.add(k)); // PO details repeated on every line: already in the header
      line.unmapped = leftover(raw, used);
      return line;
    });

    // 5. Zepto sends no totals block: total_qty = SUM(qty), total_line_items = LineNumber of the last line.
    const qtys = po.line_items.map((l) => l.qty);
    po.total_qty = qtys.length && qtys.every((q) => typeof q === 'number') ? (qtys as number[]).reduce((a, q) => a + q, 0) : '';
    po.total_line_items = po.line_items.length ? po.line_items[po.line_items.length - 1].line_no : '';
    po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';

    // 6. Zepto POs have no discount: cart_discount 0, net_amount = po_value (calculated).
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};
