import type { AddressInfo } from 'net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { BB, bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * PO review -> approval -> verification -> Uniware hand-off (2026-10-28). POs are made by the REAL chain (helpers/
 * po-flow): a clean BigBasket PO completes (sale order + CSV in the fake S3), one with an unknown delivery location
 * goes to In Review. Roles: operations-executive = PO Review editor (submit / reject, no approving); admin = approver;
 * operations-manager = Approvals viewer only; no role = nothing.
 */
covers([
  'GET /po-review', 'GET /po-review/:uploadId', 'GET /po-review/:uploadId/file', 'POST /po-review/:uploadId/submit', 'POST /po-review/:uploadId/reject',
  'POST /po-review/recheck', 'POST /po-review/line-items', 'GET /po-review/events', 'GET /po-review/live-state',
  'GET /po-review/:uploadId/uniware-csv', 'POST /po-review/uniware-csv', 'POST /po-review/uniware-uploaded',
  'GET /approvals/po-reviews', 'GET /approvals/po-reviews/:id', 'POST /approvals/po-reviews/:id/approve', 'POST /approvals/po-reviews/:id/reject',
  'GET /approvals/events', 'GET /approvals/live-state',
  'GET /po-verify', 'GET /po-verify/:uploadId', 'POST /po-verify/:uploadId/verify', 'POST /po-verify/:uploadId/send-back',
  'GET /po-verify/settings', 'PATCH /po-verify/settings/:channel',
]);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;

/** A PO whose delivery location is not in the masters: In Review with LOCATION_NOT_MAPPED. */
const reviewPo = (poNumber = 'IRA90000002') => runPo(bigBasketPo(m, { po_number: poNumber, delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
const submitFix = (u: Upload, who = reviewer) =>
  api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', who.cookie).send({ location: { detailsChannelId: m.locationId }, remark: 'right DC' });
const submissionOf = async (u: Upload) => (await rows<{ id: string; status: string }>('SELECT id, status FROM po_review_submissions WHERE upload_id = ? ORDER BY id DESC LIMIT 1', [u.id]))[0];
const statusOf = async (u: Upload) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('the chain feeds the review (baseline)', () => {
  it('a clean PO completes with a sale order and its 14-column Uniware CSV in S3; a bad one waits in review', async () => {
    const ok = await runPo(bigBasketPo(m));
    expect(ok.status).toBe('completed');
    const csv = s3Objects().get(ok.uniware_csv_url!.replace(/^s3:\/\/[^/]+\//, ''))!;
    const [header, line] = csv.trim().split(/\r?\n/);
    expect(header.split(',')).toHaveLength(14);
    expect(line).toContain('CUST_TEST_1');
    expect(line).toContain(m.pepCode);
    expect(await count('master_purchase_orders', 'uid = ?', [ok.po_uid])).toBe(1);
    const bad = await reviewPo();
    expect(bad.status).toBe('needs_review');
    expect(await rows('SELECT issue_type, status FROM po_issues WHERE upload_id = ?', [bad.id])).toEqual([{ issue_type: 'LOCATION_NOT_MAPPED', status: 'open' }]);
  });
});

describe('PO Review lists and one PO', () => {
  it('who may read: 401 / 403 / viewer', async () => {
    expect((await api().get(`${V}/po-review`)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(`${V}/po-review`).set('Cookie', nobody.cookie)).status).toBe(403);
    expect((await api().get(`${V}/po-review`).set('Cookie', reviewer.cookie)).status).toBe(200);
  });

  it('lists In Review by default and Processed with ?status=completed; bad filters are refused', async () => {
    const done = await runPo(bigBasketPo(m));
    const bad = await reviewPo();
    const review = await api().get(`${V}/po-review`).set('Cookie', reviewer.cookie).expect(200);
    expect(review.body.data.map((x: { uploadId: string }) => x.uploadId)).toEqual([bad.id]);
    const processed = await api().get(`${V}/po-review?status=completed`).set('Cookie', reviewer.cookie).expect(200);
    expect(processed.body.data.map((x: { uploadId: string }) => x.uploadId)).toEqual([done.id]);
    const refused = await api().get(`${V}/po-review?status=nope&from=28-10-2026`).set('Cookie', reviewer.cookie).expect(400);
    expect(refused.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['from', 'status']);
  });

  it('one PO: issues, PO lines from processed.json (S3), the channel SKUs to pick from; unknown id -> 404', async () => {
    const bad = await reviewPo();
    const res = await api().get(`${V}/po-review/${bad.id}`).set('Cookie', reviewer.cookie).expect(200);
    const d = res.body.data;
    expect(d.issues.map((i: { type?: string; issueType?: string }) => i.type ?? i.issueType)).toEqual(['LOCATION_NOT_MAPPED']);
    expect(JSON.stringify(d)).toContain('IRA90000002');
    expect(d.skuOptions.map((o: { pepCode: string }) => o.pepCode)).toEqual([m.pepCode]);
    expect((await api().get(`${V}/po-review/999999`).set('Cookie', reviewer.cookie)).status).toBe(404);
  });

  it('streams the PO file from S3', async () => {
    const bad = await reviewPo();
    const res = await api().get(`${V}/po-review/${bad.id}/file`).set('Cookie', reviewer.cookie).expect(200);
    expect(res.text ?? res.body.toString()).toContain('not a real sheet');
  });

  it('line items of processed POs (viewer may download)', async () => {
    const done = await runPo(bigBasketPo(m));
    const res = await api().post(`${V}/po-review/line-items`).set('Cookie', reviewer.cookie).send({ uploadIds: [done.id] }).expect(200);
    expect(JSON.stringify(res.body.data)).toContain(m.pepCode);
  });
});

describe('submit -> approve / reject', () => {
  it('the reviewer submits the fix; it waits in Approvals; the admin approves -> PO + sale order + CSV', async () => {
    const bad = await reviewPo();
    const sub = await submitFix(bad).expect(200);
    expect(sub.body.data.status).toBe('pending_approval');
    expect(await statusOf(bad)).toBe('pending_approval');

    const list = await api().get(`${V}/approvals/po-reviews?status=pending`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(list.body)).toContain('IRA90000002');
    const s = await submissionOf(bad);
    const detail = await api().get(`${V}/approvals/po-reviews/${s.id}`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(detail.body.data)).toContain('right DC');

    const ok = await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', admin.cookie).send({ remark: 'ok' }).expect(200);
    expect(ok.body.data).toMatchObject({ status: 'completed' });
    expect(ok.body.data.saleOrderCode).toMatch(/^erp_\d{11}$/);
    expect(await statusOf(bad)).toBe('completed');
    expect(await count('po_issues', 'upload_id = ? AND status = ?', [bad.id, 'open'])).toBe(0);
    expect([...s3Objects().keys()].some((k) => k.endsWith('.csv') && k.includes('IRA90000002'))).toBe(true);
  });

  it('approving twice is refused (one PO, one sale order)', async () => {
    const bad = await reviewPo();
    await submitFix(bad).expect(200);
    const s = await submissionOf(bad);
    await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', admin.cookie).send({}).expect(200);
    const again = await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', admin.cookie).send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await count('master_purchase_orders', '`poNumber` = ?', ['IRA90000002'])).toBe(1);
  });

  it('a reviewer (not an approver) and an Approvals viewer cannot approve', async () => {
    const bad = await reviewPo();
    await submitFix(bad).expect(200);
    const s = await submissionOf(bad);
    expect((await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', reviewer.cookie).send({})).status).toBe(403);
    const manager = await loginAs('operations-manager');
    expect((await api().get(`${V}/approvals/po-reviews`).set('Cookie', manager.cookie)).status).toBe(200);
    expect((await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', manager.cookie).send({})).status).toBe(403);
    expect(await statusOf(bad)).toBe('pending_approval');
  });

  it('edit access to the Approvals page is not enough: only admin / developer may decide', async () => {
    const bad = await reviewPo();
    await submitFix(bad).expect(200);
    const s = await submissionOf(bad);
    const editor = await loginAs('viewer');
    await insert('user_page_permissions', { user_id: editor.userId, page_slug: '/approvals', access_level: 'editor' });
    for (const action of ['approve', 'reject']) {
      const res = await api().post(`${V}/approvals/po-reviews/${s.id}/${action}`).set('Cookie', editor.cookie).send({ remark: 'x' });
      expect(res.status, action).toBe(403);
      expect(res.body.error.code, action).toBe('NOT_AN_APPROVER');
    }
    expect(await statusOf(bad)).toBe('pending_approval');
  });

  it('submit is refused while an issue is still open (nothing changes)', async () => {
    const bad = await reviewPo();
    const res = await api().post(`${V}/po-review/${bad.id}/submit`).set('Cookie', reviewer.cookie).send({ remark: 'no fix' });
    expect(res.status).toBe(422);
    expect(await statusOf(bad)).toBe('needs_review');
    expect(await count('po_review_submissions')).toBe(0);
  });

  it('submit validates its body; a viewer cannot submit', async () => {
    const bad = await reviewPo();
    const res = await api().post(`${V}/po-review/${bad.id}/submit`).set('Cookie', reviewer.cookie).send({ lines: 'x', location: 5 }).expect(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['lines', 'location']);
    const viewer = await loginAs('viewer');
    expect((await api().get(`${V}/po-review/${bad.id}`).set('Cookie', viewer.cookie)).status).toBe(200);
    expect((await api().post(`${V}/po-review/${bad.id}/submit`).set('Cookie', viewer.cookie).send({})).status).toBe(403);
  });

  it('the approver rejects with a reason (required)', async () => {
    const bad = await reviewPo();
    await submitFix(bad).expect(200);
    const s = await submissionOf(bad);
    await api().post(`${V}/approvals/po-reviews/${s.id}/reject`).set('Cookie', admin.cookie).send({}).expect(400);
    await api().post(`${V}/approvals/po-reviews/${s.id}/reject`).set('Cookie', admin.cookie).send({ remark: 'duplicate PO' }).expect(200);
    expect(await statusOf(bad)).toBe('rejected');
    expect((await submissionOf(bad)).status).toBe('rejected');
  });

  it('the reviewer rejects directly from PO Review, with a reason', async () => {
    const bad = await reviewPo();
    await api().post(`${V}/po-review/${bad.id}/reject`).set('Cookie', reviewer.cookie).send({ remark: '' }).expect(400);
    await api().post(`${V}/po-review/${bad.id}/reject`).set('Cookie', reviewer.cookie).send({ remark: 'not our PO' }).expect(200);
    expect(await statusOf(bad)).toBe('rejected');
    expect(await count('po_review_submissions', 'upload_id = ?', [bad.id])).toBe(1);
  });
});

describe('re-check after a master fix', () => {
  it('the missing location added on the Masters page -> Re-check completes the PO by itself', async () => {
    const bad = await reviewPo();
    await insert('details_channels', {
      channel_id: BB.id, channel_name: BB.name, channel_location_code: 'WMS-UNKNOWN', uniware_customer_code: 'CUST_TEST_2', channel_code: 'BIGBASKET_TEST',
      facility_code: m.facilityCode, facility_id: m.facilityId, consignee_pin_code: '999999', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
    const res = await api().post(`${V}/po-review/recheck`).set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toMatchObject({ checked: 1, issuesClosed: 1 });
    expect(await statusOf(bad)).toBe('completed');
  });

  it('a viewer cannot start a re-check', async () => {
    const manager = await loginAs('operations-manager');
    const nobody = await loginAs(null);
    expect((await api().post(`${V}/po-review/recheck`).set('Cookie', nobody.cookie)).status).toBe(403);
    expect((await api().post(`${V}/po-review/recheck`).set('Cookie', manager.cookie)).status).toBe(200);
  });
});

describe('verification before the Uniware hand-off', () => {
  it('the CSV is locked until the PO is verified (channel switch ON by default)', async () => {
    const done = await runPo(bigBasketPo(m));
    const locked = await api().get(`${V}/po-review/${done.id}/uniware-csv`).set('Cookie', reviewer.cookie).expect(409);
    expect(locked.body.error.code).toBe('PO_NOT_VERIFIED');
    const states = await api().get(`${V}/po-verify?uploadIds=${done.id}`).set('Cookie', reviewer.cookie).expect(200);
    expect(states.body.data.items[0]).toMatchObject({ uploadId: done.id, state: 'to_verify' });
    const detail = await api().get(`${V}/po-verify/${done.id}`).set('Cookie', reviewer.cookie).expect(200);
    expect(JSON.stringify(detail.body.data)).toContain(m.pepCode);

    await api().post(`${V}/po-verify/${done.id}/verify`).set('Cookie', reviewer.cookie).send({ remark: 'checked', linesChecked: 1, lineCount: 1 }).expect(200);
    const csv = await api().get(`${V}/po-review/${done.id}/uniware-csv`).set('Cookie', reviewer.cookie).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('CUST_TEST_1');
  });

  it('send back: the saved PO is cancelled, the PO is back in review, and it is not a duplicate of itself later', async () => {
    const done = await runPo(bigBasketPo(m));
    await api().post(`${V}/po-verify/${done.id}/send-back`).set('Cookie', reviewer.cookie).send({}).expect(400);
    await api().post(`${V}/po-verify/${done.id}/send-back`).set('Cookie', reviewer.cookie).send({ remark: 'wrong qty' }).expect(200);
    expect(await statusOf(done)).toBe('needs_review');
    // the same PO number again: not refused as a duplicate of the cancelled one
    const again = await runPo(bigBasketPo(m));
    expect(await rows('SELECT issue_type FROM po_issues WHERE upload_id = ? AND issue_type = ?', [again.id, 'DUPLICATE_PO'])).toEqual([]);
  });

  it('per-channel switch: admin only; OFF = CSV not locked', async () => {
    expect((await api().get(`${V}/po-verify/settings`).set('Cookie', reviewer.cookie)).status).toBe(403);
    const list = await api().get(`${V}/po-verify/settings`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(list.body.data)).toContain('BigBasket');
    await api().patch(`${V}/po-verify/settings/BigBasket`).set('Cookie', admin.cookie).send({ required: 'yes' }).expect(400);
    await api().patch(`${V}/po-verify/settings/BigBasket`).set('Cookie', admin.cookie).send({ required: false }).expect(200);
    const done = await runPo(bigBasketPo(m));
    await api().get(`${V}/po-review/${done.id}/uniware-csv`).set('Cookie', reviewer.cookie).expect(200);
    expect((await api().patch(`${V}/po-verify/settings/NoSuchChannel`).set('Cookie', admin.cookie).send({ required: false })).status).toBe(404);
  });
});

describe('Uniware hand-off', () => {
  const ready = async (poNumber: string) => {
    const done = await runPo(bigBasketPo(m, { po_number: poNumber }));
    await api().post(`${V}/po-verify/${done.id}/verify`).set('Cookie', reviewer.cookie).send({}).expect(200);
    return done;
  };

  it('combined CSV for several POs; first download recorded', async () => {
    const a = await ready('IRA90000011');
    const b = await ready('IRA90000012');
    const res = await api().post(`${V}/po-review/uniware-csv`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id, b.id] }).expect(200);
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(await count('po_uploads', 'csv_downloaded_at IS NOT NULL')).toBe(2);
    expect((await api().post(`${V}/po-review/uniware-csv`).set('Cookie', reviewer.cookie).send({ uploadIds: [] })).status).toBe(400);
  });

  it('mark uploaded only after a download; undo removes the mark; both recorded', async () => {
    const a = await ready('IRA90000021');
    const before = await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id] });
    expect(before.status).toBeGreaterThanOrEqual(400);
    expect(await count('po_uploads', 'id = ? AND uniware_uploaded_at IS NOT NULL', [a.id])).toBe(0);
    await api().get(`${V}/po-review/${a.id}/uniware-csv`).set('Cookie', reviewer.cookie).expect(200);
    const marked = await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id] }).expect(200);
    expect(marked.body.data.changed).toEqual([a.id]);
    expect(await count('po_uploads', 'id = ? AND uniware_uploaded_at IS NOT NULL', [a.id])).toBe(1);
    await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', reviewer.cookie).send({ uploadIds: [a.id], undo: true }).expect(200);
    expect(await count('po_uploads', 'id = ? AND uniware_uploaded_at IS NOT NULL', [a.id])).toBe(0);
  });

  it('a viewer cannot download or mark', async () => {
    const a = await ready('IRA90000031');
    const viewer = await loginAs('viewer');
    expect((await api().get(`${V}/po-review/${a.id}/uniware-csv`).set('Cookie', viewer.cookie)).status).toBe(403);
    expect((await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', viewer.cookie).send({ uploadIds: [a.id] })).status).toBe(403);
  });
});

describe('live updates (PO Review + Approvals)', () => {
  it('live-state gives a version that changes when a PO moves', async () => {
    const v1 = (await api().get(`${V}/po-review/live-state`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    const bad = await reviewPo();
    await submitFix(bad).expect(200);
    const v2 = (await api().get(`${V}/approvals/live-state`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(JSON.stringify(v2)).not.toEqual(JSON.stringify(v1));
  });

  it('events: an SSE stream for viewers (closed by the client)', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      for (const path of ['/po-review/events', '/approvals/events']) {
        const ctl = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}${V}${path}`, { headers: { Cookie: path.startsWith('/approvals') ? admin.cookie : reviewer.cookie }, signal: ctl.signal });
        expect(res.status, path).toBe(200);
        expect(res.headers.get('content-type'), path).toContain('text/event-stream');
        ctl.abort();
      }
      expect((await fetch(`http://127.0.0.1:${port}${V}/po-review/events`)).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
