import { CHANNELS, PoWarning, poWarning, WARNING_CODES } from '../../../../constants';
import { noDiscountAmounts } from '../../common/amounts';
import { applyMapping, emptyLine, leftover } from '../../common/apply-mapping';
import { ourNames } from '../../common/our-names';
import { text, toDate, toNumber } from '../../common/parse';
import { Num, ProcessedPo } from '../../common/processed-po';
import { basePo, ChannelHandler, finishSources, PoContext } from '../channel-handler';
import { NOBLE_ADDRESS_END, NOBLE_DATE_ORDER, NOBLE_LINE_NAMES, NOBLE_MAPPING } from './noble-chemist.mapping';

/**
 * Noble Chemist's route (2026-11-05): its order form (.xls, our sheet reader, no OCR) -> processed.json. Manual Upload
 * only (user). Order no. + date from the title rows; SKU by the EAN (COMP UPC); no price on the form (our rate), MRP
 * checked; the channel's only location.
 */
export const nobleChemistHandler: ChannelHandler = {
  channel: CHANNELS.NOBLE_CHEMIST,

  async process(ctx: PoContext): Promise<ProcessedPo> {
    const po = basePo(ctx);
    const title = ctx.raw.header;

    // 1. Header from the title rows: "DATE : 15 Oct 2026 Order No :88699", the buyer + its address.
    const dateOrder = Object.values(title).map((v) => NOBLE_DATE_ORDER.exec(v)).find(Boolean);
    if (dateOrder) {
      po.po_number = dateOrder[2].trim();
      po.field_sources.po_number = 'raw (title row: Order No)';
      po.po_date = toDate(dateOrder[1], 'DATE', po.warnings);
      po.field_sources.po_date = po.po_date ? 'raw (title row: DATE)' : '';
    } else {
      po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, 'header', '"DATE : ... Order No : ..." title row', 'po_number'));
    }
    const address = text((title['Line 2'] ?? '').split(NOBLE_ADDRESS_END)[0]);
    po['shipping address'] = [title['Line 1'], address].filter(Boolean).join(', ');
    po.field_sources['shipping address'] = po['shipping address'] ? 'raw (title rows 1-2)' : '';

    // 2. No email; no revision signal on the form.
    po.revised = false;
    po.field_sources.revised = '';
    po.field_sources.revision_of = '';

    // 3. Lines: EAN = the channel code; QTY. ordered + FREE on top (charged = QTY.); no price (our rate).
    po.line_items = ctx.raw.lines.map((rawLine, i) => {
      const where = `line ${i + 1}`;
      const raw = ourNames(rawLine, NOBLE_LINE_NAMES);
      const line = emptyLine();
      const used = applyMapping(line, raw, NOBLE_MAPPING.line, po.warnings, where);
      line.line_no = i + 1;
      if (raw['COMP UPC'] !== undefined) {
        used.add('COMP UPC');
        line.ean = raw['COMP UPC'].replace(/\.0+$/, '').replace(/\D/g, '');
        line.channel_sku_code = line.ean;
      }
      if (!line.channel_sku_code) po.warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, '"COMP UPC"', 'channel_sku_code'));
      const qty = count(raw, 'QTY.', used, where, po.warnings);
      const free = count(raw, 'FREE', used, where, po.warnings);
      // qty = every unit sent (ordered + free), free_qty = the free ones: the sale order charges QTY. only
      line.qty = typeof qty === 'number' ? qty + (typeof free === 'number' ? free : 0) : '';
      line.free_qty = typeof free === 'number' && free > 0 ? free : '';
      line.unmapped = leftover(raw, used);
      return line;
    });
    po.field_sources['line_items.channel_sku_code'] = 'raw (COMP UPC = EAN)';

    // 4. Totals: no price on the form, so no PO value (the sale order uses our rate); total qty = the lines' sum.
    po.total_line_items = po.line_items.length || '';
    po.field_sources.total_line_items = po.total_line_items === '' ? '' : 'calculated';
    const qtys = po.line_items.map((l) => l.qty).filter((q): q is number => typeof q === 'number');
    po.total_qty = qtys.length && qtys.length === po.line_items.length ? qtys.reduce((a, q) => a + q, 0) : '';
    po.field_sources.total_qty = po.total_qty === '' ? '' : 'calculated';
    po.unmapped = Object.fromEntries(Object.entries(title).filter(([, v]) => !NOBLE_DATE_ORDER.test(v)));

    noDiscountAmounts(po);
    finishSources(po);
    return po;
  },
};

/** A quantity cell: "-" or empty = none (""). */
const count = (raw: Record<string, string>, name: string, used: Set<string>, where: string, warnings: PoWarning[]): Num => {
  if (raw[name] === undefined) return '';
  used.add(name);
  const v = raw[name].trim();
  if (!v || v === '-') return '';
  return toNumber(v, `${where} ${name}`, warnings);
};
