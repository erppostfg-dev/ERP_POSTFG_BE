import fs from 'fs/promises';
import { ERROR_CODES, INPUT_BY_NAME, INTRANSIT_TEMPLATE_NAME, isMasterInput } from '../../constants';
import { appError } from '../../utils/AppError';
import { validateInput } from './catalog';
import { dailyCounts, deleteDailyFile, restoreTemplate, saveDailyFile, saveTemplate, templateVersions } from './s3/inputs';
import { importKey } from './s3/layout';
import { storageOn, writeScope } from './s3/scope';
import { put } from './s3/store';
import { assertMastersWritable, mastersInDb } from './masters-db';
import { importMasterUpload, isDbMaster, UploadResult } from './masters-upload';
import { checkDate, dailyDir, dayBefore, DayPlan, deleteDaily, istToday, keepMasterImport, masterVersions, restoreMaster, storeInput } from './input-store';
import { activeRuns, dayPlan, latestReportOf, reportsOfDays, Requester, RunView } from './runs.service';

/*
 * The Daily run page's data (user, 2026-10-19): the day's plan (input-store planDay) with the last two weeks for the
 * day ribbon, the day's latest report and what is running; and saving / removing / restoring inputs.
 */

const RIBBON_DAYS = 14;

export interface DaySummary {
  date: string;
  /** Daily files the day has its own copy of. */
  ofDate: number;
  total: number;
  report: { id: string; status: string } | null;
}

export interface DayView extends DayPlan {
  days: DaySummary[];
  latestReport: RunView | null;
  running: RunView[];
}

const DAILY_NAMES = new Set([...INPUT_BY_NAME.keys()].filter((n) => !isMasterInput(n)));

/** The RIBBON_DAYS days ending today, oldest first. */
const ribbonDates = (today: string): string[] => {
  const out = [today];
  while (out.length < RIBBON_DAYS) out.unshift(dayBefore(out[0]));
  return out;
};

/** The day's plan, the ribbon, its latest report and the running jobs. */
export const getDay = async (date?: unknown): Promise<DayView> => {
  const day = checkDate(date);
  const plan = await dayPlan(day);
  const dates = ribbonDates(istToday());
  const reports = await reportsOfDays(dates);
  const stored = storageOn() ? await dailyCounts(dates) : null;
  const days = await Promise.all(dates.map(async (d) => {
    const ofDate = stored ? stored.get(d) ?? 0 : (await fs.readdir(dailyDir(d)).catch(() => [] as string[])).filter((n) => DAILY_NAMES.has(n)).length;
    return { date: d, ofDate, total: DAILY_NAMES.size, report: reports.get(d) ?? null };
  }));
  const [latestReport, running] = await Promise.all([latestReportOf(day), activeRuns()]);
  return { ...plan, days, latestReport, running };
};

/**
 * Save an upload as input `name` (404 unknown name, 422 with the problems when it fails the check): a master replaces
 * the current one (unchanged when it is the same file), a daily file becomes the copy of `date` (default today).
 */
export const saveInput = async (
  name: string, raw: Uint8Array, date: unknown, who: Requester, opts: { dryRun?: boolean } = {},
): Promise<{ name: string; unchanged: boolean; imported?: UploadResult; stored?: 's3' | 'queued' }> => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  const saver = { id: who.id, name: who.name };
  // a master that lives in the database (user, 2026-10-25): imported into it (add and update only), the file kept
  if ((mastersInDb() || storageOn()) && isDbMaster(name)) {
    if (storageOn()) {
      // S3: the uploaded file is kept first (Masters/Imports/, forever), so every change logged can name it
      assertMastersWritable();
      const kept = opts.dryRun ? null : await put(importKey(writeScope(), name, who.id, name), Buffer.from(raw), {
        byId: who.id, byName: who.name, source: 'upload', origName: name,
      });
      const imported = await importMasterUpload(name, raw, saver, { dryRun: opts.dryRun, importKey: kept?.key ?? null });
      return { name, unchanged: !imported.added && !imported.updated, imported, stored: kept?.stored };
    }
    const imported = await importMasterUpload(name, raw, saver, { dryRun: opts.dryRun });
    if (!imported.dryRun) {
      // the database already has the changes: a failure to keep the file is reported, not an error
      await keepMasterImport(name, raw, { by: who.id, byName: who.name, source: 'upload' })
        .catch((err) => imported.warnings.push(`imported, but the uploaded file was not kept: ${err instanceof Error ? err.message : err}`));
    }
    return { name, unchanged: !imported.added && !imported.updated, imported };
  }
  const day = checkDate(date);
  const problems = validateInput(name, raw);
  if (problems.length) throw appError(ERROR_CODES.INTRANSIT_INPUT_INVALID, name, problems.join('; ')).withDetails({ name, problems });
  if (opts.dryRun) return { name, unchanged: false }; // checked only: a dry run saves nothing
  if (storageOn()) {
    // S3: a day's file of this machine's area, or a new template version (the masters live in the database)
    if (name === INTRANSIT_TEMPLATE_NAME) {
      const r = await saveTemplate(Buffer.from(raw), saver);
      return { name, unchanged: r.unchanged, stored: r.stored };
    }
    if (isMasterInput(name)) throw appError(ERROR_CODES.INTRANSIT_NOT_DAILY, name);
    const r = await saveDailyFile(name, day, Buffer.from(raw), saver, 'upload', problems);
    return { name, unchanged: r.unchanged, stored: r.stored };
  }
  const saved = await storeInput(name, raw, day, { by: who.id, byName: who.name, source: 'upload' });
  return { name, unchanged: saved.unchanged };
};

export const removeDaily = async (name: string, date: unknown, who: Requester = { id: null, name: null }): Promise<void> => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  if (isMasterInput(name)) throw appError(ERROR_CODES.INTRANSIT_NOT_DAILY, name);
  if (storageOn()) return deleteDailyFile(name, checkDate(date), { id: who.id, name: who.name });
  await deleteDaily(name, checkDate(date));
};

export const masterHistory = async (name: string) => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  if (!isMasterInput(name)) throw appError(ERROR_CODES.INTRANSIT_NOT_MASTER, name);
  if (storageOn()) return name === INTRANSIT_TEMPLATE_NAME ? templateVersions() : []; // the database masters: see their change log
  return masterVersions(name);
};

export const restoreVersion = async (name: string, version: unknown, who: Requester): Promise<{ name: string; unchanged: boolean }> => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  if (storageOn()) {
    if (name !== INTRANSIT_TEMPLATE_NAME) throw appError(ERROR_CODES.INTRANSIT_NOT_MASTER, name);
    const r = await restoreTemplate(String(version ?? ''), { id: who.id, name: who.name });
    return { name, unchanged: r.unchanged };
  }
  const { unchanged } = await restoreMaster(name, String(version ?? ''), { by: who.id, byName: who.name });
  return { name, unchanged };
};
