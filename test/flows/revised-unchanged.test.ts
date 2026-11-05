import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { CHANNEL_MASTER_IDS, CHANNELS, FILES, PROVIDERS } from '../../src/constants';
import { s3UrlOfKey, writeS3File } from '../../src/modules/email-intake/s3-mirror.service';
import { readXlsxRows } from '../../src/modules/intransit/sources/files';
import { xlsxBytes } from '../../src/modules/intransit/xlsx-lite';
import { emailStored } from '../../src/modules/po-pipeline/pipeline.service';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';

/*
 * Blinkit "revised" re-sends (backlog B7 part B, 2026-11-05): before any OCR, the new email's sheet is compared with the
 * sheet of the copy already in POST_FG. The same sheet -> not taken (no po_uploads row, no OCR, an
 * INTAKE_REVISED_UNCHANGED log line); a changed sheet (e.g. an MRP corrected) or no copy to compare -> taken as today.
 * Excel rows: the backend's xlsx reader here (sheet_rows.py on the server), so the test needs no Python.
 */
vi.mock('../../src/modules/ocr/excel-rows', () => ({
  excelRows: vi.fn(async (file: string) => readXlsxRows(new Uint8Array(await fs.readFile(file)))),
}));

const PO = '50033210082619';
const SUBJECT = `PO_BCPL - Mumbai M12 - Feeder_MUMBAI_Mumbai M12 - Feeder Warehouse_Pep Technologies Pvt. Ltd.-${PO} : 2026-10-26`;
const sheet = (mrp: number) => Buffer.from(xlsxBytes([{
  name: 'PO', columns: ['Item Id', 'Item Name', 'Quantity', 'MRP', 'Landing Rate', 'Total Amount'].map((header) => ({ header })),
  rows: [['10119953', 'Coffee Body Scrub 75 g', 48, mrp, 64.97, 3118.56], ['10139110', 'Body Wash 300 ml', 24, 297, 216.81, 5203.44]],
}]));

/** The copy already in POST_FG: its row + its sheet in S3 (as the chain stores it). */
const earlierCopy = async (status: string, mrp = 89) => {
  const folder = `po-intake/FY2627/october/blinkit/2026-10-26_earlier`;
  await writeS3File(s3UrlOfKey(`${folder}/${PO}_20261026_063126.xlsx`), sheet(mrp));
  await writeS3File(s3UrlOfKey(`${folder}/${PO}_20261026_063126.pdf`), Buffer.from('%PDF-1.4'));
  return insert('po_uploads', {
    source: 'email', channel: 'Blinkit', po_number: PO, status, email_message_id: '<earlier@partnersbiz.com>',
    file_name: `${PO}_20261026_063126.pdf`, file_url: s3UrlOfKey(`${folder}/${PO}_20261026_063126.pdf`), created_at: new Date(), updated_at: new Date(),
  });
};
/** The new email as the intake stores it: metadata + body + the PDF and the sheet. */
const revisedEmail = async (mrp: number, body = 'Dear Supply Partner\nThis Purchase Order has been REVISED. Kindly Download Revised PO Attachment present in the mail.') => {
  const name = `2026-11-03_${crypto.randomBytes(6).toString('hex')}`;
  const folder = path.resolve(env.storage.emailDir, 'po-intake', name);
  await fs.mkdir(folder, { recursive: true });
  const files = [`${PO}_20261103_062934.pdf`, `${PO}_20261103_062934.xlsx`];
  const messageId = `<revised-${name}@partnersbiz.com>`;
  await fs.writeFile(path.join(folder, FILES.METADATA), JSON.stringify({
    messageId, from: 'Blinkit <ordering@partnersbiz.com>', subject: SUBJECT, receivedAt: '2026-11-03T06:29:37.000Z', storedAt: '2026-11-03T06:29:40.000Z',
    provider: PROVIDERS.GMAIL_PUBSUB, labels: ['Po-Intake'], files,
  }));
  await fs.writeFile(path.join(folder, FILES.BODY_TEXT), body);
  await fs.writeFile(path.join(folder, files[0]), '%PDF-1.4');
  await fs.writeFile(path.join(folder, files[1]), sheet(mrp));
  return { folder, messageId };
};
const rowsFor = (messageId: string) => rows<{ status: string }>('SELECT status FROM po_uploads WHERE email_message_id = ?', [messageId]);

beforeEach(async () => {
  await resetDb();
  await seedMasters();
  await insert('master_channels', { id: CHANNEL_MASTER_IDS[CHANNELS.BLINKIT], slug: 'blinkit', display_name: 'Blinkit', db_aliases: ['Blinkit'], has_processor: 0, is_active: 1 });
});
afterAll(closeDb);

describe('Blinkit "revised" emails compared before the OCR', () => {
  it('the same sheet as the copy we have (completed): not taken, no row, no OCR', async () => {
    await earlierCopy('completed');
    const { folder, messageId } = await revisedEmail(89);
    expect(await emailStored(folder)).toBe(false);
    expect(await rowsFor(messageId)).toEqual([]);
  });

  it('the same sheet while the copy is still In Review: not taken either (that copy stays the one in review)', async () => {
    await earlierCopy('needs_review');
    const { folder, messageId } = await revisedEmail(89);
    expect(await emailStored(folder)).toBe(false);
    expect(await rowsFor(messageId)).toEqual([]);
  });

  it('a changed sheet (MRP 99 -> 89 on a line): taken as today (a po_uploads row; held while Blinkit intake is off)', async () => {
    await earlierCopy('completed', 99);
    const { folder, messageId } = await revisedEmail(89);
    await emailStored(folder);
    expect((await rowsFor(messageId)).map((r) => r.status)).toEqual(['held']);
  });

  it('nothing to compare with (the earlier copy was rejected) -> taken as today', async () => {
    await earlierCopy('rejected');
    const { folder, messageId } = await revisedEmail(89);
    await emailStored(folder);
    expect(await rowsFor(messageId)).toHaveLength(1);
  });
});
