import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';

/*
 * Rejected + Failed POs on PO Processing & Review (2026-11-02, user: "show the rejected POs, and every failed one with the
 * tag why it failed"): GET /po-review?status=rejected lists who rejected it, when, why and where (PO review or
 * Approvals); ?status=failed the failed step (ocr, processing, save_po, uniware_csv, release), code and reason. Both newest first.
 */
const V = '/api/v1';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;

const reviewPo = (poNumber: string) => runPo(bigBasketPo(m, { po_number: poNumber, delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
const list = (status: string) => api().get(`${V}/po-review?status=${status}`).set('Cookie', reviewer.cookie).expect(200);
const fail = async (u: Upload, details: Record<string, unknown>, at: string) =>
  (await db()).query('UPDATE po_uploads SET status = ?, error_details = ?, updated_at = ? WHERE id = ?', ['failed', JSON.stringify(details), at, u.id]);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('Rejected POs', () => {
  it('says who rejected it, when, why, and from where (the reviewer in PO review, or the approver); newest first', async () => {
    const a = await reviewPo('IRA93000001');
    const b = await reviewPo('IRA93000002');
    await api().post(`${V}/po-review/${a.id}/reject`).set('Cookie', reviewer.cookie).send({ remark: 'duplicate PO' }).expect(200);
    await api().post(`${V}/po-review/${b.id}/submit`).set('Cookie', reviewer.cookie).send({ location: { detailsChannelId: m.locationId } }).expect(200);
    const [s] = await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ? AND type = ?', [b.id, 'approval']);
    await api().post(`${V}/approvals/po-reviews/${s.id}/reject`).set('Cookie', admin.cookie).send({ remark: 'wrong location' }).expect(200);
    const res = await list('rejected');
    expect(res.body.data.map((x: { poNumber: string }) => x.poNumber)).toEqual(['IRA93000002', 'IRA93000001']);
    const [byApprover, byReviewer] = res.body.data;
    expect(byApprover.rejection).toMatchObject({ from: 'approval', reason: 'wrong location', byEmail: admin.email });
    expect(byReviewer.rejection).toMatchObject({ from: 'review', reason: 'duplicate PO', byEmail: reviewer.email });
    expect(byReviewer.rejection.at).toBeTruthy();
    expect(byReviewer.failure).toBeNull();
  });
});

describe('Failed POs', () => {
  it('each with the step that failed, its code and reason (reason or message), newest first; other lists carry no failure', async () => {
    const a = await reviewPo('IRA93000011');
    const b = await reviewPo('IRA93000012');
    await fail(a, { step: 'ocr', code: 'OCR_DOWNLOAD_FAILED', reason: 'download failed: PO Excel: no link', status: 'failed' }, '2026-11-01 10:00:00');
    await fail(b, { step: 'uniware_csv', message: 'S3 upload refused', saleOrderCode: 'erp_20261101001' }, '2026-11-02 10:00:00');
    const res = await list('failed');
    expect(res.body.data.map((x: { poNumber: string; failure: unknown }) => [x.poNumber, x.failure])).toEqual([
      ['IRA93000012', { step: 'uniware_csv', code: null, reason: 'S3 upload refused', at: expect.any(String), ocrAttempts: expect.any(Number) }],
      ['IRA93000011', { step: 'ocr', code: 'OCR_DOWNLOAD_FAILED', reason: 'download failed: PO Excel: no link', at: expect.any(String), ocrAttempts: expect.any(Number) }],
    ]);
    const c = await reviewPo('IRA93000013');
    const review = await list('needs_review');
    expect(review.body.data.find((x: { uploadId: string }) => x.uploadId === c.id)).toMatchObject({ failure: null, rejection: null });
  });
});
