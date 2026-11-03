import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * The Processed list carries each PO's verification state (2026-11-03, user: the screen's GET /po-verify?uploadIds=<every
 * PO> grew with every PO): GET /po-review?status=completed items have verify { state, required, by, at, remark }; the
 * other lists have verify null. Same states as GET /po-verify (which stays for other callers).
 */
const V = '/api/v1';
let m: Masters;
let reviewer: TestLogin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

const processed = async () => (await api().get(`${V}/po-review?status=completed`).set('Cookie', reviewer.cookie).expect(200)).body.data;

describe('verification state in the Processed list', () => {
  it('to_verify while the channel needs it; verified (by, at, remark) once checked; the In Review list has none', async () => {
    const done = await runPo(bigBasketPo(m));
    const [item] = await processed();
    expect(item.verify).toEqual({ state: 'to_verify', required: true, by: null, at: null, remark: null });
    await api().post(`${V}/po-verify/${done.id}/verify`).set('Cookie', reviewer.cookie).send({ remark: 'checked', linesChecked: 1, lineCount: 1 }).expect(200);
    const [after] = await processed();
    expect(after.verify).toMatchObject({ state: 'verified', required: true, remark: 'checked' });
    expect(after.verify.by).toBeTruthy();
    // the same answer as GET /po-verify for that PO
    const old = (await api().get(`${V}/po-verify?uploadIds=${done.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data.items[0];
    expect({ ...old, uploadId: undefined }).toMatchObject({ ...after.verify, uploadId: undefined });
    await runPo(bigBasketPo(m, { po_number: 'IRA96000002', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const review = (await api().get(`${V}/po-review`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(review[0].verify).toBeNull();
  });

  it('channel switched OFF: not_required', async () => {
    await runPo(bigBasketPo(m));
    const admin = await loginAs('admin');
    await api().patch(`${V}/po-verify/settings/BigBasket`).set('Cookie', admin.cookie).send({ required: false }).expect(200);
    const [item] = await processed();
    expect(item.verify).toMatchObject({ state: 'not_required', required: false });
  });
});
