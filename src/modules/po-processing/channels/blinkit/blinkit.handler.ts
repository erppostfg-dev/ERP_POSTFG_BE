import { CHANNELS } from '../../../../constants/channels';
import { applyMapping, emptyLine, leftover } from '../../common/apply-mapping';
import { gstRate } from '../../common/gst';
import { pincodeFrom } from '../../common/parse';
import { ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, PoContext } from '../channel-handler';
import { BLINKIT_GST_COLUMNS, BLINKIT_MAPPING } from './blinkit.mapping';

/**
 * Blinkit's route. Today: raw OCR output -> processed.json.
 * Later: Blinkit's DB save, location match on delivery_facility_code, SKU match, price checks.
 */
export const blinkitHandler: ChannelHandler = {
  channel: CHANNELS.BLINKIT,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);

    const usedHeader = applyMapping(po, ctx.raw.header, BLINKIT_MAPPING.header, po.warnings, 'header');
    po.type_delivery_facility = ''; // Blinkit's OCR output has no facility type
    po.delivery_pincode = pincodeFrom(po['shipping address']);
    po.unmapped = leftover(ctx.raw.header, usedHeader);

    po.line_items = ctx.raw.lines.map((raw, i) => {
      const where = `line ${i + 1}`;
      const line = emptyLine();
      const used = applyMapping(line, raw, BLINKIT_MAPPING.line, po.warnings, where);
      line.gst = gstRate(raw, BLINKIT_GST_COLUMNS, used, where, po.warnings);
      line.unmapped = leftover(raw, used);
      return line;
    });

    return po;
  },
};
