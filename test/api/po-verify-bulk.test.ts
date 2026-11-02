import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Bulk verify (2026-11-02, user): the Processed download with "Verified" typed in its Check column is uploaded back and
 * the screen sends the matching POs here. Only POs still "to verify" are verified; the others come back as skipped with
 * the reason. POs are made by the real chain (a clean BigBasket PO completes; PO_VERIFY_REQUIRED=true in tests).
 */
covers(['POST /po-verify/verify']);

const V = '/api/v1/po-verify';
let m: Masters;
let reviewer: TestLogin;

const done = (po: string) => runPo(bigBasketPo(m, { po_number: po }));
const bulk = (ids: unknown, who = reviewer, remark?: string) => api().post(`${V}/verify`).set('Cookie', who.cookie).send({ uploadIds: ids, ...(remark ? { remark } : {}) });
const stateOf = async (u: Upload) => (await api().get(`${V}?uploadIds=${u.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data.items[0].state as string;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('who may bulk verify', () => {
  it('401 without a login, 403 for a viewer; nothing is written', async () => {
    const a = await done('IRA93000001');
    expect((await api().post(`${V}/verify`).send({ uploadIds: [a.id] })).status).toBe(401);
    const viewer = await loginAs('viewer');
    expect((await bulk([a.id], viewer)).status).toBe(403);
    expect(await count('po_verifications')).toBe(0);
  });
});

describe('the list of POs', () => {
  it('400 for no list, an empty list, too many ids, or something that is not an upload id', async () => {
    for (const ids of [undefined, [], Array.from({ length: 201 }, (_, i) => String(i + 1)), ['abc'], [12]]) {
      const res = await bulk(ids);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('uploadIds');
    }
  });
});

describe('verifying', () => {
  it('verifies every PO still to verify in one call: Check = Verified, their CSVs unlock, one audit line', async () => {
    const a = await done('IRA93000011');
    const b = await done('IRA93000012');
    expect((await api().get(`/api/v1/po-review/${a.id}/uniware-csv`).set('Cookie', reviewer.cookie)).status).toBe(409);
    const res = await bulk([a.id, b.id, a.id], reviewer, 'Verified in the Processed download').expect(200);
    expect(res.body.data).toEqual({ verified: [a.id, b.id], skipped: [] });
    expect([await stateOf(a), await stateOf(b)]).toEqual(['verified', 'verified']);
    expect(await rows('SELECT upload_id, remark, sale_order_code IS NOT NULL so, done_by FROM po_verifications ORDER BY upload_id')).toEqual([
      { upload_id: a.id, remark: 'Verified in the Processed download', so: '1', done_by: reviewer.userId },
      { upload_id: b.id, remark: 'Verified in the Processed download', so: '1', done_by: reviewer.userId },
    ]);
    await api().get(`/api/v1/po-review/${a.id}/uniware-csv`).set('Cookie', reviewer.cookie).expect(200);
    expect(await count('activity_log', "path = 'po verify: bulk verified 2 upload(s)'")).toBe(1);
  });

  it('leaves the others as they are, with the reason: already verified, in review, in Uniware, check switched off, unknown', async () => {
    const verified = await done('IRA93000021');
    await api().post(`${V}/${verified.id}/verify`).set('Cookie', reviewer.cookie).send({}).expect(200);
    const inReview = await runPo(bigBasketPo(m, { po_number: 'IRA93000022', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const inUniware = await done('IRA93000023');
    await (await db()).query('UPDATE po_uploads SET uniware_uploaded_at = NOW() WHERE id = ?', [inUniware.id]);
    const fresh = await done('IRA93000024');

    const res = await bulk([verified.id, inReview.id, inUniware.id, '999999', fresh.id]).expect(200);
    expect(res.body.data.verified).toEqual([fresh.id]);
    expect(res.body.data.skipped).toEqual([
      { uploadId: verified.id, reason: 'already_verified' },
      { uploadId: inReview.id, reason: 'not_ready' },
      { uploadId: inUniware.id, reason: 'in_uniware' },
      { uploadId: '999999', reason: 'not_found' },
    ]);
    expect(await count('po_verifications')).toBe(2);

    // the channel's check switched off: nothing to verify
    const off = await done('IRA93000025');
    await insert('po_verify_channel_settings', { channel: 'BigBasket', required: 0, updated_by: reviewer.userId, updated_at: new Date() });
    expect((await bulk([off.id]).expect(200)).body.data).toEqual({ verified: [], skipped: [{ uploadId: off.id, reason: 'not_required' }] });
    expect(await count('activity_log', "path LIKE 'po verify: bulk%'")).toBe(1);
  });
});
