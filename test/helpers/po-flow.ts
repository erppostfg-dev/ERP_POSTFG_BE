import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../src/config/env';
import { FILES, PROVIDERS } from '../../src/constants';
import { syncEmailToS3 } from '../../src/modules/email-intake/s3-mirror.service';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import { runChainFor } from '../../src/modules/po-pipeline/pipeline.service';
import { db, rows } from './db';

/*
 * A PO through the REAL chain (2026-10-28), without Gmail or OCR: a BigBasket email folder is written to the test
 * storage as the intake would store it (metadata.json + the .xlsx + ocr-result.json + processed.json), copied to the
 * fake S3 by the real syncEmailToS3, then runChainFor() runs validation -> po_uploads / po_issues -> PO tables + sale
 * order + Uniware CSV, exactly as on dev. Returns the po_uploads row.
 */
export interface Upload { id: string; status: string; po_number: string; po_uid: string | null; uniware_csv_url: string | null; channel: string }

export const emailFolder = async (po: ProcessedPo): Promise<string> => {
  const name = `2026-10-26_${crypto.randomBytes(8).toString('hex')}`;
  const folder = path.resolve(env.storage.emailDir, 'po-intake', name);
  await fs.mkdir(folder, { recursive: true });
  const file = `${po.po_number.replace(/^[A-Z]+/, '')}.xlsx`;
  const meta = {
    messageId: `<test-${name}@bigbasket.com>`, from: 'BigBasket <alerts@bigbasket.com>', subject: `Big Basket WMS-Test-FC PO Details: PO No ${po.po_number} Pep Technologies Pvt Ltd`,
    receivedAt: '2026-10-26T04:00:00.000Z', storedAt: '2026-10-26T04:00:05.000Z', provider: PROVIDERS.GMAIL_PUBSUB, labels: ['Po-Intake'], files: [file],
  };
  await fs.writeFile(path.join(folder, FILES.METADATA), JSON.stringify(meta, null, 2));
  await fs.writeFile(path.join(folder, file), 'not a real sheet: the tests start from processed.json');
  await fs.writeFile(path.join(folder, FILES.OCR_RESULT), JSON.stringify({ status: 'ok', files: [file], startedAt: meta.storedAt, finishedAt: meta.storedAt, durationMs: 1 }));
  await fs.writeFile(path.join(folder, FILES.PROCESSED), JSON.stringify(po, null, 2));
  await syncEmailToS3(folder);
  return folder;
};

/** The PO through the chain; its po_uploads row afterwards. */
export const runPo = async (po: ProcessedPo): Promise<Upload> => {
  await db();
  const folder = await emailFolder(po);
  await runChainFor(folder);
  const [u] = await rows<Upload>('SELECT id, status, po_number, po_uid, uniware_csv_url, channel FROM po_uploads WHERE po_number = ? ORDER BY id DESC LIMIT 1', [po.po_number]);
  if (!u) throw new Error(`runPo: no po_uploads row for ${po.po_number}`);
  return u;
};
