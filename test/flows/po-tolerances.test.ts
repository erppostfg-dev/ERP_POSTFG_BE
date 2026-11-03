import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/constants';
import type { ProcessedLine } from '../../src/modules/po-processing/common/processed-po';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { closeDb, db, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';

/*
 * The allowed differences (2026-10-29, user): MRP and unit price +/- Rs 1 per SKU (was 2); the PO total 0.02% of the
 * value, at least Rs 10 (was a flat 10: Reliance 5000501376 went to review for -19.52 on 15 lakh, only paisa rounding).
 * Seeded master: MRP 499, rate 349.30; the clean PO = 10 x 349.30 = 3,493.00.
 */
let m: Masters;

const check = async (line: Partial<ProcessedLine>) => {
  const base = bigBasketPo(m);
  const po = bigBasketPo(m, { line_items: [{ ...base.line_items[0], ...line }] });
  const r = await validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.BIGBASKET), new Date('2026-10-28T06:00:00Z'));
  return { types: r.issues.map((i) => i.type), text: r.issues.map((i) => i.message).join(' | '), r };
};

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
});
afterAll(closeDb);

describe('per SKU: +/- Rs 1', () => {
  it('MRP: within Rs 1 either way passes (paisa too), more goes to review', async () => {
    for (const mrp of [499.35, 500, 498, 499.99]) expect((await check({ channel_mrp: mrp })).types).toEqual([]);
    for (const mrp of [500.01, 497.99, 501]) expect((await check({ channel_mrp: mrp })).types).toEqual(['MRP_MISMATCH']);
    expect((await check({ channel_mrp: 500.5 })).text).toContain('allowed +/-1.00');
  });

  it('unit price (with tax): within Rs 1 either way passes, more goes to review', async () => {
    for (const rate of [349.29, 350.3, 348.3]) expect((await check({ landing_rate: rate, line_total: rate * 10 })).types).not.toContain('PRICE_MISMATCH');
    for (const rate of [350.31, 348.29]) expect((await check({ landing_rate: rate, line_total: rate * 10 })).types).toContain('PRICE_MISMATCH');
  });
});

describe('PO total: 0.02% of the value, at least Rs 10', () => {
  it('a small PO keeps Rs 10', async () => {
    expect((await check({ line_total: 3483 })).types).toEqual([]); // -10.00
    const over = await check({ line_total: 3482.99 }); // -10.01
    expect(over.types).toEqual(['TOTAL_MISMATCH']);
    expect(over.text).toContain('allowed +/-10.00');
  });

  it('a big PO: paisa rounding over big quantities passes, a real difference does not', async () => {
    // 10,000 x 349.30 = 34,93,000.00 -> 0.02% = Rs 698.60
    expect((await check({ qty: 10000, line_total: 3493000 - 698.6 })).types).toEqual([]);
    const over = await check({ qty: 10000, line_total: 3493000 - 698.61 });
    expect(over.types).toEqual(['TOTAL_MISMATCH']);
    expect(over.text).toContain('allowed +/-698.60');
    expect(over.r.totals).toMatchObject({ ourValue: 3493000, difference: -698.61 });
  });
});
