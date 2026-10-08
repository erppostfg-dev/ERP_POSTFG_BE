/*
 * Validate processed.json files against the master data in the DB. READ-ONLY: reads the DB, writes nothing there.
 * Prints one line per PO and its issues, and writes a report (one row per issue, or one "valid" row per PO) to
 * storage/validation/validation-<date>.csv.
 *
 *   npm run po:validate -- --label po-intake                    (every processed.json there, incl. POs/<PO>/)
 *   npm run po:validate -- --label po-intake --channel zepto    (only that channel)
 *   npm run po:validate -- --folder storage/emails/po-intake/2026-10-01_1461bdc39c715719
 */
import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { ChannelName, ERROR_CODES, FILES, FOLDERS, VALIDATION_STATUS } from '../constants';
import { ProcessedPo } from '../modules/po-processing/common/processed-po';
import { MasterDataReader } from '../modules/po-validation/master-data';
import { todayIst, validatePo, ValidationResult } from '../modules/po-validation/validate-po';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

/** processed.json of an email folder: its own, and one per PO under POs/<PO>/ (Purplle). */
const processedFiles = async (folder: string): Promise<string[]> => {
  const files: string[] = [];
  if (await exists(path.join(folder, FILES.PROCESSED))) files.push(path.join(folder, FILES.PROCESSED));
  const posDir = path.join(folder, FOLDERS.POS);
  if (await exists(posDir)) {
    for (const d of await fs.readdir(posDir, { withFileTypes: true })) {
      const f = path.join(posDir, d.name, FILES.PROCESSED);
      if (d.isDirectory() && (await exists(f))) files.push(f);
    }
  }
  return files;
};

const csvCell = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const main = async (): Promise<void> => {
  const folder = arg('folder');
  const label = arg('label');
  const channel = arg('channel');
  if (!folder && !label) {
    throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <email folder> or --label <label folder> [--channel <name>]');
  }

  const folders = folder
    ? [folder]
    : (await fs.readdir(path.resolve(env.storage.emailDir, label as string), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => path.resolve(env.storage.emailDir, label as string, d.name));

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  const reader = new MasterDataReader(AppDataSource);
  const results: { file: string; po: ProcessedPo; r: ValidationResult }[] = [];
  try {
    for (const f of folders) {
      for (const file of await processedFiles(f)) {
        const po = JSON.parse(await fs.readFile(file, 'utf8')) as ProcessedPo;
        if (channel && po.channel_name !== channel) continue;
        const r = await validatePo(po, await reader.forChannel(po.channel_name as ChannelName));
        results.push({ file, po, r });
      }
    }
  } finally {
    await AppDataSource.destroy();
  }

  results.sort((a, b) => a.r.channel.localeCompare(b.r.channel) || a.r.poNumber.localeCompare(b.r.poNumber));
  const rows: string[][] = [['channel', 'po_number', 'status', 'issue_type', 'line_no', 'expected', 'actual', 'message', 'file']];
  for (const { file, po, r } of results) {
    const loc = r.location ? `${r.location.customerCode} (${r.location.matchedBy})` : '-';
    const total = r.totals.poValue === '' ? 'total not checked' : `total ${r.totals.poValue} vs ${r.totals.ourValue} (${r.totals.difference})`;
    console.log(`${r.channel.padEnd(9)} ${r.poNumber.padEnd(20)} ${r.status.padEnd(12)} ${po.line_items.length} line(s), ${r.issues.length} issue(s) | ${loc} | ${total}`);
    for (const i of r.issues) console.log(`      [${i.type}] ${i.message}`);
    const rel = path.relative(process.cwd(), file);
    if (!r.issues.length) rows.push([r.channel, r.poNumber, r.status, '', '', '', '', '', rel]);
    for (const i of r.issues) {
      rows.push([r.channel, r.poNumber, r.status, i.type, String(i.lineNo ?? ''), String(i.expected ?? ''), String(i.actual ?? ''), i.message, rel]);
    }
  }

  // Summary per channel and per issue type.
  const perChannel = new Map<string, { pos: number; valid: number }>();
  const perType = new Map<string, number>();
  for (const { r } of results) {
    const c = perChannel.get(r.channel) ?? { pos: 0, valid: 0 };
    c.pos++;
    if (r.status === VALIDATION_STATUS.VALID) c.valid++;
    perChannel.set(r.channel, c);
    for (const i of r.issues) perType.set(i.type, (perType.get(i.type) ?? 0) + 1);
  }
  console.log('\nper channel (valid / POs):', [...perChannel].map(([k, v]) => `${k} ${v.valid}/${v.pos}`).join(', '));
  console.log('issues by type:', [...perType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none');

  const dir = path.resolve(env.storage.emailDir, '..', FOLDERS.VALIDATION);
  await fs.mkdir(dir, { recursive: true });
  const report = path.join(dir, FILES.VALIDATION_REPORT(todayIst()));
  await fs.writeFile(report, `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
  console.log(`\n${results.length} PO(s) validated, nothing written to the DB. Report: ${path.relative(process.cwd(), report)}`);
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
