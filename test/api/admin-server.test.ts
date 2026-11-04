import fs from 'fs/promises';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';
import { syncEmailToS3 } from '../../src/modules/email-intake/s3-mirror.service';

/*
 * Admin > Server (2026-11-04, user: "does it fill the server disk?"; developers only): how full the disk is, the local
 * cleanup's switch / rules / last run, and running it now. The cleanup now also removes the LOCAL copy of POs failed
 * (or dismissed), in review or waiting for approval for 7 days (S3 keeps everything); a fresh one keeps its folder.
 */
covers(['GET /admin/server', 'POST /admin/server/cleanup']);

const V = '/api/v1/admin/server';
let m: Masters;
let dev: TestLogin;

const folderOf = async (u: Upload) => {
  const [r] = await rows<{ email_message_id: string }>('SELECT email_message_id FROM po_uploads WHERE id = ?', [u.id]);
  const root = path.resolve(env.storage.emailDir, 'po-intake');
  for (const d of await fs.readdir(root)) {
    const meta = JSON.parse(await fs.readFile(path.join(root, d, 'metadata.json'), 'utf8').catch(() => '{}')) as { messageId?: string };
    if (meta.messageId === r.email_message_id) return path.join(root, d);
  }
  return null;
};
const age = async (u: Upload, status: string, days: number) =>
  (await db()).query('UPDATE po_uploads SET status = ?, updated_at = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id = ?', [status, days, u.id]);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  dev = await loginAs('developer');
});
afterAll(closeDb);

describe('Admin > Server', () => {
  it('developers only; the disk used and the cleanup rules', async () => {
    const admin = await loginAs('admin');
    expect((await api().get(V).set('Cookie', admin.cookie)).body.error.code).toBe('DEVELOPER_ONLY');
    expect((await api().get(V)).status).toBe(401);
    const d = (await api().get(V).set('Cookie', dev.cookie).expect(200)).body.data;
    expect(d.disk.usedPct).toBeGreaterThanOrEqual(0);
    expect(d.disk.totalBytes).toBeGreaterThan(0);
    expect(d).toMatchObject({ thresholds: { warnPct: 80, errorPct: 90 }, cleanup: { minAgeHours: 24, staleDays: 7 } });
    expect((await api().post(`${V}/cleanup`).set('Cookie', admin.cookie).send({})).status).toBe(403);
    expect((await api().post(`${V}/cleanup`).set('Cookie', dev.cookie).send({ apply: 'yes' })).status).toBe(400);
  });

  it('cleanup: failed / in review for 7 days lose the LOCAL copy (S3 keeps it); a fresh one keeps it; dry run first', async () => {
    const failedOld = await runPo(bigBasketPo(m, { po_number: 'IRA99000001', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const reviewOld = await runPo(bigBasketPo(m, { po_number: 'IRA99000002', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const reviewNew = await runPo(bigBasketPo(m, { po_number: 'IRA99000003', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    await age(failedOld, 'failed', 8);
    await age(reviewOld, 'needs_review', 8);
    await age(reviewNew, 'needs_review', 1);
    const dirs = await Promise.all([failedOld, reviewOld, reviewNew].map(folderOf));
    expect(dirs.every(Boolean)).toBe(true);
    // every file in S3 first, as the server's mirror does (never removed without a full S3 copy)
    for (const d of dirs) await syncEmailToS3(d!);

    const dry = (await api().post(`${V}/cleanup`).set('Cookie', dev.cookie).send({}).expect(200)).body.data;
    expect(dry.run).toMatchObject({ apply: false, removed: 2 });
    for (const d of dirs) expect(await fs.access(d!).then(() => true, () => false)).toBe(true);

    const run = (await api().post(`${V}/cleanup`).set('Cookie', dev.cookie).send({ apply: true }).expect(200)).body.data;
    expect(run.run).toMatchObject({ apply: true, removed: 2 });
    expect(run.cleanup.last.at).toBeTruthy();
    const left = await Promise.all(dirs.map((d) => fs.access(d!).then(() => true, () => false)));
    expect(left).toEqual([false, false, true]);
    // the POs themselves are untouched
    expect((await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id IN (?, ?) ORDER BY id', [failedOld.id, reviewOld.id])).map((r) => r.status)).toEqual(['failed', 'needs_review']);
  });
});
