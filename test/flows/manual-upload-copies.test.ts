import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb, rows } from '../helpers/db';
import { fcRaw, seedFirstClub } from '../helpers/first-club';
import { seedMasters } from '../helpers/fixtures';

/*
 * The same PO uploaded again (user 2026-11-05, option 2): at upload the copies already in POST_FG are shown (409
 * MANUAL_ALREADY_IN: Open it / Process again / Cancel); Process again (replace=true) rejects the copy in review /
 * dismisses a failed one when the new upload is processed, so only one copy is ever in review; a sale order, an approval
 * or a run in progress cannot be replaced (409 MANUAL_ALREADY_BLOCKED). Safety net after the OCR: a newer upload of a
 * PO still live elsewhere is flagged DUPLICATE_PO naming the older one. First Club data (helpers/first-club); the OCR
 * itself is replaced by `ocr.answer`.
 */
const ocr = vi.hoisted(() => ({ answer: null as Record<string, unknown> | null }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async () => (ocr.answer
    ? { exitCode: ocr.answer.error ? 1 : 0, timedOut: false, durationMs: 1, result: ocr.answer, logTail: '' }
    : { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, logTail: '' })),
}));

const V = '/api/v1/manual-uploads';
const PO = 'PO-199751-FRHHYDMDL01';
let reviewer: TestLogin;
/** The OCR reads the PO: clean (-> sale order) or with an unknown SKU (-> In Review). */
const ocrReads = (clean: boolean) => {
  const { 'Total Amount': t, 'Grand Total': g, ...header } = fcRaw.header;
  const lines = clean ? fcRaw.lines : [{ ...fcRaw.lines[3], 'SKU Code': 'SKU999999999' }];
  ocr.answer = { channel: 'first_club', header, totals: clean ? { 'Total Amount': t, 'Grand Total': g } : {}, line_item_columns: Object.keys(fcRaw.lines[0]), line_items: lines };
};
const upload = (name: string, body: string, replace = false) => {
  const req = api().post(V).set('Cookie', reviewer.cookie).field('channel', 'first_club');
  if (replace) req.field('replace', 'true');
  return req.attach('files', Buffer.from(body), name);
};
const processOne = async (id: string) => {
  await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
  await vi.waitFor(async () => expect(['done', 'failed']).toContain((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status), { timeout: 20_000 });
};
/** Upload + process one copy; returns its manual upload id and PO row id. */
const copy = async (name: string, body: string, clean = false) => {
  ocrReads(clean);
  const res = await upload(name, body).expect(201);
  const [id] = res.body.data.ids as string[];
  await processOne(id);
  const [u] = await rows<{ id: string; status: string }>('SELECT id, status FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${id}`]);
  return { manualId: id, uploadId: u?.id, status: u?.status };
};
const statusOf = async (uploadId: string) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [uploadId]))[0].status;

beforeEach(async () => {
  ocr.answer = null;
  await resetDb();
  await seedMasters();
  await seedFirstClub();
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('Manual Upload: the same PO again', () => {
  it('the same file while a copy is In Review: 409 with the copy (nothing stored); Process again replaces it', async () => {
    const first = await copy('PO-199751.pdf', '%PDF-1.4 one');
    expect(first.status).toBe('needs_review');

    const again = await upload('PO-199751.pdf', '%PDF-1.4 one').expect(409);
    expect(again.body.error.code).toBe('MANUAL_ALREADY_IN');
    expect(again.body.error.details.copies).toEqual([expect.objectContaining({ uploadId: first.uploadId, manualUploadId: first.manualId, status: 'needs_review', how: 'same file', action: 'replace', poNumber: PO })]);
    expect(await rows('SELECT id FROM manual_uploads')).toHaveLength(1);

    // Process again: stored with a note; processing rejects the old copy first, so only the new one is in review
    ocrReads(false);
    const res = await upload('PO-199751.pdf', '%PDF-1.4 one', true).expect(201);
    const [id] = res.body.data.ids as string[];
    expect((await rows<{ note: string }>('SELECT note FROM manual_uploads WHERE id = ?', [id]))[0].note).toContain(`#${first.uploadId}`);
    await processOne(id);
    expect(await statusOf(first.uploadId)).toBe('rejected');
    const [sub] = await rows<{ decision_remark: string }>('SELECT decision_remark FROM po_review_submissions WHERE upload_id = ?', [first.uploadId]);
    expect(sub.decision_remark).toContain(`replaced by manual upload #${id}`);
    const inReview = await rows<{ id: string }>("SELECT id FROM po_uploads WHERE po_number = ? AND status = 'needs_review'", [PO]);
    expect(inReview).toHaveLength(1);
    expect(inReview[0].id).not.toBe(first.uploadId);
  });

  it('another file with the same PO number in its name: found too ("same PO number")', async () => {
    const first = await copy('PO-199751.pdf', '%PDF-1.4 one');
    const res = await upload('PO-199751 (1).pdf', '%PDF-1.4 a re-saved copy').expect(409);
    expect(res.body.error.details.copies).toEqual([expect.objectContaining({ uploadId: first.uploadId, how: 'same PO number', action: 'replace' })]);
  });

  it('a failed copy: Process again dismisses it (kept, off the Failed list)', async () => {
    ocr.answer = { channel: 'first_club', error: 'boom', ocr_run: { stage: 'header (model)' } };
    const res = await upload('PO-199751.pdf', '%PDF-1.4 one').expect(201);
    const [firstId] = res.body.data.ids as string[];
    await processOne(firstId);
    const [failed] = await rows<{ id: string; status: string }>('SELECT id, status FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${firstId}`]);
    expect(failed.status).toBe('failed');
    expect((await upload('PO-199751.pdf', '%PDF-1.4 one').expect(409)).body.error.details.copies[0]).toMatchObject({ status: 'failed', action: 'replace' });
    ocrReads(false);
    const [id] = (await upload('PO-199751.pdf', '%PDF-1.4 one', true).expect(201)).body.data.ids as string[];
    await processOne(id);
    const [old] = await rows<{ status: string; error_details: { dismissed?: { remark: string } } }>('SELECT status, error_details FROM po_uploads WHERE id = ?', [failed.id]);
    expect(old.status).toBe('failed');
    expect(old.error_details.dismissed?.remark).toContain(`replaced by manual upload #${id}`);
  });

  it('blocked (even with Process again): a sale order already made; an upload not processed yet', async () => {
    await copy('PO-199751.pdf', '%PDF-1.4 one', true);
    expect((await rows<{ status: string }>('SELECT status FROM po_uploads'))[0].status).toBe('completed');
    const done = await upload('PO-199751.pdf', '%PDF-1.4 one', true).expect(409);
    expect(done.body.error.code).toBe('MANUAL_ALREADY_BLOCKED');
    expect(done.body.error.message).toMatch(/sale order \(erp_\d+\).*Re-punch/);

    await resetDb();
    await seedMasters();
    await seedFirstClub();
    reviewer = await loginAs('operations-executive');
    await upload('PO-199752.pdf', '%PDF-1.4 two').expect(201);
    const waiting = await upload('PO-199752.pdf', '%PDF-1.4 two', true).expect(409);
    expect(waiting.body.error.code).toBe('MANUAL_ALREADY_BLOCKED');
    expect(waiting.body.error.details.copies[0]).toMatchObject({ uploadId: null, status: 'uploaded', action: 'blocked' });
  });
});

describe('Safety net after the OCR', () => {
  it('a file that shows nothing in its name but reads as a PO still in review elsewhere: the NEWER copy is flagged, naming the older', async () => {
    const first = await copy('PO-199751.pdf', '%PDF-1.4 one');
    const second = await copy('scan 5 Nov.pdf', '%PDF-1.4 a scan of the same PO');
    expect(second.status).toBe('needs_review');
    const dup = await rows<{ details: string }>("SELECT details FROM po_issues WHERE upload_id = ? AND issue_type = 'DUPLICATE_PO'", [second.uploadId]);
    expect(dup).toHaveLength(1);
    expect(dup[0].details).toContain(`upload #${first.uploadId} (In Review)`);
    expect(await rows("SELECT id FROM po_issues WHERE upload_id = ? AND issue_type = 'DUPLICATE_PO'", [first.uploadId])).toEqual([]);
  });
});
