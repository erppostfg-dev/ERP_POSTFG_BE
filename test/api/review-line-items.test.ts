import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * In Review line items (2026-11-03, user: "the same download in review, with a column of each line's issues"):
 * POST /po-review/review-line-items { uploadIds } -> each line as read (processed.json, S3) with its open issues, and
 * the PO's own issues (location, total ...) on every line. Read-only (viewer); only POs in review.
 */
covers(['POST /po-review/review-line-items']);

const V = '/api/v1';
let m: Masters;
let reviewer: TestLogin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

const lines = (ids: unknown, who = reviewer) => api().post(`${V}/po-review/review-line-items`).set('Cookie', who.cookie).send({ uploadIds: ids });

describe('In Review line items', () => {
  it('each line with its own issues + the PO issues on every line', async () => {
    const base = bigBasketPo(m).line_items[0];
    const u = await runPo(bigBasketPo(m, {
      po_number: 'IRA95000001', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999', total_line_items: 2,
      line_items: [{ ...base, line_no: 1 }, { ...base, line_no: 2, channel_sku_code: 'NOT-OURS-9' }],
    }));
    expect(u.status).toBe('needs_review');
    const res = await lines([u.id]).expect(200);
    expect(res.body.data.map((r: { lineNo: number; channelSkuCode: string }) => [r.lineNo, r.channelSkuCode])).toEqual([[1, m.channelCode], [2, 'NOT-OURS-9']]);
    const [l1, l2] = res.body.data;
    expect(l1.issues).toEqual([]);
    expect(l2.issues.map((i: { type: string }) => i.type)).toEqual(['SKU_NOT_MAPPED']);
    expect(l2.issues[0].details).toContain('NOT-OURS-9');
    for (const l of [l1, l2]) expect(l.poIssues.map((i: { type: string }) => i.type)).toContain('LOCATION_NOT_MAPPED');
    expect(l1).toMatchObject({ poNumber: 'IRA95000001', channel: 'BigBasket', qty: 10, channelMrp: 499, s3Missing: false });
  });

  it('only POs in review; at least one id; a login is enough to read (no page -> 403)', async () => {
    const done = await runPo(bigBasketPo(m, { po_number: 'IRA95000002' }));
    expect(done.status).toBe('completed');
    expect((await lines([done.id])).status).toBe(409);
    expect((await lines([])).status).toBe(400);
    expect((await lines([done.id], await loginAs(null))).status).toBe(403);
  });
});
