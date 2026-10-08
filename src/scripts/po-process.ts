/*
 * Turn raw OCR output into processed.json by hand (no server needed). Never runs the OCR.
 * Writes processed.json into the PO folder and uploads it to the PO's S3 folder (when S3_ENABLED).
 *
 *   npm run po:process -- --folder storage/emails/po-intake/2026-10-05_fde0d83759089a5c
 *   npm run po:process -- --label po-intake                    (every PO there that has raw OCR output)
 *   npm run po:process -- --label po-intake --channel blinkit  (only that channel)
 */
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { detectChannel, emailInfo, StoredMetadata } from '../modules/ocr/channel-detector';
import { POS_DIR } from '../modules/po-processing/common/processed-store';
import { hasRawOutput } from '../modules/po-processing/common/raw-reader';
import { processPo } from '../modules/po-processing/po-router';
import { ERROR_CODES, FILES, RESULT_STATUS } from '../constants';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const folder = arg('folder');
  const label = arg('label');
  const channel = arg('channel');
  if (!folder && !label) {
    throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <PO folder> or --label <label folder> [--channel <name>]');
  }

  let folders: string[];
  if (folder) folders = [folder];
  else {
    folders = [];
    const root = path.resolve(env.storage.emailDir, label as string);
    for (const d of await fs.readdir(root, { withFileTypes: true })) {
      const dir = path.join(root, d.name);
      if (!d.isDirectory() || !(await hasRawOutput(dir))) continue;
      if (channel) {
        const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as StoredMetadata;
        const detected = detectChannel(emailInfo(meta));
        if (!('config' in detected) || detected.config.channel !== channel) continue;
      }
      folders.push(dir);
    }
  }

  let ok = 0;
  for (const f of folders) {
    const r = await processPo(f);
    if (r.status === RESULT_STATUS.OK) ok++;
    const target = r.pos ? `${POS_DIR}/<PO>/${FILES.PROCESSED}` : FILES.PROCESSED;
    const detail =
      r.status === RESULT_STATUS.OK
        ? `${r.channel} ${r.poNumber}: ${r.lines} line(s), ${r.warnings?.length ?? 0} warning(s) -> ${r.s3Folder ? `${r.s3Folder}/${target}` : `${target} (local only)`}`
        : `${r.channel ? `${r.channel}: ` : ''}[${r.code}] ${r.reason}`;
    console.log(`${path.basename(f)}  ${r.status}  ${detail}`);
    for (const p of r.pos ?? []) {
      const review = p.needsReview ? '  NEEDS REVIEW' : '';
      const missing = p.missingFields.length ? `  missing: ${p.missingFields.join(', ')}` : '';
      console.log(`    ${p.poNumber} ${p.poType}: ${p.lines} line(s)${review}${missing}`);
    }
    for (const w of r.warnings ?? []) console.log(`    warning [${w.code}]: ${w.message}`);
  }
  console.log(`\n${ok} of ${folders.length} processed`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
