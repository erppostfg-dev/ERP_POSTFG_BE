/*
 * Run extractPo() by hand on stored emails (no server needed).
 *
 *   npm run ocr:run -- --folder storage/emails/po-intake/2026-09-30_13467832c737188e
 *   npm run ocr:run -- --label po-intake            (every stored email in that label folder)
 *   npm run ocr:run -- --label po-intake --detect   (only show which channel each email is; no OCR)
 */
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { detectChannel, emailInfo, StoredMetadata } from '../modules/ocr/channel-detector';
import { extractPo } from '../modules/ocr/extract-po.service';
import { ERROR_CODES, FILES } from '../constants';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const folder = arg('folder');
  const label = arg('label');
  if (!folder && !label) throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <email folder> or --label <label folder>');

  const folders = folder
    ? [folder]
    : (await fs.readdir(path.resolve(env.storage.emailDir, label as string), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => path.join(env.storage.emailDir, label as string, d.name));

  for (const f of folders) {
    if (process.argv.includes('--detect')) {
      const meta = JSON.parse(await fs.readFile(path.join(f, FILES.METADATA), 'utf8')) as StoredMetadata;
      const d = detectChannel(emailInfo(meta));
      console.log(`${path.basename(f)}  ${'config' in d ? `-> ${d.config.channel}` : `skip: ${d.reason}`}  "${meta.subject ?? ''}"`);
      continue;
    }
    const r = await extractPo(f);
    console.log(`${path.basename(f)}  ${r.status}${r.channel ? ` (${r.channel})` : ''}${r.reason ? `: ${r.reason}` : ''}`);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
