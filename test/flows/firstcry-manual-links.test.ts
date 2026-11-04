import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPo } from '../../src/modules/ocr/extract-po.service';
import { closeDb, resetDb } from '../helpers/db';

/*
 * Firstcry by Manual Upload (2026-11-04, bug: every Firstcry manual upload failed "download failed: PO Excel: no link
 * with text /download PO Excel/i"): Firstcry emails carry download links, so the OCR step downloads the Excel from the
 * email body first; a Manual Upload has no email body but already holds the .xls. Now: a manual upload that has the
 * file the channel needs skips the link download; an email still downloads from its link.
 * The link download and the OCR run are replaced by recorders (no network, no OCR cost).
 */

const fake = vi.hoisted(() => ({ downloads: 0, ocrInputs: [] as string[][] }));
vi.mock('../../src/modules/ocr/link-downloader', async (orig) => ({
  ...(await orig<object>()),
  downloadLinkedFiles: vi.fn(async () => { fake.downloads++; return { downloaded: [], missingRequired: ['PO Excel: no link with text /download PO Excel/i'] }; }),
}));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async (_ch: string, files: string[]) => { fake.ocrInputs.push(files.map((f) => path.basename(f))); return { status: 'failed', reason: 'OCR is replaced in tests', durationMs: 1 }; }),
}));

const XLS = 'PEP_TECHNOLOGIES_PVT._LTD.(Mcaffeine-Stockist)_pin224261031xbt2428.xls';
const folder = async (meta: Record<string, unknown>, files: string[], body = '') => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'firstcry-'));
  for (const f of files) await fs.writeFile(path.join(dir, f), 'x');
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ ...meta, files: files.map((filename) => ({ filename, size: 1 })) }));
  await fs.writeFile(path.join(dir, 'body.txt'), body);
  return dir;
};

beforeEach(async () => {
  await resetDb();
  fake.downloads = 0;
  fake.ocrInputs = [];
});
afterAll(closeDb);

describe('Firstcry links', () => {
  it('Manual Upload with the .xls: no link download, the uploaded Excel goes to the OCR', async () => {
    const dir = await folder({ provider: 'manual', channel: 'firstcry', subject: 'Manual Upload', receivedAt: new Date().toISOString() }, [XLS]);
    const r = await extractPo(dir);
    expect(fake.downloads).toBe(0);
    expect(r.code).not.toBe('OCR_DOWNLOAD_FAILED');
    expect(fake.ocrInputs).toEqual([[XLS]]);
  });

  it('an email (no attachment, a download link): the link is still downloaded first', async () => {
    const dir = await folder({
      provider: 'gmail-pubsub', from: 'noreply@firstcry.com', subject: 'Stockist PONO pin224261031xbt2428 for Allied TradeComm', receivedAt: new Date().toISOString(),
    }, [], 'download PO Excel');
    const r = await extractPo(dir);
    expect(fake.downloads).toBe(1);
    expect(r.code).toBe('OCR_DOWNLOAD_FAILED');
  });
});
