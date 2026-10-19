/*
 * Rewrites the old sale order codes (sf_...) to the new prefix (erp_...) inside the Uniware CSVs already made
 * (user, 2026-10-19). The DB values are renamed by migration SaleOrderPrefixErp; this does the files.
 * DRY RUN by default: lists every CSV of po_uploads.uniware_csv_url and the codes it would change.
 * --apply: writes each changed CSV back to the same S3 key (overwrite, nothing deleted) and to its local copy under
 * the email storage when there is one. File names stay the same.
 *
 *   npm run sale-orders:prefix            (dry run)
 *   npm run sale-orders:prefix -- --apply
 */
import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import { Not, IsNull } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { OLD_SALE_ORDER_CODE, SALE_ORDER_CODE } from '../constants';
import { PoUpload } from '../entities';
import { openS3File, writeS3Text } from '../modules/email-intake/s3-mirror.service';

const APPLY = process.argv.includes('--apply');

const streamText = async (s3Url: string): Promise<string | undefined> => {
  const f = await openS3File(s3Url);
  if (!f) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of f.body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

/** Local copies with this file name under the email storage (the CSV is written there first, then mirrored). */
const localCopies = async (name: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.name === name) out.push(p);
    }
  };
  await walk(path.resolve(env.storage.emailDir));
  return out;
};

const rename = (text: string) => text.replace(OLD_SALE_ORDER_CODE, `${SALE_ORDER_CODE.PREFIX}$1`);

const main = async () => {
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? 'APPLY: CSVs are rewritten' : 'DRY RUN: nothing is written');
  let changed = 0;
  try {
    const uploads = await AppDataSource.getRepository(PoUpload).find({ where: { uniwareCsvUrl: Not(IsNull()) }, order: { id: 'ASC' } });
    for (const u of uploads) {
      const url = u.uniwareCsvUrl!;
      const text = await streamText(url);
      if (text === undefined) { console.log(`  upload ${u.id}: CSV not found in S3 (${url})`); continue; }
      const codes = [...new Set(text.match(OLD_SALE_ORDER_CODE) ?? [])];
      if (!codes.length) { console.log(`  upload ${u.id}: already ${SALE_ORDER_CODE.PREFIX} (${path.posix.basename(url)})`); continue; }
      const next = rename(text);
      const locals = await localCopies(path.posix.basename(url));
      console.log(`  upload ${u.id} ${u.poNumber}: ${codes.join(', ')} -> ${codes.map(rename).join(', ')}  (S3 + ${locals.length} local cop${locals.length === 1 ? 'y' : 'ies'})`);
      if (APPLY) {
        await writeS3Text(url, next);
        for (const l of locals) await fs.writeFile(l, rename(await fs.readFile(l, 'utf8')));
      }
      changed++;
    }
    console.log(`${changed} CSV(s) ${APPLY ? 'rewritten' : 'to rewrite'}.${APPLY ? '' : ' Add --apply to write.'}`);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
