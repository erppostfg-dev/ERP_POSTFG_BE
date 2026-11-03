import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * Verify panel totals (2026-11-03, user: a Purplle PO showed Rs 1,57,307.20 on Processed but PO value 1,33,362.20 in
 * Verify): a PO priced BEFORE GST (unit cost, no landing rate) says so, and comes with its value with GST worked out as
 * the total check does, to compare with what was saved; each line's PO rate is with GST (its unit cost kept beside it).
 */

const V = '/api/v1';
beforeEach(resetDb);
afterAll(closeDb);

describe('a PO priced before GST', () => {
  it('basis before_gst, value with GST next to the saved value; lines show the rate with GST + the unit cost', async () => {
    const m = await seedMasters();
    const po = bigBasketPo(m, { po_number: 'IRA96000001', po_value: 2960.2, net_amount: 2960.2, field_sources: { po_value: 'calculated (before GST)' } });
    po.line_items[0] = { ...po.line_items[0], landing_rate: '', unit_cost: 296.02, line_total: 2960.2 };
    const u = await runPo(po);
    expect(u.status).toBe('completed');
    const reviewer = await loginAs('operations-executive');
    const d = (await api().get(`${V}/po-verify/${u.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d.totals.po).toMatchObject({ value: 2960.2, valueBasis: 'before_gst' });
    expect(d.totals.po.valueWithGst).toBeCloseTo(3493.04, 1);
    expect(d.totals.saved.value).toBe(3493);
    expect(d.lines[0].po).toMatchObject({ rateBeforeGst: 296.02 });
    expect(d.lines[0].po.rate).toBeCloseTo(349.3, 1);
    expect(d.lines[0].rateDiffers).toBe(false);
  });

  it('a PO with GST: basis with_gst, valueWithGst = its own value', async () => {
    const m = await seedMasters();
    const u = await runPo(bigBasketPo(m, { po_number: 'IRA96000002' }));
    const reviewer = await loginAs('operations-executive');
    const d = (await api().get(`${V}/po-verify/${u.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d.totals.po).toMatchObject({ valueBasis: 'with_gst', valueWithGst: d.totals.po.value });
    expect(d.lines[0].po.rateBeforeGst).toBeNull();
  });
});
