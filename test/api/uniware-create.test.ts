import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { runCreateRound, startUniwareCreate } from '../../src/modules/uniware-create/create.service';
import { setPoUniwareClient, UniwareHttpError, type UniwarePoster } from '../../src/modules/po-uniware-sync/uniware-client';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Create in Uniware (2026-11-09): ticked, verified POs on the Processed tab -> saleOrder/create (a FAKE Uniware here:
 * nothing ever reaches the real one). Switch off = refused; per-PO refusals; Uniware asked first (never twice); the
 * request from the CSV + the location's address, one item per unit; created -> marked uploaded + History + status read;
 * refused -> failed with Uniware's words; lost answer -> read back; restart-safe.
 */
covers(['POST /po-review/uniware-create', 'POST /po-review/uniware-create/states', 'POST /po-review/uniware-create/preview']);

const V = '/api/v1';
const GET = '/services/rest/v1/oms/saleorder/get';
const CREATE = '/services/rest/v1/oms/saleOrder/create';
let m: Masters;
let reviewer: TestLogin;

/** The fake Uniware: which codes it has, every call, and how create answers. */
let inUniware: Set<string>;
let calls: { path: string; body: Record<string, unknown>; facility?: string }[];
let onCreate: (body: Record<string, unknown>) => void;
const notFound = () => new Error(`${GET} refused: ${JSON.stringify([{ code: 40005, message: 'INVALID_SALE_ORDER_CODE', description: 'INVALID_SALE_ORDER_CODE' }])}`);
const fake = {
  post: (path: string, body: Record<string, unknown>, facility?: string) => {
    calls.push({ path, body, facility });
    if (path === GET) {
      const code = String(body.code);
      return inUniware.has(code)
        ? Promise.resolve({ successful: true, saleOrderDTO: { code, status: 'CREATED', saleOrderItems: [], shippingPackages: [] } })
        : Promise.reject(notFound());
    }
    try {
      onCreate(body);
      inUniware.add(String((body.saleOrder as Record<string, unknown>).code));
      return Promise.resolve({ successful: true });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
} as unknown as UniwarePoster;
const creates = () => calls.filter((c) => c.path === CREATE);

const ready = async (poNumber: string): Promise<Upload> => {
  const done = await runPo(bigBasketPo(m, { po_number: poNumber }));
  await api().post(`${V}/po-verify/${done.id}/verify`).set('Cookie', reviewer.cookie).send({}).expect(200);
  return done;
};
const ask = (ids: string[], who = reviewer) => api().post(`${V}/po-review/uniware-create`).set('Cookie', who.cookie).send({ uploadIds: ids });
const stateOf = async (id: string) => (await rows<{ status: string; error: string | null; attempts: number; items: number | null }>(
  'SELECT status, error, attempts, items FROM uniware_creates WHERE upload_id = ? ORDER BY id DESC LIMIT 1', [id]))[0];
/** Lets the worker finish (the request starts a round in the background); `busy` = only wait while one is being created. */
const settle = async (busy = false) => {
  for (let i = 0; i < 100; i++) {
    const open = await rows<{ n: number }>(`SELECT COUNT(*) n FROM uniware_creates WHERE status IN (${busy ? "'creating'" : "'queued', 'creating'"})`);
    if (!Number(open[0].n)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the create worker did not finish');
};

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  reviewer = await loginAs('admin');
  inUniware = new Set();
  calls = [];
  onCreate = () => undefined;
  setPoUniwareClient(fake);
  env.uniwareCreate.enabled = true;
  env.uniwareCreate.orderPhone = '9999999999';
});
afterEach(() => {
  setPoUniwareClient(null);
  env.uniwareCreate.enabled = false;
  env.uniwareCreate.orderPhone = '';
});
afterAll(closeDb);

describe('switch and access', () => {
  it('switched off (or no phone): refused, nothing queued; states says so; a viewer may read but not ask', async () => {
    const a = await ready('IRA91100001');
    env.uniwareCreate.enabled = false;
    expect((await ask([a.id])).body.error.code).toBe('UNIWARE_CREATE_OFF');
    const states = await api().post(`${V}/po-review/uniware-create/states`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id] }).expect(200);
    expect(states.body.data).toEqual({ enabled: false, items: [] });
    env.uniwareCreate.enabled = true;
    env.uniwareCreate.orderPhone = '';
    expect((await ask([a.id])).body.error.code).toBe('UNIWARE_CREATE_NO_PHONE');
    env.uniwareCreate.orderPhone = '9999999999';
    const viewer = await loginAs('viewer');
    expect((await ask([a.id], viewer)).status).toBe(403);
    await api().post(`${V}/po-review/uniware-create/states`).set('Cookie', viewer.cookie).send({ uploadIds: [a.id] }).expect(200);
    expect((await ask([])).status).toBe(400);
    expect((await ask(Array.from({ length: 51 }, (_, i) => String(i + 1)))).body.error.code).toBe('UNIWARE_CREATE_TOO_MANY');
    expect(calls).toEqual([]);
  });

  it('each PO that cannot go is refused with its reason; the others are queued', async () => {
    const ok = await ready('IRA91100002');
    const unverified = await runPo(bigBasketPo(m, { po_number: 'IRA91100003' }));
    const marked = await ready('IRA91100004');
    await rows('UPDATE po_uploads SET uniware_uploaded_at = NOW() WHERE id = ?', [marked.id]);
    const res = await ask([ok.id, unverified.id, marked.id, '999999']).expect(202);
    expect(res.body.data.queued).toEqual([ok.id]);
    expect(res.body.data.refused).toEqual([
      { uploadId: unverified.id, reason: 'not verified yet' },
      { uploadId: marked.id, reason: 'already marked uploaded into Uniware' },
      { uploadId: '999999', reason: 'no such upload' },
    ]);
    await settle();
  });
});

describe('preview', () => {
  it('works with Create switched off: what would be sent per PO, nothing sent to Uniware, nothing written', async () => {
    env.uniwareCreate.enabled = false;
    env.uniwareCreate.orderPhone = '';
    const ok = await ready('IRA91100020');
    const unverified = await runPo(bigBasketPo(m, { po_number: 'IRA91100021' }));
    const res = await api().post(`${V}/po-review/uniware-create/preview`).set('Cookie', reviewer.cookie).send({ uploadIds: [ok.id, unverified.id] }).expect(200);
    const [a, b] = res.body.data.items;
    expect(res.body.data.createEnabled).toBe(false);
    expect(a).toMatchObject({
      uploadId: ok.id, poNumber: 'IRA91100020', wouldSend: true, problems: [], phoneSet: false,
      summary: {
        channel: 'BIGBASKET_TEST', customerCode: 'CUST_TEST_1', facility: m.facilityCode, displayOrderCode: 'IRA91100020', units: 10, value: 3493,
        address: { name: 'Test DC', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        lines: [{ sku: m.pepCode, units: 10, price: 349.3, value: 3493 }],
      },
    });
    expect((a.request.saleOrder.saleOrderItems as unknown[]).length).toBe(10);
    expect(b).toMatchObject({ uploadId: unverified.id, wouldSend: false, problems: ['not verified yet'], summary: null, request: null });
    // nothing happened anywhere
    expect(calls).toEqual([]);
    expect(await rows('SELECT id FROM uniware_creates')).toEqual([]);
    expect((await rows<{ at: unknown }>('SELECT uniware_uploaded_at at FROM po_uploads WHERE id = ?', [ok.id]))[0].at).toBeNull();
    const viewer = await loginAs('viewer');
    expect((await api().post(`${V}/po-review/uniware-create/preview`).set('Cookie', viewer.cookie).send({ uploadIds: [ok.id] })).status).toBe(403);
  });
});

describe('creating', () => {
  it('asks Uniware first, creates from the CSV + address (one item per unit), marks it uploaded, History, status read', async () => {
    const a = await ready('IRA91100010');
    await ask([a.id]).expect(202);
    await settle();
    expect(await stateOf(a.id)).toMatchObject({ status: 'created', error: null, attempts: 1, items: 10 });
    const [first] = calls;
    expect(first.path).toBe(GET); // asked before creating
    const [c] = creates();
    expect(c.facility).toBe(m.facilityCode);
    const so = c.body.saleOrder as Record<string, unknown>;
    const code = (await rows<{ orderNo1: string }>('SELECT orderNo1 FROM master_purchase_orders WHERE uid = ?', [a.po_uid]))[0].orderNo1;
    expect(so).toMatchObject({
      code, displayOrderCode: 'IRA91100010', channel: 'BIGBASKET_TEST', customerCode: 'CUST_TEST_1', customerGSTIN: '27AAACI1234A1Z5',
      cashOnDelivery: false, totalPrepaidAmount: 3493,
      addresses: [{ id: '1', name: 'Test DC', addressLine1: 'Test address, Mumbai', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', phone: '9999999999', country: 'IN' }],
      billingAddress: { referenceId: '1' }, shippingAddress: { referenceId: '1' },
    });
    const items = so.saleOrderItems as Record<string, unknown>[];
    expect(items).toHaveLength(10);
    expect(new Set(items.map((i) => i.code)).size).toBe(10);
    expect(items[0]).toMatchObject({ itemSku: m.pepCode, sellingPrice: 349.3, totalPrice: 349.3, shippingMethodCode: 'STD', giftWrap: false });
    // in Uniware now: marked uploaded by the person who asked, History says it was the API, status read at once
    const up = (await rows<{ at: unknown; uby: number }>('SELECT uniware_uploaded_at at, uniware_uploaded_by uby FROM po_uploads WHERE id = ?', [a.id]))[0];
    expect(up.at).not.toBeNull();
    expect(up.uby).toBe(reviewer.userId);
    const logs = await rows<{ action: string; source: string; remark: string }>('SELECT action, source, remark FROM shipment_logs WHERE shipment_uid = ? AND action = ?', [a.po_uid, 'uniware_uploaded']);
    expect(logs).toEqual([{ action: 'uniware_uploaded', source: 'tool_api', remark: `${code} created in Uniware (API)` }]);
    expect((await rows<{ s: string }>('SELECT uniwareStatus s FROM master_purchase_orders WHERE uid = ?', [a.po_uid]))[0].s).toBe('CREATED');
    const states = await api().post(`${V}/po-review/uniware-create/states`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id] }).expect(200);
    expect(states.body.data).toMatchObject({ enabled: true, items: [{ uploadId: a.id, saleOrderCode: code, status: 'created', items: 10, orderValue: 3493 }] });
    // asking again: it is uploaded now
    expect((await ask([a.id]).expect(202)).body.data.refused).toEqual([{ uploadId: a.id, reason: 'already marked uploaded into Uniware' }]);
  });

  it('Uniware already has the code: nothing sent, marked uploaded as "already in Uniware"', async () => {
    const a = await ready('IRA91100011');
    const code = (await rows<{ orderNo1: string }>('SELECT orderNo1 FROM master_purchase_orders WHERE uid = ?', [a.po_uid]))[0].orderNo1;
    inUniware.add(code);
    await ask([a.id]).expect(202);
    await settle();
    expect(creates()).toEqual([]);
    expect(await stateOf(a.id)).toMatchObject({ status: 'exists' });
    expect((await rows<{ remark: string }>('SELECT remark FROM shipment_logs WHERE shipment_uid = ? AND action = ?', [a.po_uid, 'uniware_uploaded']))[0].remark).toContain('already in Uniware');
  });

  it('Uniware refuses: failed with its own words, not marked uploaded; a lost answer is read back as created', async () => {
    const a = await ready('IRA91100012');
    onCreate = () => { throw new Error(`${CREATE} refused: ${JSON.stringify([{ code: 1001, message: 'INVALID_ITEM_SKU', description: 'Item MCAFF_TEST_001 not found' }])}`); };
    await ask([a.id]).expect(202);
    await settle();
    expect(await stateOf(a.id)).toMatchObject({ status: 'failed', error: 'INVALID_ITEM_SKU: Item MCAFF_TEST_001 not found' });
    expect((await rows<{ at: unknown }>('SELECT uniware_uploaded_at at FROM po_uploads WHERE id = ?', [a.id]))[0].at).toBeNull();

    // the order went in but the answer was lost (timeout): the read-back finds it, no second create
    const b = await ready('IRA91100013');
    onCreate = (body) => {
      inUniware.add(String((body.saleOrder as Record<string, unknown>).code));
      throw new UniwareHttpError(504, '504 from create: gateway timeout');
    };
    calls = [];
    await ask([b.id]).expect(202);
    await settle();
    expect(await stateOf(b.id)).toMatchObject({ status: 'created' });
    expect(creates()).toHaveLength(1);
  });

  it('a network error is tried again (3 tries in all), then failed; a row cut off by a restart is picked up again', async () => {
    const a = await ready('IRA91100014');
    onCreate = () => { throw new UniwareHttpError(502, '502 from create: bad gateway'); };
    await ask([a.id]).expect(202);
    for (let i = 0; i < 3; i++) {
      await settle(true);
      await runCreateRound(fake);
    }
    expect(await stateOf(a.id)).toMatchObject({ status: 'failed', attempts: 3, error: '502 from create: bad gateway' });
    expect(creates()).toHaveLength(3);

    // a server stop in the middle: the row stays "creating"; the next start puts it back and creates it
    const b = await ready('IRA91100015');
    const code = (await rows<{ orderNo1: string }>('SELECT orderNo1 FROM master_purchase_orders WHERE uid = ?', [b.po_uid]))[0].orderNo1;
    await insert('uniware_creates', { upload_id: b.id, po_uid: b.po_uid, sale_order_code: code, facility: m.facilityCode, status: 'creating', attempts: 1, requested_by: reviewer.userId });
    onCreate = () => undefined;
    const worker = startUniwareCreate();
    try {
      for (let i = 0; i < 100 && (await stateOf(b.id)).status !== 'created'; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      worker?.stop();
    }
    expect(await stateOf(b.id)).toMatchObject({ status: 'created' });
  });
});
