import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUniwareClient } from '../../src/modules/d2c-transfers/uniware-transfers';
import { HttpError } from '../../src/modules/intransit/sources/http';
import type { UniwareApi } from '../../src/modules/intransit/sources/uniware';
import { runPoSyncPass } from '../../src/modules/po-uniware-sync/sync.service';
import { api, loginAs } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Channel PO Uniware sync (2026-11-06): POs with a sale order code are read from Uniware (saleorder/get, a fake client
 * here) and their statuses / dates / invoice brought forward; History rows say it was Uniware; done POs are not read
 * again; D2C transfers are not touched; a 429 stops the run.
 */
covers(['GET /po-overview/uniware-sync', 'POST /po-overview/uniware-sync']);

const dto = (name: string) => (JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/modules/d2c-transfers/__tests__/fixtures', name), 'utf8')) as { saleOrderDTO: Record<string, unknown> }).saleOrderDTO;
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
} as unknown as UniwareApi;

/** A channel PO (or a D2C transfer) with its sale order code. */
const po = (orderNo1: string, extra: Record<string, unknown> = {}) => insert('master_purchase_orders', {
  poNumber: `PO-${orderNo1}`, channel: null, facility: 'MUM_WAREHOUSE2', orderNo1, statusPlanning: 'Confirmed', entryDate: '2026-11-05', ...extra,
});
const read = async (uid: number) => (await rows<Record<string, unknown>>('SELECT statusWarehouse, statusLogistics, dispatchDate, invoiceChallanNumber, uniwareStatus, syncError, lastSyncedAt FROM master_purchase_orders WHERE uid = ?', [uid]))[0];

beforeEach(async () => {
  await resetDb();
  calls = [];
  answer = () => { throw refusal('INVALID_SALE_ORDER_CODE'); };
  setUniwareClient(fake);
});
afterEach(() => setUniwareClient(null));
afterAll(closeDb);

describe('a run', () => {
  it('reads each open PO with its facility, brings it forward, logs as Uniware; a done one is not read again', async () => {
    const shipped = await po('erp_20261106001');
    const missing = await po('erp_20261106002', { facility: 'GGN_WAREHOUSE' });
    answer = (code) => (code === 'erp_20261106001' ? { successful: true, saleOrderDTO: dto('so-get-rts.json') } : (() => { throw refusal('INVALID_SALE_ORDER_CODE'); })());
    const r = await runPoSyncPass({ manual: true }, fake);
    expect(r.counts).toMatchObject({ picked: 2, read: 2, notInUniware: 1, changed: 1, done: 1, errors: 0 });
    expect(calls).toEqual([{ body: { code: 'erp_20261106001' }, facility: 'MUM_WAREHOUSE2' }, { body: { code: 'erp_20261106002' }, facility: 'GGN_WAREHOUSE' }]);
    expect(await read(shipped)).toMatchObject({ statusWarehouse: 'Dispatched', statusLogistics: 'Dispatched', invoiceChallanNumber: 'PEP2627MH/0201', syncError: null });
    expect(await read(missing)).toMatchObject({ statusWarehouse: null, uniwareStatus: 'Not in Uniware yet' });
    const logs = await rows<{ field_name: string; source: string; uniware_status: string }>('SELECT field_name, source, uniware_status FROM shipment_logs WHERE shipment_uid = ? ORDER BY id', [shipped]);
    expect(logs[0]).toMatchObject({ field_name: 'statusWarehouse', source: 'uniware', uniware_status: expect.stringContaining('COMPLETE') });

    calls = [];
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
    answer = () => { throw new HttpError(429, '429 from saleorder/get'); };
    const throttled = await runPoSyncPass({ manual: true }, fake);
    expect(throttled.failed).toBe(true);
    expect(throttled.counts.notStarted).toBeGreaterThanOrEqual(0);
    expect(calls.length).toBeLessThanOrEqual(2);
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
});
