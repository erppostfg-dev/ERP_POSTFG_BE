import { CHANNELS } from '../../../../constants/channels';
import { minus } from '../../common/amounts';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { applyEmailSources } from '../../common/email-sources';
import { pincodeFrom } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { FIRSTCRY_EMAIL, FIRSTCRY_MAPPING } from './firstcry.mapping';

/**
 * FirstCry's route. Today: raw OCR output (+ the subject) -> processed.json.
 * Later: FirstCry's DB save, location match on delivery_facility_code (the stockist), SKU match on FCID /
 * Style Code, checks (price checks on the billed quantity: qty - free_qty).
 */
export const firstcryHandler: ChannelHandler = {
  channel: CHANNELS.FIRSTCRY,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the raw OCR output (the main source).
    const usedHeader = applyMapping(po, ctx.raw.header, FIRSTCRY_MAPPING.header, po.warnings, 'header');
    markRawSources(po, FIRSTCRY_MAPPING.header);
    po.type_delivery_facility = ''; // FirstCry sends no facility type
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. Amounts (option B): po_value = before discount, net_amount = after, cart_discount = the difference.
    po.cart_discount = minus(po.po_value, po.net_amount);
    po.field_sources.cart_discount = po.cart_discount === '' ? '' : 'calculated';

    // 3. Email subject: cross-check, and fill what the raw output lacks (the body holds no PO data).
    applyEmailSources(po, ctx.body, ctx.subject, FIRSTCRY_EMAIL);

    // 4. No revision signal seen for FirstCry.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 5. Line items: always from the raw OCR output.
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, FIRSTCRY_MAPPING.line, po.warnings, where);
      line.unmapped = leftover(raw, used);
      return line;
    });

    // 6. No line count in the raw output: total_line_items = Sr.No. of the last line.
    po.total_line_items = po.line_items.length ? po.line_items[po.line_items.length - 1].line_no : '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';

    finishSources(po);
    return po;
  },
};
