import { CHANNELS } from '../../../../constants/channels';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { applyEmailSources } from '../../common/email-sources';
import { gstRate } from '../../common/gst';
import { pincodeFrom } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext, revisionOf } from '../channel-handler';
import { BLINKIT_EMAIL, BLINKIT_GST_COLUMNS, BLINKIT_MAPPING, BLINKIT_REVISED } from './blinkit.mapping';

/**
 * Blinkit's route. Today: raw OCR output (+ email body and subject) -> processed.json.
 * Later: Blinkit's DB save, location match on delivery_facility_code, SKU match, price checks.
 */
export const blinkitHandler: ChannelHandler = {
  channel: CHANNELS.BLINKIT,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the raw OCR output (the main source).
    const usedHeader = applyMapping(po, ctx.raw.header, BLINKIT_MAPPING.header, po.warnings, 'header');
    markRawSources(po, BLINKIT_MAPPING.header);
    po.type_delivery_facility = ''; // Blinkit's OCR output has no facility type
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. Email body and subject: cross-check, and fill what the raw output lacks.
    applyEmailSources(po, ctx.body, ctx.subject, BLINKIT_EMAIL);

    // 3. A revised PO says so only in the body ("This Purchase Order has been REVISED"); po_type stays as the raw says.
    po.revised = BLINKIT_REVISED.test(ctx.body);
    po.field_sources.revised = ctx.body ? 'body' : '';
    po.revision_of = po.revised ? revisionOf(ctx) : '';
    po.field_sources.revision_of = po.revision_of ? 's3' : '';

    // 4. Line items: always from the raw OCR output.
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, BLINKIT_MAPPING.line, po.warnings, where);
      line.gst = gstRate(raw, BLINKIT_GST_COLUMNS, used, where, po.warnings);
      line.unmapped = leftover(raw, used);
      return line;
    });

    finishSources(po);
    return po;
  },
};
