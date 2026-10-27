/*
 * Move the in-transit disk store (INTRANSIT_DIR) into S3 (plan phase S5, user 2026-10-26). Run it on the live server
 * once the AWS admin has set the lifecycle rules and rights; with INTRANSIT_TEST=true it writes inventory-test/ instead
 * (a trial: the database is then left alone).
 *
 *   npm run intransit:s3-migrate                 DRY RUN: what would go where, nothing written
 *   npm run intransit:s3-migrate -- --apply      upload (a key already holding the same content is skipped), then point
 *                                                the moved builds at S3 (report_path, result.files, the day's final
 *                                                build) and redo the weekly/monthly copies
 *   ... --verify                                 check every planned key is in S3 with the same sha256
 *   ... --verify --purge                         after a clean verify: rename INTRANSIT_DIR to <dir>.moved-<day> (kept,
 *                                                not deleted; remove it by hand once happy)
 *
 * What goes: daily inputs of the last 30 days (with their replaced versions), the report template and its history,
 * the master CSVs + history + import/ + cache/ (Masters/Legacy/), succeeded builds of the last 90 days (workbook, combo
 * files, run.json, every sheet, the Daily Snapshot), the weekly/monthly winners of any age, refused files of the last
 * 30 days. Not moved: inventory.json, _deleted/, raw connector downloads, compare/parity output.
 */
import 'reflect-metadata';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import {
  COMBO_CHECK, INPUT_BY_NAME, INTRANSIT_FOLDERS, INTRANSIT_REPORT_NAME, INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS, INTRANSIT_TEMPLATE_NAME, isMasterInput,
  RUN_RECORD_FILE, SHEET_FRAMES,
} from '../constants';
import { IntransitRun } from '../entities';
import { dailyRoot, istToday, masterHistoryDir, mastersDir, readMeta } from '../modules/intransit/input-store';
import {
  buildFolderName, fullReportDir, inputKey, isoWeekOf, legacyPrefix, monthlyKey, newStamp, refusedKey, SNAPSHOT_SHEETS, snapshotDir, templateKey, weeklyKey,
} from '../modules/intransit/s3/layout';
import { catchUpPeriods } from '../modules/intransit/s3/periods';
import { repointDay } from '../modules/intransit/s3/run-store';
import { PROD_SCOPE, storageProblems, writeScope } from '../modules/intransit/s3/scope';
import { digest, head, ObjMeta, put } from '../modules/intransit/s3/store';
import { readXlsxSheet, toCsv } from '../modules/intransit/sources/files';

interface Item {
  key: string;
  /** a file, or bytes made now (a sheet taken from a workbook) */
  from: string | (() => Promise<Buffer>);
  meta: Omit<ObjMeta, 'sha256'>;
  what: string;
}

const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const DIR = (): string => path.resolve(env.intransit.dir);
const exists = (p: string): boolean => fs.existsSync(p);
const files = async (dir: string): Promise<string[]> =>
  (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])).filter((d) => d.isFile() && !d.name.endsWith('.meta.json') && !d.name.endsWith('.part')).map((d) => path.join(dir, d.name));
const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else if (d.isFile() && !d.name.endsWith('.part')) out.push(p);
  }
  return out;
};
const mtime = async (file: string): Promise<Date> => (await fsp.stat(file)).mtime;

/** The planned uploads, and the builds to point at S3 afterwards. */
const plan = async (): Promise<{ items: Item[]; runs: { run: IntransitRun; folder: string; files: Record<string, string> }[] }> => {
  const scope = writeScope();
  const items: Item[] = [];
  const keep = daysAgo(30);

  // ---- daily inputs of the last 30 days, with their replaced versions
  for (const day of (await fsp.readdir(dailyRoot()).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= keep)) {
    const dir = path.join(dailyRoot(), day);
    const versions = [...(await files(dir)), ...(await files(path.join(dir, INTRANSIT_FOLDERS.REPLACED)))];
    for (const file of versions) {
      const name = path.basename(file).replace(/^.*__/, '');
      if (!INPUT_BY_NAME.has(name) || isMasterInput(name)) continue;
      const meta = await readMeta(file);
      const at = meta?.at ? new Date(meta.at) : await mtime(file);
      items.push({ key: inputKey(scope, name, day, newStamp(at)), from: file, meta: { byId: meta?.by ?? null, byName: meta?.byName ?? null, source: meta?.source ?? 'migrated', day, origName: name }, what: 'daily input' });
    }
  }

  // ---- the report template and its earlier versions
  const template = path.join(mastersDir(), INTRANSIT_TEMPLATE_NAME);
  for (const file of [...(exists(template) ? [template] : []), ...(await files(masterHistoryDir(INTRANSIT_TEMPLATE_NAME)))]) {
    const meta = await readMeta(file);
    items.push({ key: templateKey(scope, newStamp(meta?.at ? new Date(meta.at) : await mtime(file))), from: file, meta: { byId: meta?.by ?? null, byName: meta?.byName ?? null, source: 'migrated', origName: INTRANSIT_TEMPLATE_NAME }, what: 'template' });
  }

  // ---- the old CSV masters, their history, import/ and cache/: an archive (Masters/Legacy/)
  const templateHistory = masterHistoryDir(INTRANSIT_TEMPLATE_NAME);
  for (const root of [mastersDir(), path.join(DIR(), 'import'), path.join(DIR(), INTRANSIT_FOLDERS.CACHE)]) {
    for (const file of await walk(root)) {
      if (file === template || file.startsWith(templateHistory)) continue;
      const rel = path.relative(DIR(), file).split(path.sep).join('/');
      items.push({ key: `${legacyPrefix(scope)}${rel}`, from: file, meta: { source: 'migrated', origName: path.basename(file) }, what: 'legacy' });
    }
  }

  // ---- builds
  const reports = (await AppDataSource.getRepository(IntransitRun).find({ where: { kind: INTRANSIT_RUN_KIND.REPORT, status: INTRANSIT_RUN_STATUS.SUCCEEDED }, order: { id: 'ASC' } }))
    .filter((r) => r.asOf && !(r.options as { scope?: string } | null)?.scope && !r.reportPath?.startsWith('s3:'));
  const workbookOf = (r: IntransitRun): string => path.join(DIR(), INTRANSIT_FOLDERS.RUNS, r.id, INTRANSIT_REPORT_NAME);
  const runs: { run: IntransitRun; folder: string; files: Record<string, string> }[] = [];
  const recent = daysAgo(90);
  for (const r of reports) {
    const workbook = workbookOf(r);
    if (!exists(workbook)) continue;
    const day = r.asOf as string;
    const meta = { byId: r.createdBy, byName: (r.options as { byName?: string } | null)?.byName ?? null, source: 'migrated', runId: r.id, day };
    if (day < recent) {
      // older than 90 days: only a week's / month's final build is kept (its copy, forever; live server only)
      if (scope !== PROD_SCOPE) continue;
      if (isoWeekWinner(reports, r, workbookOf)) items.push({ key: weeklyKey(scope, day).key, from: workbook, meta: { ...meta, source: 'period' }, what: 'weekly copy' });
      if (monthWinner(reports, r, workbookOf)) items.push({ key: monthlyKey(scope, day).key, from: workbook, meta: { ...meta, source: 'period' }, what: 'monthly copy' });
      continue;
    }
    const folder = buildFolderName(r.startedAt ?? r.createdAt, r.id);
    const base = fullReportDir(scope, day, folder);
    const out: Record<string, string> = {};
    const add = (label: string, key: string, from: Item['from'], what: string): void => {
      items.push({ key, from, meta: { ...meta, origName: path.posix.basename(key) }, what });
      out[label] = key;
    };
    const runDir = path.dirname(workbook);
    add(INTRANSIT_REPORT_NAME, `${base}${INTRANSIT_REPORT_NAME}`, workbook, 'build');
    for (const name of [COMBO_CHECK.ALERT_FILE, COMBO_CHECK.SPLIT1_ROWS_FILE, RUN_RECORD_FILE]) {
      if (exists(path.join(runDir, name))) add(name, `${base}${name}`, path.join(runDir, name), 'build');
    }
    let wb: Uint8Array | null = null;
    const sheet = (label: string) => async (): Promise<Buffer> => {
      const gz = path.join(runDir, 'sheets', `${label}.csv.gz`);
      if (exists(gz)) return fsp.readFile(gz);
      wb ??= new Uint8Array(await fsp.readFile(workbook));
      return gzipSync(Buffer.from(toCsv(readXlsxSheet(wb, label) ?? [[]]), 'utf8'));
    };
    for (const [label] of SHEET_FRAMES) add(`sheets/${label}.csv.gz`, `${base}sheets/${label}.csv.gz`, sheet(label), 'build sheet');
    const snap = snapshotDir(scope, day, folder);
    for (const s of SNAPSHOT_SHEETS) {
      add(`snapshot/${s}`, `${snap}${s}.csv`, async () => gunzipSync(await sheet(s)()), 'daily snapshot');
    }
    runs.push({ run: r, folder, files: out });
  }

  // ---- refused files of the last 30 days (from the connector runs' results)
  const fetches = await AppDataSource.getRepository(IntransitRun).find({ where: { kind: In(['amazon', 'uniware', 'flipkart']) } });
  for (const r of fetches) {
    const day = r.asOf ?? String((r.options as { date?: string } | null)?.date ?? '');
    if (!day || day < keep) continue;
    for (const name of Object.keys(((r.result ?? {}) as { rejected?: Record<string, string[]> }).rejected ?? {})) {
      const file = path.join(DIR(), INTRANSIT_FOLDERS.EXPORTS, r.kind, r.id, name);
      if (exists(file)) items.push({ key: refusedKey(scope, name, day, r.id), from: file, meta: { source: r.kind, runId: r.id, day, origName: name }, what: 'refused' });
    }
  }
  return { items, runs };
};

/** The run is the final build of its ISO week (latest asOf, then highest id). */
const isoWeekWinner = (all: IntransitRun[], r: IntransitRun, wb: (x: IntransitRun) => string): boolean => {
  const mon = isoWeekOf(r.asOf as string).monday;
  return winnerAmong(all.filter((x) => exists(wb(x)) && isoWeekOf(x.asOf as string).monday === mon))?.id === r.id;
};
const monthWinner = (all: IntransitRun[], r: IntransitRun, wb: (x: IntransitRun) => string): boolean =>
  winnerAmong(all.filter((x) => exists(wb(x)) && (x.asOf as string).slice(0, 7) === (r.asOf as string).slice(0, 7)))?.id === r.id;
const winnerAmong = (rs: IntransitRun[]): IntransitRun | null =>
  [...rs].sort((a, b) => (b.asOf as string).localeCompare(a.asOf as string) || Number(b.id) - Number(a.id))[0] ?? null;

const bytesOf = async (from: Item['from']): Promise<Buffer | string> => (typeof from === 'string' ? from : from());

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const verify = process.argv.includes('--verify');
  const purge = process.argv.includes('--purge');
  if (purge && !verify) throw new Error('--purge needs --verify (only a clean verify renames the disk store)');
  await AppDataSource.initialize();
  try {
    const problems = storageProblems();
    if (problems.length) throw new Error(`S3 store not set up: ${problems.join(', ')}`);
    const scope = writeScope();
    console.log(`in-transit disk store ${DIR()} -> S3 ${scope === PROD_SCOPE ? 'inventory/' : 'inventory-test/ (test: the database is left alone)'}`);
    const { items, runs } = await plan();
    const byWhat = new Map<string, number>();
    for (const i of items) byWhat.set(i.what, (byWhat.get(i.what) ?? 0) + 1);
    for (const [w, n] of byWhat) console.log(`  ${w.padEnd(16)} ${n}`);
    console.log(`  builds moved     ${runs.length}`);

    if (apply) {
      let sent = 0;
      let same = 0;
      for (const [n, item] of items.entries()) {
        const from = await bytesOf(item.from);
        const h = await head(item.key, { fresh: true });
        if (h && h.meta.sha256 === (await digest(from)).sha256) { same++; continue; }
        await put(item.key, from, item.meta, { noQueue: true });
        sent++;
        if ((n + 1) % 50 === 0) console.log(`  ... ${n + 1}/${items.length}`);
      }
      console.log(`uploaded ${sent}, already there ${same}`);
      if (scope === PROD_SCOPE) {
        const repo = AppDataSource.getRepository(IntransitRun);
        for (const { run, folder, files } of runs) {
          await repo.update({ id: run.id }, {
            options: { ...(run.options ?? {}), folder, migratedFrom: run.reportPath } as QueryDeepPartialEntity<IntransitRun>['options'],
            reportPath: `s3:${files[INTRANSIT_REPORT_NAME]}`,
            result: { ...(run.result ?? {}), files } as QueryDeepPartialEntity<IntransitRun>['result'],
          });
        }
        for (const day of [...new Set(runs.map((r) => r.run.asOf as string))]) await repointDay(PROD_SCOPE, day);
        const log = await catchUpPeriods();
        console.log(`builds pointed at S3: ${runs.length}; weekly/monthly copies: ${log.length ? log.join('; ') : 'up to date'}`);
      }
    }

    if (verify) {
      let bad = 0;
      for (const item of items) {
        const h = await head(item.key, { fresh: true });
        const want = (await digest(await bytesOf(item.from))).sha256;
        if (!h || h.meta.sha256 !== want) { bad++; console.log(`  MISSING or different: ${item.key}`); }
      }
      console.log(bad ? `verify: ${bad} of ${items.length} not in S3 as planned` : `verify: all ${items.length} in S3`);
      if (purge && !bad) {
        const to = `${DIR()}.moved-${istToday()}`;
        await fsp.rename(DIR(), to);
        console.log(`purge: the disk store is now ${to} (delete it by hand once happy)`);
      }
    }
    if (!apply && !verify) console.log('Dry run only. Add --apply to upload.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
