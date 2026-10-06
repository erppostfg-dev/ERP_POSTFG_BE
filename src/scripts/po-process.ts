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
import { hasRawOutput } from '../modules/po-processing/common/raw-reader';
import { processPo } from '../modules/po-processing/po-router';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const folder = arg('folder');
  const label = arg('label');
  const channel = arg('channel');
  if (!folder && !label) throw new Error('Give --folder <PO folder> or --label <label folder> [--channel <name>]');

  let folders: string[];
  if (folder) folders = [folder];
  else {
    folders = [];
    const root = path.resolve(env.storage.emailDir, label as string);
    for (const d of await fs.readdir(root, { withFileTypes: true })) {
      const dir = path.join(root, d.name);
      if (!d.isDirectory() || !(await hasRawOutput(dir))) continue;
      if (channel) {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')) as StoredMetadata;
        const detected = detectChannel(emailInfo(meta));
        if (!('config' in detected) || detected.config.channel !== channel) continue;
      }
      folders.push(dir);
    }
  }

  let ok = 0;
  for (const f of folders) {
    const r = await processPo(f);
    if (r.status === 'ok') ok++;
    const detail =
      r.status === 'ok'
        ? `${r.channel} ${r.poNumber}: ${r.lines} line(s), ${r.warnings?.length ?? 0} warning(s) -> ${r.s3Folder ? `${r.s3Folder}/processed.json` : 'processed.json (local only)'}`
        : `${r.channel ? `${r.channel}: ` : ''}${r.reason}`;
    console.log(`${path.basename(f)}  ${r.status}  ${detail}`);
    for (const w of r.warnings ?? []) console.log(`    warning: ${w}`);
  }
  console.log(`\n${ok} of ${folders.length} processed`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
