import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * PO issues per channel (2026-10-28; Users & Roles -> PO issues): counts from what is stored (no table of its own),
 * once per PO. POs come from the real chain: one clean, two with an unknown delivery location.
 */
covers(['GET /admin/po-issues', 'GET /admin/po-issues/pos']);

const V = '/api/v1/admin/po-issues';
let m: Masters;
let admin: TestLogin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

describe('PO issues', () => {
  it('admin / developer only', async () => {
    expect((await api().get(V)).status).toBe(401);
    const manager = await loginAs('operations-manager');
    expect((await api().get(V).set('Cookie', manager.cookie)).status).toBe(403);
  });

  it('counts POs by status and the kinds of problems per channel; the POs behind a count', async () => {
    await runPo(bigBasketPo(m, { po_number: 'IRA93000001' }));
    await runPo(bigBasketPo(m, { po_number: 'IRA93000002', delivery_facility_code: 'WMS-NOPE', delivery_pincode: '999991' }));
    await runPo(bigBasketPo(m, { po_number: 'IRA93000003', delivery_facility_code: 'WMS-NOPE', delivery_pincode: '999991' }));
    const res = await api().get(`${V}?days=365`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data.days).toBe(365);
    const bb = (res.body.data.channels as { channel: string; pos: number; withIssues: number; byStatus: Record<string, number>; groups: { kind: string; pos: number; items: { item: string; pos: number; state: string }[] }[] }[])
      .find((c) => c.channel === 'BigBasket')!;
    expect(bb).toMatchObject({ pos: 3, withIssues: 2, byStatus: { completed: 1, needs_review: 2 } });
    const loc = bb.groups.find((g) => g.kind === 'LOCATION_NOT_MAPPED')!;
    expect(loc.pos).toBe(2);
    expect(loc.items).toHaveLength(1);
    expect(loc.items[0]).toMatchObject({ pos: 2, state: 'open' });
    const pos = await api().get(`${V}/pos?channel=BigBasket&kind=LOCATION_NOT_MAPPED&item=${encodeURIComponent(loc.items[0].item)}&days=365`).set('Cookie', admin.cookie).expect(200);
    expect(pos.body.data.map((p: { poNumber: string }) => p.poNumber).sort()).toEqual(['IRA93000002', 'IRA93000003']);
  });

  it('the POs behind a count need channel, kind and item; an unknown window falls back to 30 days', async () => {
    const res = await api().get(`${V}/pos?channel=BigBasket&kind=LOCATION_NOT_MAPPED`).set('Cookie', admin.cookie).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((await api().get(`${V}?days=abc`).set('Cookie', admin.cookie).expect(200)).body.data.days).toBe(30);
  });
});
