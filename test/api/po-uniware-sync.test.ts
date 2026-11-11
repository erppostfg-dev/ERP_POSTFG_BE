import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPoSyncPass } from '../../src/modules/po-uniware-sync/sync.service';
import { setPoUniwareClient, UniwareHttpError, type UniwarePoster } from '../../src/modules/po-uniware-sync/uniware-client';
import { api, loginAs } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Channel PO Uniware sync (2026-11-06): POs with a sale order code are read from Uniware (saleorder/get, a fake client
 * here) and their statuses / dates / invoice brought forward; History rows say it was Uniware; done POs are not read
 * again; D2C transfers are not touched; a 429 stops the run.
 */
covers(['GET /po-overview/uniware-sync', 'POST /po-overview/uniware-sync']);

const dto = (name: string) => (JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/modules/po-uniware-sync/__tests__/fixtures', name), 'utf8')) as { saleOrderDTO: Record<string, unknown> }).saleOrderDTO;
const refusal = (code: string) => new Error(`/services/rest/v1/oms/saleorder/get refused: ${JSON.stringify([{ code: 40005, message: code, description: code }])}`);

let calls: { body: Record<string, unknown>; facility?: string }[];
let answer: (code: string) => unknown;
const fake = {
  post: (_path: string, body: Record<string, unknown>, facility?: string) => {
    calls.push({ body, facility });
    try {
      return Promise.resolve(answer(String(body.code)));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
} as unknown as UniwarePoster;

/** A channel PO (or a D2C transfer) with its sale order code. */
/**
 * A channel PO (or a D2C transfer) with its sale order code, and its upload: by default the CSV downloaded and marked
 * uploaded (`upload: 'downloaded'` = downloaded only, `'none'` = never downloaded, `false` = no upload row at all).
 */
const po = async (orderNo1: string, extra: Record<string, unknown> = {}, upload: 'marked' | 'downloaded' | 'none' | false = 'marked') => {
  const uid = await insert('master_purchase_orders', {
    poNumber: `PO-${orderNo1}`, channel: null, facility: 'MUM_WAREHOUSE2', orderNo1, statusPlanning: 'Confirmed', entryDate: '2026-11-05', ...extra,
  });
  if (upload) {
    const old = new Date(Date.now() - 30 * 86_400_000);
    await insert('po_uploads', {
      source: 'manual', channel: null, po_number: `PO-${orderNo1}`, status: 'completed', ocr_status: 'success', po_uid: uid,
      csv_downloaded_at: upload === 'none' ? null : old, uniware_uploaded_at: upload === 'marked' ? old : null,
    });
  }
  return uid;
};
const uploadOf = async (uid: number) => (await rows<{ at: unknown; uby: unknown }>('SELECT uniware_uploaded_at at, uniware_uploaded_by uby FROM po_uploads WHERE po_uid = ?', [uid]))[0];
const read = async (uid: number) => (await rows<Record<string, unknown>>('SELECT statusWarehouse, statusLogistics, dispatchDate, invoiceChallanNumber, uniwareStatus, syncError, lastSyncedAt FROM master_purchase_orders WHERE uid = ?', [uid]))[0];

beforeEach(async () => {
  await resetDb();
  calls = [];
  answer = () => { throw refusal('INVALID_SALE_ORDER_CODE'); };
  setPoUniwareClient(fake);
});
afterEach(() => setPoUniwareClient(null));
afterAll(closeDb);

describe('a run', () => {
  it('reads each open PO with its facility, brings it forward, logs as Uniware; a done one is not read again after its after-care', async () => {
    const shipped = await po('erp_20261106001');
    const missing = await po('erp_20261106002', { facility: 'GGN_WAREHOUSE' }, 'downloaded');
    answer = (code) => (code === 'erp_20261106001' ? { successful: true, saleOrderDTO: dto('so-get-rts.json') } : (() => { throw refusal('INVALID_SALE_ORDER_CODE'); })());
    const r = await runPoSyncPass({ manual: true }, fake);
    expect(r.counts).toMatchObject({ picked: 2, read: 2, notInUniware: 1, changed: 1, done: 1, errors: 0 });
    expect(calls).toEqual([{ body: { code: 'erp_20261106001' }, facility: 'MUM_WAREHOUSE2' }, { body: { code: 'erp_20261106002' }, facility: 'GGN_WAREHOUSE' }]);
    expect(await read(shipped)).toMatchObject({ statusWarehouse: 'Dispatched', statusLogistics: 'Dispatched', invoiceChallanNumber: 'PEP2627MH/0201', syncError: null });
    expect(await read(missing)).toMatchObject({ statusWarehouse: null, uniwareStatus: 'Not in Uniware yet' });
    const logs = await rows<{ field_name: string; source: string; uniware_status: string }>('SELECT field_name, source, uniware_status FROM shipment_logs WHERE shipment_uid = ? ORDER BY id', [shipped]);
    expect(logs[0]).toMatchObject({ field_name: 'statusWarehouse', source: 'uniware', uniware_status: expect.stringContaining('COMPLETE') });

    // done by Uniware's own answer: the time is kept; a timed run leaves both alone (read a moment ago)
    expect((await rows<{ d: unknown }>('SELECT uniwareDoneAt d FROM master_purchase_orders WHERE uid = ?', [shipped]))[0].d).not.toBeNull();
    expect((await rows<{ d: unknown }>('SELECT uniwareDoneAt d FROM master_purchase_orders WHERE uid = ?', [missing]))[0].d).toBeNull();
    calls = [];
    await runPoSyncPass({}, fake);
    expect(calls).toEqual([]);
    // after its 15 days of after-care: never again, not even with Sync now
    await rows('UPDATE master_purchase_orders SET uniwareDoneAt = ? WHERE uid = ?', [new Date(Date.now() - 16 * 86_400_000), shipped]);
    await runPoSyncPass({ manual: true }, fake);
    expect(calls.map((c) => c.body.code)).toEqual(['erp_20261106002']);
  });

  it('a timed run skips POs read a moment ago; D2C transfers and POs without a code are never read', async () => {
    await po('erp_20261106003', { lastSyncedAt: new Date() });
    await po('erp_20261106004', { transferCode: 'T-1' });
    await po('', {});
    await runPoSyncPass({}, fake);
    expect(calls).toEqual([]);
    await runPoSyncPass({ manual: true }, fake);
    expect(calls.map((c) => c.body.code)).toEqual(['erp_20261106003']);
  });

  it('another Uniware error is kept on the PO and the run goes on; a 429 stops the run (the rest next time)', async () => {
    const a = await po('erp_20261106005');
    await po('erp_20261106006');
    answer = (code) => { if (code === 'erp_20261106005') throw new Error('saleorder/get refused: ACCESS_DENIED'); return { successful: true, saleOrderDTO: dto('so-get-rts.json') }; };
    const r = await runPoSyncPass({ manual: true }, fake);
    expect(r.counts).toMatchObject({ errors: 1, read: 1 });
    expect((await read(a)).syncError).toContain('ACCESS_DENIED');

    await rows('UPDATE master_purchase_orders SET uniwareStatus = NULL, statusWarehouse = NULL, lastSyncedAt = NULL');
    calls = [];
    answer = () => { throw new UniwareHttpError(429, '429 from saleorder/get'); };
    const throttled = await runPoSyncPass({ manual: true }, fake);
    expect(throttled.failed).toBe(true);
    expect(throttled.counts.notStarted).toBeGreaterThanOrEqual(0);
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe('lighter runs (2026-11-06: 500 POs took 481 s and 2,016 queries)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it('a timed run asks again about a "Not in Uniware yet" PO only after 2 h; one in Uniware every 30 min', async () => {
    await po('erp_20261106010', { uniwareStatus: 'Not in Uniware yet', lastSyncedAt: minutesAgo(60) });
    await po('erp_20261106011', { uniwareStatus: 'Not in Uniware yet', lastSyncedAt: minutesAgo(180) });
    await po('erp_20261106012', { uniwareStatus: 'PROCESSING', lastSyncedAt: minutesAgo(60) });
    await runPoSyncPass({}, fake);
    expect(calls.map((c) => c.body.code).sort()).toEqual(['erp_20261106011', 'erp_20261106012']);
    calls = [];
    // Sync now still reads them all
    await runPoSyncPass({ manual: true }, fake);
    expect(calls.map((c) => c.body.code).sort()).toEqual(['erp_20261106010', 'erp_20261106011', 'erp_20261106012']);
  });

  it('an answer that changes nothing: no History, no field written, only "read at" moves', async () => {
    const uid = await po('erp_20261106013');
    // still in the warehouse (packed): read every run until it ships
    answer = () => ({ successful: true, saleOrderDTO: {
      code: 'erp_20261106013', status: 'PROCESSING',
      saleOrderItems: [{ code: 'A', itemSku: 'mcaf1', statusCode: 'FULFILLABLE', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 0 }],
      shippingPackages: [{ code: 'SP/1', status: 'PACKED', items: { mcaf1: { itemSku: 'mcaf1', quantity: 10 } } }],
    } });
    await runPoSyncPass({ manual: true }, fake);
    const first = await read(uid);
    const logs = (await rows('SELECT id FROM shipment_logs WHERE shipment_uid = ?', [uid])).length;
    await rows('UPDATE master_purchase_orders SET lastSyncedAt = ? WHERE uid = ?', [minutesAgo(45), uid]);
    const r = await runPoSyncPass({}, fake);
    expect(r.counts).toMatchObject({ picked: 1, read: 1, changed: 0, errors: 0 });
    const again = await read(uid);
    expect({ ...again, lastSyncedAt: null }).toEqual({ ...first, lastSyncedAt: null });
    expect(new Date(String(again.lastSyncedAt)).getTime()).toBeGreaterThan(minutesAgo(5).getTime());
    expect((await rows('SELECT id FROM shipment_logs WHERE shipment_uid = ?', [uid])).length).toBe(logs);
  });
});

describe('nothing missed (2026-11-09)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  const codes = () => calls.map((c) => c.body.code).sort();
  const processing = (code: string) => ({ successful: true, saleOrderDTO: {
    code, status: 'PROCESSING',
    saleOrderItems: [{ code: 'A', itemSku: 'mcaf1', statusCode: 'FULFILLABLE', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 0 }],
    shippingPackages: [{ code: 'SP/1', status: 'PACKED', items: { mcaf1: { itemSku: 'mcaf1', quantity: 10 } } }],
  } });
  const uploaded = (poUid: number, at: Date) => insert('po_uploads', { source: 'manual', channel: null, po_number: `U-${poUid}`, status: 'completed', ocr_status: 'success', po_uid: poUid, uniware_uploaded_at: at });

  it('a Status (Warehouse) typed by a person does not stop the reads: only Uniware decides when a PO is done', async () => {
    await po('erp_20261109001', { statusWarehouse: 'Dispatched', uniwareStatus: 'PROCESSING | SP/1 PACKED', lastSyncedAt: minutesAgo(45) });
    answer = (code) => processing(code);
    await runPoSyncPass({}, fake);
    expect(codes()).toEqual(['erp_20261109001']);
  });

  it('"Not in Uniware yet" is asked less often as the PO ages: 2 h, then 6 h after 2 days, then daily after 15 days', async () => {
    const nf = { uniwareStatus: 'Not in Uniware yet' };
    await po('erp_20261109010', { ...nf, createdAt: daysAgo(5), lastSyncedAt: minutesAgo(180) }, 'downloaded'); // 6 h: not yet
    await po('erp_20261109011', { ...nf, createdAt: daysAgo(5), lastSyncedAt: minutesAgo(420) }, 'downloaded'); // 6 h: due
    await po('erp_20261109012', { ...nf, createdAt: daysAgo(20), lastSyncedAt: minutesAgo(420) }, 'downloaded'); // daily: not yet
    await po('erp_20261109013', { ...nf, createdAt: daysAgo(20), lastSyncedAt: minutesAgo(25 * 60) }, 'downloaded'); // daily: due
    await po('erp_20261109014', { ...nf, createdAt: daysAgo(1), lastSyncedAt: minutesAgo(150) }, 'downloaded'); // young, 2 h: due
    await runPoSyncPass({}, fake);
    expect(codes()).toEqual(['erp_20261109011', 'erp_20261109013', 'erp_20261109014']);
  });

  it('marked uploaded after its last read: read on the next run whatever its age; still missing after 6 h: flagged', async () => {
    const old = await po('erp_20261109020', { uniwareStatus: 'Not in Uniware yet', createdAt: daysAgo(20), lastSyncedAt: minutesAgo(10) });
    await uploaded(old, minutesAgo(5));
    await runPoSyncPass({}, fake);
    expect(codes()).toEqual(['erp_20261109020']);
    expect(await read(old)).toMatchObject({ uniwareStatus: 'Not in Uniware yet' });
    // 7 h after the mark, Uniware still has no such code: say so (the upload may have failed); asked every 2 h meanwhile
    calls = [];
    const late = await po('erp_20261109021', { uniwareStatus: 'Not in Uniware yet', createdAt: daysAgo(20), lastSyncedAt: minutesAgo(130) });
    await uploaded(late, minutesAgo(7 * 60));
    await runPoSyncPass({}, fake);
    expect(codes()).toEqual(['erp_20261109021']);
    expect(await read(late)).toMatchObject({ uniwareStatus: 'Marked uploaded, not in Uniware' });
  });

  it('after done: read once a day for 15 days, and a change Uniware makes then (a return) is kept in History', async () => {
    const uid = await po('erp_20261109030', { statusWarehouse: 'Dispatched', statusLogistics: 'Dispatched', rtsDate: '2026-11-01', dispatchDate: '2026-11-02', uniwareStatus: 'COMPLETE | SP/1 DISPATCHED', uniwareDoneAt: daysAgo(2), lastSyncedAt: minutesAgo(120) });
    await runPoSyncPass({}, fake);
    expect(calls).toEqual([]); // read 2 h ago: not yet
    await rows('UPDATE master_purchase_orders SET lastSyncedAt = ? WHERE uid = ?', [minutesAgo(25 * 60), uid]);
    answer = (code) => ({ successful: true, saleOrderDTO: {
      code, status: 'COMPLETE',
      saleOrderItems: [{ code: 'A', itemSku: 'mcaf1', statusCode: 'DISPATCHED', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 10 }],
      shippingPackages: [{ code: 'SP/1', status: 'RETURNED', items: { mcaf1: { itemSku: 'mcaf1', quantity: 10 } } }],
    } });
    await runPoSyncPass({}, fake);
    expect(codes()).toEqual(['erp_20261109030']);
    expect(await read(uid)).toMatchObject({ statusWarehouse: 'Dispatched', uniwareStatus: 'COMPLETE | SP/1 RETURNED' });
    const logs = await rows<{ field_name: string; old_value: string; new_value: string; source: string }>('SELECT field_name, old_value, new_value, source FROM shipment_logs WHERE shipment_uid = ?', [uid]);
    expect(logs).toEqual([{ field_name: 'uniwareStatus', old_value: 'COMPLETE | SP/1 DISPATCHED', new_value: 'COMPLETE | SP/1 RETURNED', source: 'uniware' }]);
  });
});

describe('routes', () => {
  it('GET the last run (viewer); POST Sync now (editor) starts a run; bad uids refused', async () => {
    const editor = await loginAs('admin');
    const viewer = await loginAs('viewer');
    expect((await api().get('/api/v1/po-overview/uniware-sync')).status).toBe(401);
    const uid = await po('erp_20261106007');
    answer = () => ({ successful: true, saleOrderDTO: dto('so-get-rts.json') });
    const started = await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', editor.cookie).send({ uids: [String(uid)] }).expect(202);
    expect(['started', 'queued']).toContain(started.body.data.state);
    await vi.waitFor(async () => expect((await read(uid)).statusWarehouse).toBe('Dispatched'), { timeout: 10_000 });
    const status = (await api().get('/api/v1/po-overview/uniware-sync').set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(status).toMatchObject({ trigger: 'manual', lastError: null, everyMinutes: 30 });
    expect((await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', editor.cookie).send({ uids: ['x'] })).status).toBe(400);
    expect((await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', viewer.cookie).send({})).status).toBe(403);
  });

  it('the button: one click per 30 min for the whole team (the server refuses the next, with who and when); status says when', async () => {
    const a = await loginAs('admin');
    const b = await loginAs('admin');
    await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', a.cookie).send({}).expect(202);
    const again = await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', b.cookie).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('UNIWARE_SYNC_TOO_SOON');
    expect(again.body.error.message).toContain(a.email);
    const status = (await api().get('/api/v1/po-overview/uniware-sync').set('Cookie', b.cookie).expect(200)).body.data;
    expect(status.button).toMatchObject({ lastBy: a.email, everyMinutes: 30 });
    expect(Date.parse(status.button.nextAt)).toBeGreaterThan(Date.now() + 29 * 60_000);
    // 31 min later anyone may click again
    await rows("UPDATE app_state SET value = JSON_SET(value, '$.at', ?) WHERE state_key = 'po-uniware:button'", [new Date(Date.now() - 31 * 60_000).toISOString()]);
    await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', b.cookie).send({}).expect(202);
    // a sync of picked POs (uids) is not limited
    const uid = await po('erp_20261109090');
    await api().post('/api/v1/po-overview/uniware-sync').set('Cookie', a.cookie).send({ uids: [String(uid)] }).expect(202);
  });
});

describe('download / upload flags (2026-11-09)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const moving = (code: string) => ({ successful: true, saleOrderDTO: {
    code, status: 'PROCESSING',
    saleOrderItems: [{ code: 'A', itemSku: 'mcaf1', statusCode: 'FULFILLABLE', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 0 }],
    shippingPackages: [{ code: 'SP/1', status: 'PACKED', items: { mcaf1: { itemSku: 'mcaf1', quantity: 10 } } }],
  } });

  it('a sale order CSV never downloaded is never asked (it cannot be in Uniware): timer, Sync now, button', async () => {
    await po('erp_20261109101', {}, 'none');
    await po('erp_20261109102', {}, false);
    await runPoSyncPass({}, fake);
    await runPoSyncPass({ manual: true }, fake);
    await runPoSyncPass({ manual: true, button: true }, fake);
    expect(calls).toEqual([]);
  });

  it('the button reads only what can move: in Uniware and not finished, marked uploaded but not seen yet', async () => {
    const live = { uniwareStatus: 'PROCESSING | SP/1 PACKED', lastSyncedAt: minutesAgo(20) };
    await po('erp_20261109110', live, 'downloaded'); // in Uniware, moving: read
    await po('erp_20261109111', { ...live, lastSyncedAt: minutesAgo(2) }, 'downloaded'); // read 2 min ago: not again
    await po('erp_20261109112', { uniwareStatus: 'Not in Uniware yet', lastSyncedAt: minutesAgo(20) }, 'marked'); // marked, not seen: read
    await po('erp_20261109113', { uniwareStatus: 'Not in Uniware yet', lastSyncedAt: minutesAgo(200) }, 'downloaded'); // not marked: timer only
    await po('erp_20261109114', { uniwareStatus: 'COMPLETE | SP/1 DISPATCHED', uniwareDoneAt: minutesAgo(600), lastSyncedAt: minutesAgo(600) }, 'marked'); // finished: timer only
    answer = (code) => (code === 'erp_20261109110' ? moving(code) : (() => { throw refusal('INVALID_SALE_ORDER_CODE'); })());
    await runPoSyncPass({ manual: true, button: true }, fake);
    expect(calls.map((c) => c.body.code).sort()).toEqual(['erp_20261109110', 'erp_20261109112']);
  });

  it('found in Uniware but never marked uploaded: marked by the sync (no person) + History; not when a person removed the mark', async () => {
    const found = await po('erp_20261109120', {}, 'downloaded');
    const known = await po('erp_20261109121', { uniwareStatus: 'PROCESSING | SP/1 PACKED', lastSyncedAt: new Date() }, 'downloaded');
    const undone = await po('erp_20261109122', { uniwareStatus: 'PROCESSING | SP/1 PACKED', lastSyncedAt: new Date() }, 'downloaded');
    await insert('shipment_logs', { shipment_uid: undone, action: 'uniware_upload_undone', source: 'screen' });
    const missing = await po('erp_20261109123', {}, 'downloaded');
    answer = (code) => (code === 'erp_20261109123' ? (() => { throw refusal('INVALID_SALE_ORDER_CODE'); })() : moving(code));
    const r = await runPoSyncPass({}, fake);
    expect(r.counts.markedUploaded).toBe(2);
    for (const uid of [found, known]) {
      const u = await uploadOf(uid);
      expect(u.at).not.toBeNull();
      expect(u.uby).toBeNull();
      const logs = await rows<{ source: string; remark: string }>("SELECT source, remark FROM shipment_logs WHERE shipment_uid = ? AND action = 'uniware_uploaded'", [uid]);
      expect(logs).toEqual([{ source: 'uniware', remark: expect.stringContaining('found in Uniware by the sync') }]);
    }
    expect((await uploadOf(undone)).at).toBeNull();
    expect((await uploadOf(missing)).at).toBeNull();
  });
});
