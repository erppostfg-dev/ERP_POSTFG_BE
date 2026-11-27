import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS, ISSUE_FIELDS } from '../../src/constants';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { closeDb, db, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';

/*
 * Amazon sends no price (2026-11-27, prod: 70 FBA shipments stuck on "no unit price" after their FNSKUs were added to
 * the master a day later). A line with no price on a MASTER_PRICE_CHANNELS channel takes our master rate in the check,
 * so a master fix + re-check completes the PO. Other channels still report the missing price.
 * The seeded master (rate 349.30) stands in for the Amazon one; only the channel name on the PO decides the rule.
 */
let m: Masters;

const noPricePo = (channel: string) => {
  const base = bigBasketPo(m);
  return { ...bigBasketPo(m, { line_items: [{ ...base.line_items[0], landing_rate: '', unit_cost: '', line_total: '' }] }), channel_name: channel };
};
const check = async (channel: string) => {
  const r = await validatePo(noPricePo(channel), await new MasterDataReader(await db()).forChannel(CHANNELS.BIGBASKET), new Date('2026-10-28T06:00:00Z'));
  return { r, priceIssues: r.issues.filter((i) => i.field === ISSUE_FIELDS.UNIT_PRICE) };
};

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
});
afterAll(closeDb);

describe('a channel that sends no price (Amazon)', () => {
  it('a mapped line with no price takes our master rate: no "price missing", sale order at our rate', async () => {
    const { r, priceIssues } = await check(CHANNELS.AMAZON);
    expect(priceIssues).toEqual([]);
    expect(r.lines[0]).toMatchObject({ poUnitPrice: 349.3, ourRate: 349.3 });
    expect(r.lines[0].poLineValue).toBeCloseTo(3493, 2);
  });

  it('any other channel still reports the missing price', async () => {
    const { priceIssues } = await check(CHANNELS.BIGBASKET);
    expect(priceIssues).toHaveLength(1);
  });
});
