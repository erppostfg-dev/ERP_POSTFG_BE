import fs from 'fs/promises';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';
import { syncEmailToS3 } from '../../src/modules/email-intake/s3-mirror.service';

/*
 * Read again, no OCR (2026-11-04, user: Gluzo 1922973 went to review because the OCR named its columns differently; the
 * reader is fixed): POST /po-review/bulk-reread rebuilds a PO in review / failed from its STORED OCR output with today's
 * reader and checks it again (old issues closed). Here "today's reader" is a stand-in that writes the corrected
 * processed.json (the real readers have their own tests), so this tests the flow, not a channel.
 */
covers(['POST /po-review/bulk-reread']);

const reader = vi.hoisted(() => ({ runs: 0, fixedLocation: '' }));
vi.mock('../../src/modules/po-processing/po-router', async (orig) => ({
  ...(await orig<object>()),
  processPo: vi.fn(async (folder: string) => {
    reader.runs++;
    const file = path.join(folder, 'processed.json');
    const po = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, JSON.stringify({ ...po, delivery_facility_code: reader.fixedLocation }));
    return { status: 'ok' };
  }),
}));

const V = '/api/v1/po-review';
let m: Masters;
let editor: TestLogin;
const folderOf = async (u: Upload) => {
  const [r] = await rows<{ email_message_id: string }>('SELECT email_message_id FROM po_uploads WHERE id = ?', [u.id]);
  const root = path.resolve(env.storage.emailDir, 'po-intake');
  for (const d of await fs.readdir(root)) {
    const meta = JSON.parse(await fs.readFile(path.join(root, d, 'metadata.json'), 'utf8').catch(() => '{}')) as { messageId?: string };
    if (meta.messageId === r.email_message_id) return path.join(root, d);
  }
  throw new Error('no folder');
};
const statusOf = async (u: Upload) => (await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status;
const reread = (ids: string[]) => api().post(`${V}/bulk-reread`).set('Cookie', editor.cookie).send({ uploadIds: ids });

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  editor = await loginAs('operations-executive');
  reader.runs = 0;
  reader.fixedLocation = m.locationCode;
});
afterAll(closeDb);

describe('Read again (no OCR)', () => {
  it('a PO in review: rebuilt from its stored OCR output, checked again -> completed, its old issue closed', async () => {
    const u = await runPo(bigBasketPo(m, { po_number: 'IRA96500001', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    expect(u.status).toBe('needs_review');
    // the OCR output is kept in S3 with the PO's files (as the chain does)
    const dir = await folderOf(u);
    await fs.writeFile(path.join(dir, 'ocr-raw.json'), '{"line_items": []}');
    await syncEmailToS3(dir);
    const r = (await reread([u.id]).expect(200)).body.data;
    expect(r[0]).toMatchObject({ result: 'queued', reason: 'read again from the stored OCR output (no OCR cost)' });
    await vi.waitFor(async () => expect(await statusOf(u)).toBe('completed'), { timeout: 15_000 });
    expect(reader.runs).toBe(1);
    const issues = await rows<{ status: string }>('SELECT status FROM po_issues WHERE upload_id = ?', [u.id]);
    expect(issues.every((i) => i.status !== 'open')).toBe(true);
  });

  it('refused with why: no stored OCR output, not in review / failed; editor only', async () => {
    const noRaw = await runPo(bigBasketPo(m, { po_number: 'IRA96500002', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const done = await runPo(bigBasketPo(m, { po_number: 'IRA96500003' }));
    const r = (await reread([noRaw.id, done.id]).expect(200)).body.data as { uploadId: string; result: string; reason: string }[];
    expect(r.find((x) => x.uploadId === noRaw.id)).toMatchObject({ result: 'skipped', reason: 'no stored OCR output: use Try again (OCR again)' });
    expect(r.find((x) => x.uploadId === done.id)?.reason).toContain('only a PO in review or failed');
    expect(await statusOf(noRaw)).toBe('needs_review');
    const viewer = await loginAs('viewer');
    expect((await api().post(`${V}/bulk-reread`).set('Cookie', viewer.cookie).send({ uploadIds: [noRaw.id] })).status).toBe(403);
    // an API channel's PO: its connector reads it again
    await (await db()).query("UPDATE po_uploads SET source = 'api' WHERE id = ?", [noRaw.id]);
    expect((await reread([noRaw.id])).body.data[0].reason).toContain('connector');
  });
});
