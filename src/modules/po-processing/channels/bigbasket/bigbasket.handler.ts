import { CHANNELS, poWarning, WARNING_CODES } from '../../../../constants';
import { applyMapping, emptyLine, leftover, markRawSources } from '../../common/apply-mapping';
import { noDiscountAmounts } from '../../common/amounts';
import { applyEmailSources } from '../../common/email-sources';
import { pincodeFrom } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { BIGBASKET_EMAIL, BIGBASKET_MAPPING, BIGBASKET_PO_TYPES } from './bigbasket.mapping';

/** SUM of a numeric line field, rounded to paise; "" when any line lacks it. */
const sum = (values: Num[]): Num =>
  values.length && values.every((v) => typeof v === 'number')
    ? Math.round((values as number[]).reduce((a, v) => a + v, 0) * 100) / 100
    : '';

/**
 * BigBasket's route. Today: raw OCR output (+ email body and subject) -> processed.json.
 * Later: BigBasket's DB save, location match on delivery_facility_code (WMS-…-FC), SKU match, checks;
 * MANUAL-PO needs a slot booked on BigBasket's portal.
 */
export const bigbasketHandler: ChannelHandler = {
  channel: CHANNELS.BIGBASKET,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    // 1. Header from the raw OCR output (the main source).
    const usedHeader = applyMapping(po, ctx.raw.header, BIGBASKET_MAPPING.header, po.warnings, 'header');
    markRawSources(po, BIGBASKET_MAPPING.header);
    po.type_delivery_facility = ''; // BigBasket sends no facility type
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    if (po.delivery_pincode) po.field_sources.delivery_pincode = 'raw (from address)';
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    // 2. PO type from the PO number prefix (IRA = AUTO-PO, IRM = MANUAL-PO); unknown prefix: "" and a warning.
    const prefix = po.po_number.slice(0, 3).toUpperCase();
    po.po_type = BIGBASKET_PO_TYPES[prefix] ?? '';
    po.field_sources.po_type = po.po_type ? 'calculated' : '';
    if (po.po_number && !po.po_type) po.warnings.push(poWarning(WARNING_CODES.PO_TYPE_UNKNOWN, prefix, CHANNELS.BIGBASKET));

    // 3. Email body and subject: cross-check, and fill what the raw output lacks.
    applyEmailSources(po, ctx.body, ctx.subject, BIGBASKET_EMAIL);

    // 4. No revision signal seen for BigBasket.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 5. Line items: always from the raw OCR output.
    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, BIGBASKET_MAPPING.line, po.warnings, where);
      line.unmapped = leftover(raw, used);
      return line;
    });

    // 6. No totals in the raw output: total_qty = SUM(qty), po_value = SUM(line_total)
    //    (what the Excel's own Total-row formulas compute).
    po.total_qty = sum(po.line_items.map((l) => l.qty));
    po.po_value = sum(po.line_items.map((l) => l.line_total));
    po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
    po.field_sources.po_value = po.po_value === '' ? '' : 'calculated';

    // 7. BigBasket POs have no discount: cart_discount 0, net_amount = po_value (calculated).
    noDiscountAmounts(po);

    finishSources(po);
    return po;
  },
};
