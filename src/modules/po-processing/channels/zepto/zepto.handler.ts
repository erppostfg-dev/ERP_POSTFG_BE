import { CHANNELS } from '../../../../constants/channels';
import { applyMapping, emptyLine, leftover } from '../../common/apply-mapping';
import { gstRate } from '../../common/gst';
import { pincodeFrom } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, PoContext } from '../channel-handler';
import { ZEPTO_GST_COLUMNS, ZEPTO_MAPPING } from './zepto.mapping';

/**
 * Zepto's route. Today: raw OCR output -> processed.json.
 * Later: Zepto's DB save, location match on delivery_facility_code (StoreName), SKU match on the Sku UUID, checks.
 */
export const zeptoHandler: ChannelHandler = {
  channel: CHANNELS.ZEPTO,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);
    const first = ctx.raw.lines[0] ?? {};

    // Header: three fields from the PDF, the rest from the CSV's first line (it repeats them on every line).
    const usedHeader = applyMapping(po, ctx.raw.header, ZEPTO_MAPPING.header, po.warnings, 'header');
    const fromLine = applyMapping(po, first, ZEPTO_MAPPING.headerFromLine ?? [], po.warnings, 'header (CSV)');
    po.type_delivery_facility = ''; // Zepto sends no facility type; StoreName is only the location code
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, ZEPTO_MAPPING.line, po.warnings, where);
      line.gst = gstRate(raw, ZEPTO_GST_COLUMNS, used, where, po.warnings);
      fromLine.forEach((k) => used.add(k)); // PO details repeated on every line: already in the header
      line.unmapped = leftover(raw, used);
      return line;
    });

    // Zepto sends no totals block: total_qty = SUM(qty), total_line_items = LineNumber of the last line.
    const qtys = po.line_items.map((l) => l.qty);
    po.total_qty = qtys.length && qtys.every((q) => typeof q === 'number') ? (qtys as number[]).reduce((a, q) => a + q, 0) : '';
    po.total_line_items = po.line_items.length ? po.line_items[po.line_items.length - 1].line_no : '';

    return po;
  },
};
