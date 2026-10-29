import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forgetPoIssues } from '../../src/modules/po-issues/po-issues.cache';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * PO issues per channel (2026-10-28; a PO Processing & Review tab since 2026-10-29, for everyone with that page):
 * counts from what is stored (no table of its own),
 * once per PO. POs come from the real chain: one clean, two with an unknown delivery location.
 */
covers(['GET /po-review/issues', 'GET /po-review/issues/pos']);

const V = '/api/v1/po-review/issues';
let m: Masters;
let admin: TestLogin;

beforeEach(async () => {
  await resetDb();
  forgetPoIssues();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

describe('PO issues', () => {
  it('everyone who can open PO Processing & Review sees it (viewer is enough); nobody else', async () => {
    expect((await api().get(V)).status).toBe(401);
    for (const role of ['viewer', 'operations-executive', 'operations-manager', 'admin']) {
      const who = await loginAs(role);
      expect((await api().get(V).set('Cookie', who.cookie)).status, role).toBe(200);
      expect((await api().get(`${V}/pos?channel=BigBasket&kind=SKU_NOT_MAPPED&item=x`).set('Cookie', who.cookie)).status, role).toBe(200);
    }
    const nobody = await loginAs(null);
    expect((await api().get(V).set('Cookie', nobody.cookie)).status).toBe(403);
    // the old admin path is gone
    expect((await api().get('/api/v1/admin/po-issues').set('Cookie', admin.cookie)).status).toBe(404);
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

describe('shared answer and fresh downloads (2026-10-29: used by everyone; nobody downloads stale data)', () => {
  type Item = { item: string; pos: number; state: string; note: string };
  const skuItem = (data: { channels: { channel: string; groups: { kind: string; items: Item[] }[] }[] }, code: string) =>
    data.channels.find((c) => c.channel === 'BigBasket')?.groups.find((g) => g.kind === 'SKU_NOT_MAPPED')?.items.find((i) => i.item === code);
  const unmappedPo = (po: string, code: string) =>
    runPo(bigBasketPo(m, { po_number: po, line_items: [{ ...bigBasketPo(m).line_items[0], channel_sku_code: code }] }));

  it('the screen answer is shared for a minute; a download (fresh=1) is always computed now', async () => {
    await unmappedPo('IRA93100001', 'BB-NEW-1');
    const first = (await api().get(`${V}?days=30`).set('Cookie', admin.cookie).expect(200)).body.data;
    const second = (await api().get(`${V}?days=30`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(first.cached).toBe(false);
    expect(second).toMatchObject({ cached: true, computedAt: first.computedAt });
    // a new PO arrives: the shared screen answer may still show the old count, a download never does
    await unmappedPo('IRA93100002', 'BB-NEW-1');
    expect(skuItem((await api().get(`${V}?days=30`).set('Cookie', admin.cookie)).body.data, 'BB-NEW-1')?.pos).toBe(1);
    const fresh = (await api().get(`${V}?days=30&fresh=1`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(fresh.cached).toBe(false);
    expect(skuItem(fresh, 'BB-NEW-1')?.pos).toBe(2);
  });

  it('a Masters change drops the shared answer at once: the SKU shows as fixed on the next load', async () => {
    await unmappedPo('IRA93100011', 'BB-NEW-2');
    const before = (await api().get(`${V}?days=30`).set('Cookie', admin.cookie)).body.data;
    expect(skuItem(before, 'BB-NEW-2')).toMatchObject({ state: 'open' });
    await api().post('/api/v1/masters/channel-skus').set('Cookie', admin.cookie).send({
      channelId: m.channelId, channelCode: 'BB-NEW-2', pepCode: m.pepCode, productName: 'x', brand: 'mCaffeine', mrp: 499, marginPercent: 30, rateAfterMargin: 349.3, eanCode: '8906000000017',
    }).expect(201);
    const after = (await api().get(`${V}?days=30`).set('Cookie', admin.cookie)).body.data;
    expect(after.cached).toBe(false);
    expect(skuItem(after, 'BB-NEW-2')).toMatchObject({ state: 'fixed' });
  });

  it('a review decision drops the shared answer too', async () => {
    const u = await unmappedPo('IRA93100021', 'BB-NEW-3');
    await api().get(`${V}?days=30`).set('Cookie', admin.cookie).expect(200);
    await api().post(`/api/v1/po-review/${u.id}/reject`).set('Cookie', admin.cookie).send({ remark: 'test' }).expect(200);
    const after = (await api().get(`${V}?days=30`).set('Cookie', admin.cookie)).body.data;
    expect(after.cached).toBe(false);
    expect(after.channels.find((c: { channel: string }) => c.channel === 'BigBasket').byStatus).toMatchObject({ rejected: 1 });
  });
});

