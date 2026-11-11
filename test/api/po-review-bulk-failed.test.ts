import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Failed + Rejected, many at once (2026-11-04): Try again (from the step it failed at, one at a time after the answer),
 * Dismiss (off the Failed list, kept), Reopen many rejected. A PO the same channel already has again is never made twice.
 */
covers(['POST /po-review/bulk-retry', 'POST /po-review/bulk-dismiss', 'POST /po-review/bulk-reopen']);

const V = '/api/v1/po-review';
let m: Masters;
let editor: TestLogin;

/** A PO the chain completed, then marked failed at validation (as a crash there leaves it): its folder has processed.json. */
const failedPo = async (poNumber: string): Promise<Upload> => {
  const u = await runPo(bigBasketPo(m, { po_number: poNumber, delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
  const conn = await db();
  await conn.query("DELETE FROM po_issues WHERE upload_id = ?", [u.id]);
  await conn.query("UPDATE po_uploads SET status = 'failed', error_details = ? WHERE id = ?", [JSON.stringify({ step: 'validation', code: 'APP_INTERNAL', reason: 'db timeout' }), u.id]);
  return u;
};
const statusOf = async (u: Upload) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status;
const post = (path: string, body: Record<string, unknown>, who = editor) => api().post(`${V}${path}`).set('Cookie', who.cookie).send(body);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  editor = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('Failed: try again, dismiss', () => {
  it('editor only; 1-50 ids; dismiss / reopen need a remark', async () => {
    const viewer = await loginAs('viewer');
    expect((await post('/bulk-retry', { uploadIds: ['1'] }, viewer)).status).toBe(403);
    expect((await post('/bulk-retry', { uploadIds: [] })).status).toBe(400);
    expect((await post('/bulk-retry', { uploadIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) })).status).toBe(400);
    expect((await post('/bulk-dismiss', { uploadIds: ['1'] })).status).toBe(400);
    expect((await post('/bulk-reopen', { uploadIds: ['1'] })).status).toBe(400);
  });

  it('try again: from the step it failed at (no OCR: processed.json is there) -> back to the chain; not failed / unknown -> skipped', async () => {
    const a = await failedPo('IRA97000001');
    const done = await runPo(bigBasketPo(m, { po_number: 'IRA97000002' }));
    const r = (await post('/bulk-retry', { uploadIds: [a.id, done.id, '999999'] }).expect(200)).body.data as { uploadId: string; result: string; reason: string }[];
    expect(r.find((x) => x.uploadId === a.id)).toMatchObject({ result: 'queued' });
    expect(r.find((x) => x.uploadId === done.id)).toMatchObject({ result: 'skipped', reason: 'it is completed now' });
    expect(r.find((x) => x.uploadId === '999999')).toMatchObject({ result: 'skipped' });
    // written to the DB at once (a restart's resume finishes it): no longer failed, who asked kept
    const [now] = await rows<{ status: string; error_details: string | Record<string, unknown> }>('SELECT status, error_details FROM po_uploads WHERE id = ?', [a.id]);
    expect(now.status).not.toBe('failed');
    expect(typeof now.error_details === 'string' ? JSON.parse(now.error_details) as Record<string, unknown> : now.error_details).toMatchObject({ retriedBy: editor.email });
    // runs after the answer: back through validation (still the unknown location -> In Review)
    await vi.waitFor(async () => expect(await statusOf(a)).toBe('needs_review'), { timeout: 15_000 });
  });

  it('never twice: the same PO already taken again -> skipped with where it is', async () => {
    const a = await failedPo('IRA97000003');
    // the same PO came again (another email) and is in review
    const again = await runPo({ ...bigBasketPo(m, { po_number: 'IRA97000003', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }) });
    const r = (await post('/bulk-retry', { uploadIds: [a.id] }).expect(200)).body.data;
    expect(r[0]).toMatchObject({ result: 'skipped' });
    expect(r[0].reason).toContain(`upload ${again.id}`);
    expect(await statusOf(a)).toBe('failed');
  });

  it('dismiss: off the Failed list (kept, who / why); a dismissed PO is not tried again', async () => {
    const a = await failedPo('IRA97000004');
    const b = await failedPo('IRA97000005');
    const list = async () => ((await api().get(`${V}?status=failed`).set('Cookie', editor.cookie).expect(200)).body.data as { uploadId: string }[]).map((i) => i.uploadId);
    expect(await list()).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await post('/bulk-dismiss', { uploadIds: [a.id], remark: 'test file' }).expect(200)).body.data[0]).toMatchObject({ result: 'done' });
    expect(await list()).toEqual([b.id]);
    const [row] = await rows<{ status: string; error_details: string | Record<string, unknown> }>('SELECT status, error_details FROM po_uploads WHERE id = ?', [a.id]);
    const d = typeof row.error_details === 'string' ? JSON.parse(row.error_details) as Record<string, unknown> : row.error_details;
    expect(row.status).toBe('failed');
    expect(d).toMatchObject({ dismissed: { by: editor.email, remark: 'test file' } });
    expect((await post('/bulk-retry', { uploadIds: [a.id] }).expect(200)).body.data[0]).toMatchObject({ result: 'skipped', reason: 'dismissed' });
  });
});

describe('Rejected: reopen many', () => {
  it('each like Reopen: back In Review; a PO not rejected -> skipped with why', async () => {
    const a = await runPo(bigBasketPo(m, { po_number: 'IRA97000011', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const b = await runPo(bigBasketPo(m, { po_number: 'IRA97000012', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    for (const u of [a]) await post(`/${u.id}/reject`, { remark: 'wrong' }).expect(200);
    const r = (await post('/bulk-reopen', { uploadIds: [a.id, b.id], remark: 'masters fixed' }).expect(200)).body.data;
    expect(r.find((x: { uploadId: string }) => x.uploadId === a.id)).toMatchObject({ result: 'done' });
    expect(r.find((x: { uploadId: string }) => x.uploadId === b.id)).toMatchObject({ result: 'skipped' });
    expect(await statusOf(a)).toBe('needs_review');
  });
});
