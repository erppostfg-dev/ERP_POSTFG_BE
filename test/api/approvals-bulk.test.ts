import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessedLine } from '../../src/modules/po-processing/common/processed-po';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { approveAllMargins } from '../helpers/margins';
import { covers } from '../helpers/routes';

/*
 * Approvals list + bulk decisions (user 2026-11-02): each item says its kind (review = only this PO changes;
 * master_update = a price check line updates our master on approval) and the errors the reviewer fixed; Filters
 * (channel, kind, error fixed, submitted by, submitted from / to) work on the server; approvers approve or reject
 * several at once, each exactly like the single action, with a confirmation needed when one updates the master.
 */
covers(['POST /approvals/po-reviews/bulk-approve', 'POST /approvals/po-reviews/bulk-reject']);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;

/** In Review for its delivery location (fixed by picking the seeded location). */
const locationPo = (poNumber: string) => runPo(bigBasketPo(m, { po_number: poNumber, delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
/** In Review for a price + MRP difference on line 1 (Rs 360 / MRP 520 vs our 349.30 / 499). */
const pricedPo = (poNumber: string) => {
  const base = bigBasketPo(m).line_items[0];
  const line: ProcessedLine = { ...base, landing_rate: 360, line_total: 3600, channel_mrp: 520 };
  return runPo(bigBasketPo(m, { po_number: poNumber, line_items: [line] }));
};
const submit = (u: Upload, body: Record<string, unknown>) => api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', reviewer.cookie).send(body).expect(200);
const fixLocation = (u: Upload) => submit(u, { location: { detailsChannelId: m.locationId }, remark: 'right DC' });
const takeChannelPrice = (u: Upload, updateMaster: boolean) => submit(u, { lines: [{ lineNo: '1', priceFrom: 'channel', mrpFrom: 'channel', updateMaster }] });
const subId = async (u: Upload) => (await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ? ORDER BY id DESC LIMIT 1', [u.id]))[0].id;
const list = (query = '') => api().get(`${V}/approvals/po-reviews?status=pending${query}`).set('Cookie', admin.cookie);
const bulk = (action: 'bulk-approve' | 'bulk-reject', body: Record<string, unknown>, who = admin) =>
  api().post(`${V}/approvals/po-reviews/${action}`).set('Cookie', who.cookie).send(body);
const statusOf = async (u: Upload) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status;
const masterRate = async () => (await rows<{ rate_after_margin: string }>('SELECT rate_after_margin FROM master_channel_skus WHERE id = ?', [m.channelSkuId]))[0].rate_after_margin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('Approvals list: kind, errors fixed, filters', () => {
  it('each item says review / master_update and which errors were fixed; the Filters panel gets its choices', async () => {
    const a = await locationPo('IRA92000001');
    const b = await pricedPo('IRA92000002');
    const c = await pricedPo('IRA92000003');
    await fixLocation(a);
    await takeChannelPrice(b, true);
    await takeChannelPrice(c, false);
    const res = await list().expect(200);
    const byPo = Object.fromEntries(res.body.data.map((x: { poNumber: string }) => [x.poNumber, x]));
    expect(byPo.IRA92000001).toMatchObject({ kind: 'review', masterUpdates: 0, fixedIssues: [{ type: 'LOCATION_NOT_MAPPED', fixed: 1, accepted: 0 }] });
    expect(byPo.IRA92000002).toMatchObject({ kind: 'master_update', masterUpdates: 2 });
    // the price / MRP differences, and the PO total they caused
    expect(byPo.IRA92000002.fixedIssues.map((i: { type: string }) => i.type).sort()).toEqual(['MRP_MISMATCH', 'PRICE_MISMATCH', 'TOTAL_MISMATCH']);
    expect(byPo.IRA92000003).toMatchObject({ kind: 'review', masterUpdates: 0 });
    expect(res.body.meta.filterOptions).toEqual({ channels: ['BigBasket'], submitters: [expect.objectContaining({ email: reviewer.email })] });
  });

  it('filters on the server: kind, error fixed, channel, submitted by, submitted from / to; bad values refused', async () => {
    const a = await locationPo('IRA92000011');
    const b = await pricedPo('IRA92000012');
    await fixLocation(a);
    await takeChannelPrice(b, true);
    const pos = async (q: string) => (await list(q).expect(200)).body.data.map((x: { poNumber: string }) => x.poNumber).sort();
    expect(await pos('&kind=master_update')).toEqual(['IRA92000012']);
    expect(await pos('&kind=review')).toEqual(['IRA92000011']);
    expect(await pos('&issue=LOCATION_NOT_MAPPED')).toEqual(['IRA92000011']);
    expect(await pos('&issue=PRICE_MISMATCH')).toEqual(['IRA92000012']);
    expect(await pos('&channel=BigBasket')).toEqual(['IRA92000011', 'IRA92000012']);
    expect(await pos('&channel=Zepto')).toEqual([]);
    expect(await pos('&channel=Zepto,BigBasket')).toEqual(['IRA92000011', 'IRA92000012']);
    expect(await pos('&issue=LOCATION_NOT_MAPPED,MRP_MISMATCH')).toEqual(['IRA92000011', 'IRA92000012']);
    expect(await pos(`&submittedBy=${encodeURIComponent(reviewer.email)}`)).toEqual(['IRA92000011', 'IRA92000012']);
    expect(await pos('&submittedBy=nobody%40mcaffeine.com')).toEqual([]);
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    expect(await pos(`&from=${today}&to=${today}`)).toHaveLength(2);
    expect(await pos('&to=2026-01-01')).toEqual([]);
    const bad = await list('&kind=other&from=2026-13-40&to=2026-01-01').expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['from', 'kind']);
  });
});

describe('bulk approve', () => {
  it('only approvers; ids must be 1..50 submission ids', async () => {
    const a = await locationPo('IRA92000021');
    await fixLocation(a);
    const id = await subId(a);
    expect((await bulk('bulk-approve', { ids: [id] }, reviewer)).status).toBe(403);
    for (const ids of [undefined, [], ['x'], Array.from({ length: 51 }, (_, i) => String(i + 1))]) {
      const res = await bulk('bulk-approve', { ids });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('ids');
    }
    expect((await bulk('bulk-approve', { ids: [id], confirmMasterUpdates: 'yes' })).status).toBe(400);
    expect(await statusOf(a)).toBe('pending_approval');
  });

  it('approves the selected ones one after another: each gets its PO + sale order, like the single Approve', async () => {
    const a = await locationPo('IRA92000031');
    const b = await locationPo('IRA92000032');
    await fixLocation(a);
    await fixLocation(b);
    const res = await bulk('bulk-approve', { ids: [await subId(a), await subId(b)], remark: 'checked' }).expect(200);
    expect(res.body.data.map((r: { poNumber: string; result: string }) => [r.poNumber, r.result])).toEqual([['IRA92000031', 'approved'], ['IRA92000032', 'approved']]);
    expect(res.body.data.every((r: { saleOrderCode: string }) => /^erp_\d{11}$/.test(r.saleOrderCode))).toBe(true);
    expect([await statusOf(a), await statusOf(b)]).toEqual(['completed', 'completed']);
    expect(await count('master_purchase_orders')).toBe(2);
    expect(await rows('SELECT status, decision_remark FROM po_review_submissions ORDER BY id')).toEqual([
      { status: 'approved', decision_remark: 'checked' }, { status: 'approved', decision_remark: 'checked' },
    ]);
  });

  it('one that updates the master needs the confirmation: refused first (nothing approved), then approved and the master changes', async () => {
    const a = await locationPo('IRA92000041');
    const b = await pricedPo('IRA92000042');
    await fixLocation(a);
    await takeChannelPrice(b, true);
    const ids = [await subId(a), await subId(b)];
    const refused = await bulk('bulk-approve', { ids }).expect(409);
    expect(refused.body.error.code).toBe('MASTER_UPDATE_NOT_CONFIRMED');
    expect(refused.body.error.details.ids).toEqual([ids[1]]);
    expect([await statusOf(a), await statusOf(b)]).toEqual(['pending_approval', 'pending_approval']);
    expect(await masterRate()).toBe('349.30');
    const ok = await bulk('bulk-approve', { ids, confirmMasterUpdates: true }).expect(200);
    expect(ok.body.data.map((r: { result: string }) => r.result)).toEqual(['approved', 'approved']);
    // the rate waits for the two margin approvals (2026-11-06), then it is the PO's
    expect(await masterRate()).toBe('349.30');
    expect(await approveAllMargins()).toBe(1);
    expect(await masterRate()).toBe('360.00');
  });

  it('one that no longer passes goes back to In Review by itself; one already decided fails; the others are approved', async () => {
    const a = await locationPo('IRA92000051');
    const b = await locationPo('IRA92000052');
    const c = await locationPo('IRA92000053');
    for (const u of [a, b, c]) await fixLocation(u);
    const [ia, ib, ic] = [await subId(a), await subId(b), await subId(c)];
    await bulk('bulk-approve', { ids: [ic] }).expect(200);
    expect((await bulk('bulk-approve', { ids: [ia] }).expect(200)).body.data[0].result).toBe('approved');
    // the SKU switched off on the Masters page after b was submitted: b no longer passes
    const conn = await db();
    await conn.query('UPDATE master_channel_skus SET is_active = 0 WHERE id = ?', [m.channelSkuId]);
    const res = await bulk('bulk-approve', { ids: [ib, ic] }).expect(200);
    expect(res.body.data.map((r: { id: string; result: string }) => [r.id, r.result])).toEqual([[ib, 'returned'], [ic, 'failed']]);
    expect(res.body.data[0].message).toContain('no longer passes');
    expect(res.body.data[1].message).toContain('not pending');
    expect(await statusOf(b)).toBe('needs_review');
  });
});

describe('bulk reject', () => {
  it('needs a reason; rejects every selected one with it', async () => {
    const a = await locationPo('IRA92000061');
    const b = await locationPo('IRA92000062');
    await fixLocation(a);
    await fixLocation(b);
    const ids = [await subId(a), await subId(b)];
    expect((await bulk('bulk-reject', { ids })).status).toBe(400);
    expect((await bulk('bulk-reject', { ids, remark: 'duplicate' }, reviewer)).status).toBe(403);
    const res = await bulk('bulk-reject', { ids, remark: 'duplicate POs' }).expect(200);
    expect(res.body.data.map((r: { result: string }) => r.result)).toEqual(['rejected', 'rejected']);
    expect([await statusOf(a), await statusOf(b)]).toEqual(['rejected', 'rejected']);
    expect(await rows('SELECT status, decision_remark FROM po_review_submissions ORDER BY id')).toEqual([
      { status: 'rejected', decision_remark: 'duplicate POs' }, { status: 'rejected', decision_remark: 'duplicate POs' },
    ]);
  });
});
