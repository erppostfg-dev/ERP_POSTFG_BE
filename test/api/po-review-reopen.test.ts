import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Rejected POs: why, reopen, fix, approve (2026-11-03, user). GET /po-review/:id/rejection shows why it was rejected
 * (who, where, reason), the errors rejected with it and what the reviewer had changed; POST /po-review/:id/reopen
 * { remark } (PO review editor, any number of times) puts it back In Review with the checks run again against today's
 * masters + one "Reopened" issue a person accepts, so it always goes through Approvals, tagged "Reopened".
 */
covers(['GET /po-review/:uploadId/rejection', 'POST /po-review/:uploadId/reopen']);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;

/** In Review for its delivery location (WMS-UNKNOWN / 999999 are not in the masters). */
const reviewPo = (poNumber: string) => runPo(bigBasketPo(m, { po_number: poNumber, delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
const reject = (u: Upload, remark = 'location not known') => api().post(`${V}/po-review/${u.id}/reject`).set('Cookie', reviewer.cookie).send({ remark }).expect(200);
const reopen = (u: Upload, body: Record<string, unknown> = { remark: 'masters fixed' }, who = reviewer) => api().post(`${V}/po-review/${u.id}/reopen`).set('Cookie', who.cookie).send(body);
const statusOf = async (u: Upload) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status;
const openIssues = async (u: Upload) => rows<{ id: string; issue_type: string; field_name: string }>('SELECT id, issue_type, field_name FROM po_issues WHERE upload_id = ? AND status = ? ORDER BY id', [u.id, 'open']);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('why it was rejected', () => {
  it('who, where, the reason and the errors rejected with it; unknown PO -> 404', async () => {
    const u = await reviewPo('IRA94000001');
    await reject(u, 'location not known');
    const d = (await api().get(`${V}/po-review/${u.id}/rejection`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d).toMatchObject({ poNumber: 'IRA94000001', status: 'rejected', rejection: { from: 'review', reason: 'location not known', byEmail: reviewer.email }, reviewerFixes: null, reopens: [] });
    expect(d.rejectedIssues.map((i: { type: string }) => i.type)).toEqual(['LOCATION_NOT_MAPPED']);
    expect((await api().get(`${V}/po-review/999999/rejection`).set('Cookie', reviewer.cookie)).status).toBe(404);
  });

  it('an approver rejection also shows what the reviewer had changed', async () => {
    const u = await reviewPo('IRA94000002');
    await api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', reviewer.cookie).send({ location: { detailsChannelId: m.locationId } }).expect(200);
    const [s] = await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ?', [u.id]);
    await api().post(`${V}/approvals/po-reviews/${s.id}/reject`).set('Cookie', admin.cookie).send({ remark: 'wrong DC' }).expect(200);
    const d = (await api().get(`${V}/po-review/${u.id}/rejection`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d.rejection).toMatchObject({ from: 'approval', reason: 'wrong DC', byEmail: admin.email });
    expect(d.reviewerFixes.location).toMatchObject({ to: expect.any(String) });
  });
});

describe('reopen', () => {
  it('editor only, remark required, only a rejected PO', async () => {
    const u = await reviewPo('IRA94000011');
    expect((await reopen(u)).status).toBe(409);
    await reject(u);
    const viewer = await loginAs('viewer');
    expect((await reopen(u, { remark: 'x' }, viewer)).status).toBe(403);
    expect((await reopen(u, {})).status).toBe(400);
    expect(await statusOf(u)).toBe('rejected');
  });

  it('back In Review: the checks again (still the location) + one Reopened issue; the list carries the tag', async () => {
    const u = await reviewPo('IRA94000012');
    await reject(u, 'location not known');
    const res = await reopen(u).expect(200);
    expect(res.body.data).toEqual({ status: 'needs_review', openIssues: 2 });
    expect((await openIssues(u)).map((i) => [i.issue_type, i.field_name])).toEqual([['LOCATION_NOT_MAPPED', 'delivery_location'], ['OTHER', 'reopened']]);
    // the old rejected issue stays as it was (history)
    expect(await count('po_issues', 'upload_id = ? AND status = ?', [u.id, 'rejected'])).toBe(1);
    const item = (await api().get(`${V}/po-review`).set('Cookie', reviewer.cookie).expect(200)).body.data.find((x: { uploadId: string }) => x.uploadId === u.id);
    expect(item.reopened).toMatchObject({ remark: 'masters fixed', rejectedReason: 'location not known', rejectedFrom: 'review', times: 1 });
  });

  it('masters fixed meanwhile: only the Reopened issue is open, and the timed re-check does NOT save it (approval needed)', async () => {
    const u = await reviewPo('IRA94000013');
    await reject(u);
    await (await db()).query("UPDATE details_channels SET consignee_pin_code = '999999' WHERE id = ?", [m.locationId]);
    await reopen(u).expect(200);
    expect((await openIssues(u)).map((i) => i.issue_type)).toEqual(['OTHER']);
    await api().post(`${V}/po-review/recheck`).set('Cookie', reviewer.cookie).send({}).expect(200);
    expect(await statusOf(u)).toBe('needs_review');
  });

  it('fixed like any review -> Approvals with the Reopened tag (and its filter) -> approved: PO + sale order', async () => {
    const u = await reviewPo('IRA94000014');
    await reject(u, 'location not known');
    await reopen(u).expect(200);
    const other = (await openIssues(u)).find((i) => i.issue_type === 'OTHER')!;
    await api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', reviewer.cookie)
      .send({ location: { detailsChannelId: m.locationId }, accept: [{ issueId: other.id, remark: 'checked again' }] }).expect(200);
    const plain = await reviewPo('IRA94000015');
    await api().post(`${V}/po-review/${plain.id}/submit`).set('Cookie', reviewer.cookie).send({ location: { detailsChannelId: m.locationId } }).expect(200);
    const all = (await api().get(`${V}/approvals/po-reviews?status=pending`).set('Cookie', admin.cookie).expect(200)).body.data;
    const byPo = Object.fromEntries(all.map((x: { poNumber: string }) => [x.poNumber, x]));
    expect(byPo.IRA94000014.reopened).toEqual({ rejectedReason: 'location not known', rejectedFrom: 'review' });
    expect(byPo.IRA94000015.reopened).toBeNull();
    const tagged = (await api().get(`${V}/approvals/po-reviews?status=pending&reopened=true`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(tagged.map((x: { poNumber: string }) => x.poNumber)).toEqual(['IRA94000014']);
    await api().post(`${V}/approvals/po-reviews/${byPo.IRA94000014.id}/approve`).set('Cookie', admin.cookie).send({}).expect(200);
    expect(await statusOf(u)).toBe('completed');
  });

  it('any number of times: rejected again, reopened again (the list counts them)', async () => {
    const u = await reviewPo('IRA94000016');
    await reject(u, 'first');
    await reopen(u, { remark: 'try 1' }).expect(200);
    await reject(u, 'second');
    await reopen(u, { remark: 'try 2' }).expect(200);
    const item = (await api().get(`${V}/po-review`).set('Cookie', reviewer.cookie).expect(200)).body.data.find((x: { uploadId: string }) => x.uploadId === u.id);
    expect(item.reopened).toMatchObject({ remark: 'try 2', rejectedReason: 'second', times: 2 });
    const d = (await api().get(`${V}/po-review/${u.id}/rejection`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d.reopens.map((r: { remark: string }) => r.remark)).toEqual(['try 2', 'try 1']);
  });
});
