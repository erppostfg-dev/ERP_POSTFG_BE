import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * Two-layer approval of margin changes (2026-11-06, user): a channel SKU's margin % / rate after margin (Masters Edit)
 * and a new channel SKU row (Masters Add) wait as a request; layer 1 = Operations Manager, layer 2 = Admin; the
 * requester never approves their own; layer 1 and layer 2 are different people. Applied only at layer 2.
 * 2026-11-10 (user): a NEW channel SKU needs ONE approval (Operations Manager / admin / developer); edits keep two.
 */
covers(['GET /approvals/margin-changes', 'POST /approvals/margin-changes/:id/approve', 'POST /approvals/margin-changes/:id/reject']);

const V = '/api/v1/approvals/margin-changes';
const M = '/api/v1/masters';
let m: Masters;
let requester: TestLogin; // admin: may edit the masters
let manager: TestLogin; // layer 1
let admin2: TestLogin; // layer 2

const sku = async () => (await rows<{ margin: string; rate_after_margin: string; product_name: string }>('SELECT margin, rate_after_margin, product_name FROM master_channel_skus WHERE id = ?', [m.channelSkuId]))[0];
const editSku = (changes: Record<string, unknown>, who = requester) => api().patch(`${M}/edit/channel_sku/${m.channelSkuId}`).set('Cookie', who.cookie).send({ changes, remark: 'new margin from the KAM' });
const approve = (id: string, who: TestLogin, remark?: string) => api().post(`${V}/${id}/approve`).set('Cookie', who.cookie).send(remark ? { remark } : {});
const reject = (id: string, who: TestLogin, remark?: string) => api().post(`${V}/${id}/reject`).set('Cookie', who.cookie).send(remark ? { remark } : {});
const list = async (who: TestLogin, status = 'open') => (await api().get(`${V}?status=${status}`).set('Cookie', who.cookie).expect(200)).body.data;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  requester = await loginAs('admin');
  manager = await loginAs('operations-manager');
  admin2 = await loginAs('admin');
});
afterAll(closeDb);

describe('a margin edit', () => {
  it('waits as a request (other fields of the same edit save at once); L1 then L2; applied only at L2 with History', async () => {
    const asked = await editSku({ marginPercent: 25, rateAfterMargin: 374.25, productName: 'Renamed scrub' }).expect(200);
    expect(asked.body.data.changed).toEqual(['productName']);
    const id = asked.body.data.marginRequestId as string;
    expect(await sku()).toMatchObject({ margin: '0.3000', rate_after_margin: '349.30', product_name: 'Renamed scrub' });

    const open = await list(manager);
    expect(open.counts).toEqual({ waitingL1: 1, waitingL2: 0, open: 1 });
    expect(open.items[0]).toMatchObject({
      id, kind: 'edit', source: 'masters', status: 'pending_l1', channel: 'BigBasket', oldMarginPercent: 30, newMarginPercent: 25,
      oldRate: 349.3, newRate: 374.25, remark: 'new margin from the KAM', canDecide: true, requestedBy: expect.objectContaining({ id: requester.userId }),
    });

    await approve(id, manager, 'checked with sales').expect(200);
    expect(await sku()).toMatchObject({ margin: '0.3000', rate_after_margin: '349.30' });
    const done = (await approve(id, admin2).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'applied', l1: { remark: 'checked with sales', by: expect.objectContaining({ id: manager.userId }) }, l2: { by: expect.objectContaining({ id: admin2.userId }) } });
    expect(await sku()).toMatchObject({ margin: '0.2500', rate_after_margin: '374.25' });
    const logs = await rows<{ field_name: string; remark: string; user_id: number }>("SELECT field_name, remark, user_id FROM master_change_logs WHERE field_name IN ('marginPercent', 'rateAfterMargin') ORDER BY id");
    expect(logs.map((l) => l.field_name)).toEqual(['marginPercent', 'rateAfterMargin']);
    expect(logs[0].remark).toContain(`Margin change #${id}: asked by ${requester.email}, step 1 approved by ${manager.email}, final approval by ${admin2.email}`);
    expect((await list(manager, 'applied')).items.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it('who may decide: not the requester, layer 1 only for Operations Manager / admin, layer 2 only Admin and not the layer 1 person', async () => {
    const id = (await editSku({ rateAfterMargin: 300 }).expect(200)).body.data.marginRequestId as string;
    const viewer = await loginAs('operations-executive');
    expect((await approve(id, requester).expect(403)).body.error.code).toBe('MARGIN_APPROVER_SAME_PERSON');
    expect((await approve(id, viewer)).status).toBe(403);
    expect((await list(requester)).items[0]).toMatchObject({ canDecide: false, whyNot: 'you asked for this change' });

    await approve(id, admin2).expect(200); // an admin may act as layer 1 too
    expect((await approve(id, manager).expect(403)).body.error.code).toBe('MARGIN_APPROVER_ROLE');
    expect((await approve(id, admin2).expect(403)).body.error.message).toContain('the final approval must be someone else');
    expect((await sku()).rate_after_margin).toBe('349.30');
    const admin3 = await loginAs('admin');
    await approve(id, admin3).expect(200);
    expect((await sku()).rate_after_margin).toBe('300.00');
    expect((await approve(id, admin3).expect(409)).body.error.code).toBe('MARGIN_REQUEST_NOT_OPEN');
  });

  it('rejected at either layer with a reason (required); nothing changes; one open request per row at a time', async () => {
    const id = (await editSku({ rateAfterMargin: 300 }).expect(200)).body.data.marginRequestId as string;
    expect((await editSku({ rateAfterMargin: 310 }).expect(409)).body.error.code).toBe('MARGIN_REQUEST_PENDING');
    expect((await reject(id, manager)).status).toBe(400);
    const out = (await reject(id, manager, 'too low for BigBasket').expect(200)).body.data;
    expect(out).toMatchObject({ status: 'rejected', rejected: { reason: 'too low for BigBasket' } });
    expect((await sku()).rate_after_margin).toBe('349.30');
    // after the decision a new request may be made
    await editSku({ rateAfterMargin: 310 }).expect(200);
  });

  it('a row changed since the request (another approved change) is not overwritten: MARGIN_REQUEST_STALE', async () => {
    const id = (await editSku({ rateAfterMargin: 300 }).expect(200)).body.data.marginRequestId as string;
    await approve(id, manager).expect(200);
    await rows('UPDATE master_channel_skus SET rate_after_margin = 320 WHERE id = ?', [m.channelSkuId]);
    expect((await approve(id, admin2).expect(409)).body.error.code).toBe('MARGIN_REQUEST_STALE');
    expect((await sku()).rate_after_margin).toBe('320.00');
    expect((await list(manager)).items[0].status).toBe('pending_l2');
  });
});

describe('a new channel SKU row', () => {
  const body = () => ({ channelId: m.channelId, channelCode: 'BB-NEW-9', pepCode: m.pepCode, productName: 'x', brand: 'mCaffeine', mrp: 499, marginPercent: 30, rateAfterMargin: 349.3, eanCode: '8906000000017' });
  const addSku = (who = requester) => api().post(`${M}/channel-skus`).set('Cookie', who.cookie).send(body());

  it('needs ONE approval (Operations Manager): added at once with History; the same code cannot be asked twice', async () => {
    const asked = (await addSku().expect(201)).body.data;
    expect(await count('master_channel_skus', 'channel_code = ?', ['BB-NEW-9'])).toBe(0);
    expect((await addSku().expect(409)).body.error.code).toBe('MARGIN_REQUEST_PENDING');
    expect((await list(manager)).items[0]).toMatchObject({ kind: 'add', approvalsNeeded: 1, channelCode: 'BB-NEW-9', newMarginPercent: 30, newRate: 349.3, canDecide: true, row: expect.objectContaining({ productName: 'x' }) });
    const done = (await approve(asked.requestId, manager, 'ok').expect(200)).body.data;
    expect(done).toMatchObject({ status: 'applied', approvalsNeeded: 1, l1: { remark: 'ok', by: expect.objectContaining({ id: manager.userId }) }, l2: null, channelSkuId: expect.any(String) });
    expect(await count('master_channel_skus', 'channel_code = ? AND is_active = 1', ['BB-NEW-9'])).toBe(1);
    const logs = await rows<{ remark: string }>('SELECT remark FROM master_change_logs WHERE remark LIKE ?', [`New channel SKU #${asked.requestId}%`]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].remark).toContain(`asked by ${requester.email}, approved by ${manager.email}`);
    // an edit still needs both layers
    const edit = (await editSku({ marginPercent: 25 }).expect(200)).body.data.marginRequestId as string;
    expect((await approve(edit, manager).expect(200)).body.data).toMatchObject({ status: 'pending_l2', approvalsNeeded: 2 });
  });

  it('not by the requester, not by a role outside layer 1; an add asked before the rule (waiting at layer 2) is added by one more approval', async () => {
    const asked = (await addSku(admin2).expect(201)).body.data;
    expect((await approve(asked.requestId, admin2).expect(403)).body.error.message).toContain('you asked for this change');
    const viewer = await loginAs('viewer');
    expect([403, 401]).toContain((await approve(asked.requestId, viewer)).status);
    expect(await count('master_channel_skus', 'channel_code = ?', ['BB-NEW-9'])).toBe(0);
    // as left by the old two-layer rule: layer 1 done, waiting at layer 2
    await rows('UPDATE margin_change_requests SET status = ?, l1_by = ?, l1_at = NOW() WHERE id = ?', ['pending_l2', requester.userId, asked.requestId]);
    const done = (await approve(asked.requestId, requester).expect(200)).body.data; // the layer 1 person may finish it
    expect(done).toMatchObject({ status: 'applied', l2: { by: expect.objectContaining({ id: requester.userId }) } });
    expect(await count('master_channel_skus', 'channel_code = ? AND is_active = 1', ['BB-NEW-9'])).toBe(1);
  });
});

describe('who sees it', () => {
  it('signed in with the Approvals page; a bad status filter is refused', async () => {
    expect((await api().get(V)).status).toBe(401);
    expect((await api().get(`${V}?status=nope`).set('Cookie', manager.cookie)).status).toBe(400);
  });
});
