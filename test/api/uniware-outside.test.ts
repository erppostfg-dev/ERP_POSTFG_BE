import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPoUniwareClient, type UniwarePoster } from '../../src/modules/po-uniware-sync/uniware-client';
import { outsideStatus, runOutsideCheck } from '../../src/modules/uniware-outside/outside.service';
import { api, loginAs } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { BB, seedMasters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * POs punched in Uniware outside POST_FG (2026-11-25): the read-only B2B search (a fake client here) finds Uniware orders
 * whose PO number + Uniware channel match a PO that is In Review, Rejected, or Processed and not uploaded, under another
 * code than ours; the lists show it, and the team rejects / takes Uniware's code / acknowledges / dismisses it.
 */
covers(['GET /po-review/uniware-outside', 'POST /po-review/uniware-outside/check', 'POST /po-review/uniware-outside/:id/resolve']);

const V = '/api/v1/po-review';
let calls: { path: string; body: Record<string, unknown> }[];
let elements: Record<string, unknown>[];
const fake = {
  post: (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return Promise.resolve({ successful: true, elements });
  },
} as unknown as UniwarePoster;

const order = (code: string, po: string, extra: Record<string, unknown> = {}) =>
  ({ code, displayOrderCode: po, channel: 'BIGBASKET_TEST', status: 'PROCESSING', created: Date.parse('2026-11-20T10:00:00Z'), source: 'CUSTOM_B2B', ...extra });

/** An upload of BigBasket PO `po` in `status`; a completed one gets a saved PO with `code` (marked uploaded when `uploaded`). */
const upload = async (po: string, status: string, o: { code?: string; uploaded?: boolean } = {}) => {
  const uid = o.code ? await insert('master_purchase_orders', { poNumber: po, channel: BB.name, facility: 'MUM_WAREHOUSE2', orderNo1: o.code, statusPlanning: 'Confirmed', entryDate: '2026-11-20' }) : null;
  const id = await insert('po_uploads', {
    source: 'manual', channel: BB.name, po_number: po, status, ocr_status: 'success', po_uid: uid,
    csv_downloaded_at: o.uploaded ? new Date() : null, uniware_uploaded_at: o.uploaded ? new Date() : null,
  });
  return { id: String(id), uid };
};
const finding = async (code: string) => (await rows<{ id: string; upload_id: string; kind: string; state: string; resolution: string | null }>(
  'SELECT id, upload_id, kind, state, resolution FROM uniware_outside_orders WHERE uniware_code = ?', [code]))[0];

beforeEach(async () => {
  await resetDb();
  await seedMasters();
  calls = [];
  elements = [];
  setPoUniwareClient(fake);
});
afterEach(() => setPoUniwareClient(null));
afterAll(closeDb);

describe('the check', () => {
  it('B2B search in day windows (first run 30 days back in 48 h windows, at most 15 calls); finds only POs here that are not in Uniware through us', async () => {
    const review = await upload('PO-1', 'needs_review');
    const rejected = await upload('PO-2', 'rejected');
    const processed = await upload('PO-3', 'completed', { code: 'erp_20261120001' });
    await upload('PO-4', 'completed', { code: 'erp_20261120002', uploaded: true });
    await upload('PO-5', 'completed', { code: 'erp_20261120003' });
    await upload('PO-6', 'needs_review');
    elements = [
      order('sf_1', 'PO-1'), order('sf_2', 'po-2 '), order('sf_3', 'PO-3'),
      order('sf_4', 'PO-4'), // already in Uniware through us: not a finding
      order('erp_20261120003', 'PO-5'), // our own code
      order('sf_6', 'PO-6', { channel: 'OTHER_B2B' }), // another channel's PO number
      order('sf_7', 'PO-1', { status: 'CANCELLED' }),
    ];
    const now = Date.parse('2026-11-25T12:00:00Z');
    const r = await runOutsideCheck('test', now);
    expect(calls).toHaveLength(15);
    expect(calls[0]).toMatchObject({ path: '/services/rest/v1/oms/saleOrder/search', body: { orderCategory: 'B2B', dateType: 'CREATED', fromDate: now - 30 * 86_400_000 } });
    expect(r.counts).toMatchObject({ calls: 15, findings: 3, newFindings: 3 });
    expect(await finding('sf_1')).toMatchObject({ upload_id: review.id, kind: 'review', state: 'open' });
    expect(await finding('sf_2')).toMatchObject({ upload_id: rejected.id, kind: 'rejected' });
    expect(await finding('sf_3')).toMatchObject({ upload_id: processed.id, kind: 'processed' });
    expect(await rows('SELECT id FROM uniware_outside_orders WHERE uniware_code IN (?, ?, ?, ?)', ['sf_4', 'erp_20261120003', 'sf_6', 'sf_7'])).toHaveLength(0);

    // the next run goes on from where this one stopped, nothing new is written
    calls = [];
    const again = await runOutsideCheck('test', now);
    expect(calls[0].body.fromDate).toBe(now - 30 * 60_000); // all 30 days were read: on from the end, less the overlap
    expect(again.counts.newFindings).toBe(0);
  });

  it('the lists show the finding with what can be done; the status counts per tab; Check now once per 30 min for the team', async () => {
    const review = await upload('PO-1', 'needs_review');
    const processed = await upload('PO-3', 'completed', { code: 'erp_20261120001' });
    elements = [order('sf_1', 'PO-1'), order('sf_3', 'PO-3')];
    await runOutsideCheck('test');
    const viewer = await loginAs('viewer');
    const inReview = (await api().get(`${V}?status=needs_review`).set('Cookie', viewer.cookie).expect(200)).body.data as { uploadId: string; uniwareOutside: unknown }[];
    expect(inReview.find((x) => x.uploadId === review.id)?.uniwareOutside).toMatchObject({ code: 'sf_1', kind: 'review', actions: ['reject', 'dismiss'], more: 0 });
    const done = (await api().get(`${V}?status=completed`).set('Cookie', viewer.cookie).expect(200)).body.data as { uploadId: string; uniwareOutside: unknown }[];
    expect(done.find((x) => x.uploadId === processed.id)?.uniwareOutside).toMatchObject({ code: 'sf_3', actions: ['use_code', 'dismiss'] });
    expect((await api().get(`${V}/uniware-outside`).set('Cookie', viewer.cookie).expect(200)).body.data.counts).toEqual({ review: 1, rejected: 0, processed: 1 });

    await api().post(`${V}/uniware-outside/check`).set('Cookie', viewer.cookie).expect(403);
    const admin = await loginAs('admin');
    await api().post(`${V}/uniware-outside/check`).set('Cookie', admin.cookie).expect(202);
    expect((await api().post(`${V}/uniware-outside/check`).set('Cookie', admin.cookie).expect(409)).body.error.code).toBe('UNIWARE_OUTSIDE_TOO_SOON');
    for (let i = 0; i < 50 && (await outsideStatus()).running; i++) await new Promise((r) => setTimeout(r, 100));
  });
});

describe('resolving a finding', () => {
  it('use_code: the saved PO takes Uniware\'s code and is marked uploaded (History says why); the finding is closed', async () => {
    const p = await upload('PO-3', 'completed', { code: 'erp_20261120001' });
    elements = [order('sf_3', 'PO-3')];
    await runOutsideCheck('test');
    const f = await finding('sf_3');
    const admin = await loginAs('admin');
    const R = `${V}/uniware-outside/${f.id}/resolve`;
    await api().post(R).set('Cookie', (await loginAs('viewer')).cookie).send({ action: 'use_code' }).expect(403);
    expect((await api().post(R).set('Cookie', admin.cookie).send({ action: 'reject' }).expect(400)).body.error.code).toBe('UNIWARE_OUTSIDE_BAD_ACTION');
    await api().post(R).set('Cookie', admin.cookie).send({ action: 'use_code', remark: 'punched by COPT' }).expect(200);
    expect((await rows<{ o: string }>('SELECT orderNo1 o FROM master_purchase_orders WHERE uid = ?', [p.uid]))[0].o).toBe('sf_3');
    expect((await rows<{ at: unknown }>('SELECT uniware_uploaded_at at FROM po_uploads WHERE id = ?', [p.id]))[0].at).not.toBeNull();
    const log = await rows<{ action: string; remark: string }>('SELECT action, remark FROM shipment_logs WHERE shipment_uid = ? ORDER BY id DESC', [p.uid]);
    expect(log[0]).toMatchObject({ action: 'uniware_uploaded', remark: expect.stringContaining('our erp_20261120001 not used') });
    expect(await finding('sf_3')).toMatchObject({ state: 'resolved', resolution: 'use_code' });
    expect((await api().post(R).set('Cookie', admin.cookie).send({ action: 'dismiss', remark: 'x' }).expect(409)).body.error.code).toBe('UNIWARE_OUTSIDE_DONE');
  });

  it('reject (In Review) rejects the PO with the Uniware code as the reason; acknowledge (Rejected); dismiss needs a remark', async () => {
    const r1 = await upload('PO-1', 'needs_review');
    await upload('PO-2', 'rejected');
    elements = [order('sf_1', 'PO-1'), order('sf_2', 'PO-2')];
    await runOutsideCheck('test');
    const admin = await loginAs('admin');
    const f1 = await finding('sf_1');
    const f2 = await finding('sf_2');
    const bad = await api().post(`${V}/uniware-outside/${f1.id}/resolve`).set('Cookie', admin.cookie).send({ action: 'dismiss' }).expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field)).toEqual(['remark']);
    await api().post(`${V}/uniware-outside/${f1.id}/resolve`).set('Cookie', admin.cookie).send({ action: 'reject' }).expect(200);
    expect((await rows<{ s: string }>('SELECT status s FROM po_uploads WHERE id = ?', [r1.id]))[0].s).toBe('rejected');
    const why = await rows<{ r: string }>('SELECT decision_remark r FROM po_review_submissions WHERE upload_id = ? ORDER BY id DESC', [r1.id]);
    expect(why[0].r).toBe('Punched in Uniware outside POST_FG as sf_1');
    await api().post(`${V}/uniware-outside/${f2.id}/resolve`).set('Cookie', admin.cookie).send({ action: 'acknowledge' }).expect(200);
    expect(await finding('sf_2')).toMatchObject({ state: 'resolved', resolution: 'acknowledge' });
    expect((await api().get(`${V}/uniware-outside`).set('Cookie', admin.cookie).expect(200)).body.data.counts).toEqual({ review: 0, rejected: 0, processed: 0 });
  });
});
