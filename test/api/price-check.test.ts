import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessedLine } from '../../src/modules/po-processing/common/processed-po';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Price check in PO review (2026-10-30, user): a price / MRP mismatch is decided per line by a click, OURS (the sale order
 * keeps our master value; the line goes on the Price differences list to tell the channel) or CHANNEL (the sale order
 * takes the PO's value; "update master" changes the channel SKU when the PO is approved). The PO total is worked out
 * again from the choices; one still off is accepted only with a remark. Seeded master: MRP 499, rate 349.30.
 */
covers(['GET /price-differences', 'GET /price-differences/lines', 'GET /price-differences/draft', 'POST /price-differences/sent']);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;

/** A BigBasket PO whose lines differ from our master (default: line 1 at Rs 360 = +10.70). */
const pricedPo = (lines: Partial<ProcessedLine>[] = [{ landing_rate: 360, line_total: 3600 }], poNumber = 'IRA91000001') => {
  const base = bigBasketPo(m).line_items[0];
  const items = lines.map((l, i) => ({ ...base, line_no: i + 1, ...l }));
  return runPo(bigBasketPo(m, { po_number: poNumber, line_items: items, total_line_items: items.length }));
};
const submit = (u: Upload, body: Record<string, unknown>, who = reviewer) => api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', who.cookie).send(body);
const approve = async (u: Upload) => {
  const [s] = await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ? ORDER BY id DESC LIMIT 1', [u.id]);
  return api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', admin.cookie).send({});
};
const csvOf = async (u: Upload) => {
  const [r] = await rows<{ uniware_csv_url: string }>('SELECT uniware_csv_url FROM po_uploads WHERE id = ?', [u.id]);
  return s3Objects().get(r.uniware_csv_url.replace(/^s3:\/\/[^/]+\//, '')) ?? '';
};
const master = async () => (await rows<{ mrp: string; rate_after_margin: string }>('SELECT mrp, rate_after_margin FROM master_channel_skus WHERE id = ?', [m.channelSkuId]))[0];

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('deciding a price mismatch', () => {
  it('no choice: still open (the PO cannot be submitted)', async () => {
    const u = await pricedPo();
    expect(u.status).toBe('needs_review');
    const res = await submit(u, {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toContain('PRICE_MISMATCH');
  });

  it('OURS: sale order at our price, the PO total closes by itself, the line goes on the Price differences list', async () => {
    const u = await pricedPo();
    // the PO's total (3,600 vs our 3,493) is explained by the line kept at our price: no total issue left
    await submit(u, { lines: [{ lineNo: '1', priceFrom: 'ours' }] }).expect(200);
    const ok = await approve(u);
    expect(ok.status).toBe(200);
    expect(await csvOf(u)).toContain('349.30');
    const [d] = await rows<Record<string, unknown>>('SELECT field, po_value, our_value, difference, qty, channel, po_number, sent_at FROM po_price_differences WHERE upload_id = ?', [u.id]);
    expect(d).toMatchObject({ field: 'price', po_value: '360.00', our_value: '349.30', difference: '10.70', qty: '10.00', channel: 'BigBasket', po_number: 'IRA91000001', sent_at: null });
    expect((await master()).rate_after_margin).toBe('349.30');
  });

  it('CHANNEL: sale order at the PO\'s price for this PO only; nothing to tell the channel; master unchanged', async () => {
    const u = await pricedPo();
    await submit(u, { lines: [{ lineNo: '1', priceFrom: 'channel' }] }).expect(200);
    expect((await approve(u)).status).toBe(200);
    expect(await csvOf(u)).toContain('360.00');
    expect(await count('po_price_differences')).toBe(0);
    expect((await master()).rate_after_margin).toBe('349.30');
  });

  it('CHANNEL + update master: on approval the channel SKU takes the PO\'s price and MRP (once for two lines), History says from which PO', async () => {
    const u = await pricedPo([{ landing_rate: 360, line_total: 3600, channel_mrp: 520 }, { landing_rate: 360, line_total: 3600, channel_mrp: 520 }]);
    const both = { priceFrom: 'channel', mrpFrom: 'channel', updateMaster: true };
    await submit(u, { lines: [{ lineNo: '1', ...both }, { lineNo: '2', ...both }] }).expect(200);
    // nothing changes before the approval
    expect((await master()).rate_after_margin).toBe('349.30');
    const detail = await api().get(`${V}/approvals/po-reviews/${(await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ?', [u.id]))[0].id}`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(detail.body.data)).toContain('"updateMaster":true');
    expect((await approve(u)).status).toBe(200);
    expect(await master()).toEqual({ mrp: '520.00', rate_after_margin: '360.00' });
    const logs = await rows<{ field_name: string; remark: string }>('SELECT field_name, remark FROM master_change_logs ORDER BY id');
    expect(logs.map((l) => l.field_name).sort()).toEqual(['mrp', 'rateAfterMargin']);
    expect(logs[0].remark).toContain('From PO review: BigBasket PO IRA91000001 line 1, 2');
  });

  it('MRP kept at ours: its own row on the list; a price within Rs 1 needs no choice', async () => {
    const u = await pricedPo([{ channel_mrp: 520 }]);
    await submit(u, { lines: [{ lineNo: '1', mrpFrom: 'ours' }] }).expect(200);
    await approve(u).then((r) => expect(r.status).toBe(200));
    expect(await rows('SELECT field, po_value, our_value FROM po_price_differences')).toEqual([{ field: 'mrp', po_value: '520.00', our_value: '499.00' }]);
  });

  it('a total still off after the choices ("go with the line total") is accepted only with a remark', async () => {
    // line total 3,700 does not match 10 x 360
    const u = await pricedPo([{ landing_rate: 360, line_total: 3700 }]);
    const total = (await rows<{ id: string }>("SELECT id FROM po_issues WHERE upload_id = ? AND issue_type = 'TOTAL_MISMATCH'", [u.id]))[0];
    const lines = [{ lineNo: '1', priceFrom: 'channel' }];
    expect((await submit(u, { lines })).status).toBe(422);
    expect((await submit(u, { lines, accept: [{ issueId: total.id }] })).body.error.code).toBe('ISSUE_REMARK_REQUIRED');
    await submit(u, { lines, accept: [{ issueId: total.id, remark: 'channel line total has freight' }] }).expect(200);
  });

  it('bad values are refused together', async () => {
    const u = await pricedPo();
    const res = await submit(u, { lines: [{ lineNo: '1', priceFrom: 'cheapest', updateMaster: 'yes' }] }).expect(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['lines[0].priceFrom', 'lines[0].updateMaster']);
  });
});

describe('Price differences tab', () => {
  const twoPos = async () => {
    for (const po of ['IRA91000001', 'IRA91000002']) {
      const u = await pricedPo([{ landing_rate: 360, line_total: 3600 }], po);
      await submit(u, { lines: [{ lineNo: '1', priceFrom: 'ours' }] }).expect(200);
      expect((await approve(u)).status).toBe(200);
    }
  };

  it('who may read / mark: 401, viewer reads but cannot mark sent', async () => {
    expect((await api().get(`${V}/price-differences`)).status).toBe(401);
    const viewer = await loginAs('viewer');
    expect((await api().get(`${V}/price-differences`).set('Cookie', viewer.cookie)).status).toBe(200);
    expect((await api().post(`${V}/price-differences/sent`).set('Cookie', viewer.cookie).send({ ids: ['1'] })).status).toBe(403);
  });

  it('per PO and per channel, the email draft, then Mark as sent (once)', async () => {
    await twoPos();
    const byPo = (await api().get(`${V}/price-differences?view=po`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(byPo.map((g: { poNumber: string }) => g.poNumber).sort()).toEqual(['IRA91000001', 'IRA91000002']);
    expect(byPo[0]).toMatchObject({ channel: 'BigBasket', lines: 1, valueDifference: 107, openLines: 1, sentAt: null });
    const byChannel = (await api().get(`${V}/price-differences?view=channel`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(byChannel).toEqual([expect.objectContaining({ channel: 'BigBasket', pos: 2, lines: 2, valueDifference: 214, openLines: 2 })]);

    const lines = (await api().get(`${V}/price-differences/lines?channel=BigBasket`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(lines).toHaveLength(2);
    const draft = (await api().get(`${V}/price-differences/draft?channel=BigBasket`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(draft.subject).toMatch(/^mCaffeine \| Price differences \| BigBasket \| 2 POs \| \d{4}-\d{2}-\d{2}$/);
    expect(draft.body).toContain('PO IRA91000001');
    expect(draft.body).toContain('PO 360.00 · Agreed 349.30');
    expect(draft.to).toBe('');
    expect(draft.fileName).toContain('price_differences_BigBasket');
    const onePo = (await api().get(`${V}/price-differences/draft?uploadId=${byPo[0].uploadId}`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(onePo.subject).toContain(`PO ${byPo[0].poNumber}`);

    const sent = await api().post(`${V}/price-differences/sent`).set('Cookie', reviewer.cookie).send({ ids: draft.lineIds }).expect(200);
    expect(sent.body.data.marked).toBe(2);
    expect((await api().post(`${V}/price-differences/sent`).set('Cookie', reviewer.cookie).send({ ids: draft.lineIds })).body.data.marked).toBe(0);
    expect((await api().get(`${V}/price-differences?view=po&status=open`).set('Cookie', reviewer.cookie).expect(200)).body.data).toEqual([]);
    const done = (await api().get(`${V}/price-differences/lines?channel=BigBasket&status=sent`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(done.every((l: { sentAt: string | null; sentBy: string | null }) => l.sentAt && l.sentBy)).toBe(true);
  });

  it('bad filters and a draft without a PO / channel are refused', async () => {
    const bad = await api().get(`${V}/price-differences/lines?status=maybe&from=30-10-2026`).set('Cookie', reviewer.cookie).expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['from', 'status']);
    expect((await api().get(`${V}/price-differences/draft`).set('Cookie', reviewer.cookie)).body.error.code).toBe('PRICE_DIFF_SCOPE_REQUIRED');
    expect((await api().get(`${V}/price-differences?view=sku`).set('Cookie', reviewer.cookie)).status).toBe(400);
    expect((await api().post(`${V}/price-differences/sent`).set('Cookie', reviewer.cookie).send({})).body.error.code).toBe('PRICE_DIFF_IDS_REQUIRED');
  });
});
