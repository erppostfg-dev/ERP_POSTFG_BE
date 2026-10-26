import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { pipeline } from 'stream';
import { ACCESS_LEVEL, ERROR_CODES, errorMessage, INTRANSIT_ROUTES, INTRANSIT_UPLOAD_MAX_BYTES, PAGE } from '../constants';
import { requireAnyPage, requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { ConnectorOptions } from '../modules/intransit/connectors';
import { inputBlob, previewInput, previewReportSheet, previewRunFile, reportBlob, reportSheetCsv, runFileBlob, StoredBlob } from '../modules/intransit/file-preview.service';
import { getDay, masterHistory, removeDaily, restoreVersion, saveInput } from '../modules/intransit/inputs.service';
import { addToSplit1, ComboRows, finalSkuListings, mapVariants, split1Parents, VariantMap } from '../modules/intransit/split1.service';
import { deleteRun, getRun, getRunLog, latestInventory, listRuns, Requester, RunView, startConnector, startReport } from '../modules/intransit/runs.service';
import { listPeriods } from '../modules/intransit/s3/periods';
import { retryStorage, storageStatus } from '../modules/intransit/s3/status';
import { storageOn } from '../modules/intransit/s3/scope';
import { open } from '../modules/intransit/s3/store';
import { getSnapshot, snapshotFile } from '../modules/intransit/snapshot.service';
import { appError } from '../utils/AppError';
import { createGzip } from 'zlib';

/*
 * In-transit Stock routes (Demand Planning > In-transit Stock, 2026-10-15). Viewer on /planning/intransit-stock reads;
 * editor uploads, builds and fetches.
 * Inputs (2026-10-19): masters are kept once (a new upload replaces the current one, which is kept as a version);
 * daily files are kept per day (?date=YYYY-MM-DD, IST, default today, never in the future); a day without its own copy
 * of a daily file uses the latest earlier one.
 *   GET    /intransit/day?date=            the Daily run page: { date, today, days (last 14: ofDate, total, report),
 *                                          masters { ok, total, items }, daily { ok, total, items }, sources,
 *                                          build { ready, uses, toFetch, fetchRequired, blockers, warnings, spread
 *                                          (the day's files saved more than INTRANSIT_INPUT_SPREAD_WARN_HOURS apart) },
 *                                          latestReport, running }
 *   POST   /intransit/inputs/:name?date=   multipart `file`, saved as input :name (exact catalog name) once its columns
 *                                          check out: { data: { name, unchanged } } (unchanged = the same master again).
 *                                          404 unknown name, 422 { details: { name, problems } }
 *   DELETE /intransit/inputs/:name?date=   editor; a daily file's copy of that day (204). 400 for a master
 *   GET    /intransit/inputs/:name/history a master's earlier versions, newest first: [{ version, at, size, byName, source }]
 *   POST   /intransit/inputs/:name/restore editor; { version }: that version becomes the current master again
 *   POST   /intransit/runs                 { asOf?: YYYY-MM-DD (default today, IST), fetchFirst?: boolean (default true:
 *                                          the API files not of that day are fetched for it first), fromDate?: YYYY-MM-DD |
 *                                          days before asOf | "" (none; default INTRANSIT_FROM_DATE) } -> 202 the queued
 *                                          report run (options: fromDate, fetchFirst, toFetch, step, progress);
 *                                          422 { details: { missing } } with what blocks the build
 *   GET    /intransit/runs?kind=           newest first (kind: report | amazon | uniware | flipkart)
 *   GET    /intransit/runs/:id             the run with the last log lines (logTail); poll it while queued/running
 *   GET    /intransit/runs/:id/log         the full log, text/plain
 *   GET    /intransit/runs/:id/report      the workbook (xlsx); 409 unless the run succeeded
 *   DELETE /intransit/runs/:id             204; 409 while queued/running
 *   POST   /intransit/connectors/:source   amazon | uniware | flipkart, body { date?, only?: string | string[], refreshCache? }
 *                                          -> 202 the queued fetch; its good files become the inputs of that day. A past
 *                                          day fetches only what can be fetched for any day (400 when nothing is left).
 *                                          409 while one runs for that source
 *   GET    /intransit/inventory            SOH + in-transit per SKU x channel x location from the latest built report, for
 *                                          Inventory Calculation (viewer on /planning/inventory):
 *                                          { data: { runId, asOf, builtAt, columns, rows: [[sku, name, channel, type, location, soh, inTransit]] } }
 *   GET    /intransit/inputs/:name/preview          a page of an input CSV (the master, or the daily file used for
 *                                          ?date=), ?offset=&limit= (max 500)&q= (search)
 *                                          { data: { name, size, modified, columns, rows, total, totalRows, offset, limit } }
 *   GET    /intransit/inputs/:name/download         the same file as stored (?date=)
 *   GET    /intransit/runs/:id/files/:name/preview  the same for a file a connector run fetched (saved or refused)
 *   GET    /intransit/runs/:id/files/:name/download
 *   GET    /intransit/runs/:id/sheets/:sheet/preview  viewer of In-transit Stock or Inventory Calculation (the tables are
 *                                          tabs there); a page of one sheet of a built report (e.g. Sheet35(2)), read from
 *                                          its workbook; same query and answer as the file preview. 409 unless succeeded
 *   GET    /intransit/runs/:id/sheets/:sheet/download that sheet as CSV
 *   POST   /intransit/final-sku/variants  editor; { variants: [{ variant, base, components? }] }: each combo variant
 *                                          (CMB47B2b) mapped to its base (CMB47) in Final SKU Mapping.csv; a base not in
 *                                          Split1 yet added there with `components`.
 *                                          { data: { mapped, skipped, split1: { added, skipped } } }
 *   POST   /intransit/split1/rows      editor; { combos: [{ combo, components: [{ sku, qty }] }] } appended to Split1.csv
 *                                          (combos already there skipped; with a Uniware login, unknown component SKUs
 *                                          refused 422). { data: { added: [{ combo, rows }], skipped: [{ combo, reason }] } }
 * Report runs' comboCheck.combos[] carry inSplit1 (true once the combo is in the current Split1.csv).
 * S3 store (2026-10-26: every in-transit file in S3 under inventory/; a test machine writes inventory-test/):
 *   GET    /intransit/storage/status       editor; { data: { setUp, missing, scope, root, host, queued { files, bytes,
 *                                          limitMb, oldest, refused }, lastError } }
 *   POST   /intransit/storage/retry        admin; send the queued files now: { data: { retried, left } }
 *   GET    /intransit/snapshot?day=        viewer of Inventory Calculation or In-transit Stock: the Daily Snapshot of the
 *                                          newest day <= day (default today) with a final build: { data: { requested,
 *                                          shown { day, runId, builtAt } | null, latestMissing, files [{ name, key, etag,
 *                                          size }] } }
 *   GET    /intransit/snapshot/file?key=   one of those files as CSV (ETag; If-None-Match -> 304; gzip when accepted)
 *   GET    /intransit/periods              the weekly / monthly copies: [{ kind, fy, label, from, key, size, modified }]
 *   GET    /intransit/periods/download?key=  one of them (xlsx)
 */

/** Marks each flagged combo of a report run that is in Split1.csv by now (added from the page or uploaded since). */
const withSplit1 = async (runs: RunView[]): Promise<RunView[]> => {
  if (!runs.some((r) => (r.result as { comboCheck?: unknown } | null)?.comboCheck)) return runs;
  const parents = await split1Parents();
  const listings = await finalSkuListings();
  type C = { sku: string; base?: { sku: string } };
  return runs.map((r) => {
    const cc = (r.result as { comboCheck?: { combos?: C[] } } | null)?.comboCheck;
    if (!cc?.combos?.length) return r;
    const combos = cc.combos.map((c) => ({
      ...c,
      inSplit1: parents.has(c.sku.toLowerCase()),
      // a variant mapped to its base since the report (Final SKU Mapping), and whether the base is in Split1 now
      mapped: listings.has(c.sku.toLowerCase()),
      ...(c.base ? { base: { ...c.base, inSplit1: parents.has(c.base.sku.toLowerCase()) } } : {}),
    }));
    return { ...r, result: { ...r.result, comboCheck: { ...cc, combos } } };
  });
};

/** ?offset=&limit=&q= of the CSV viewer. */
const pageQuery = (req: Request) => ({
  offset: Number(req.query.offset ?? 0),
  limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
  q: typeof req.query.q === 'string' ? req.query.q : undefined,
});

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: INTRANSIT_UPLOAD_MAX_BYTES } });
const viewer = [requireAuth, requirePage(PAGE.INTRANSIT_STOCK, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.INTRANSIT_STOCK, ACCESS_LEVEL.EDITOR)];
// the report's tables are shown on Inventory Calculation (user, 2026-10-21): a viewer of either page reads them
const reportReader = [requireAuth, requireAnyPage([PAGE.INTRANSIT_STOCK, PAGE.INVENTORY], ACCESS_LEVEL.VIEWER)];
const admin = [requireAuth, requirePage(PAGE.ADMIN, ACCESS_LEVEL.EDITOR)];
const who = (req: Request): Requester => ({ id: req.auth?.user.id ?? null, name: req.auth?.user.name ?? null });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get(INTRANSIT_ROUTES.DAY, ...viewer, async (req, res, next) => {
  try {
    const day = await getDay(req.query.date);
    const latestReport = day.latestReport ? (await withSplit1([day.latestReport]))[0] : null;
    res.json({ data: { ...day, latestReport } });
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.INPUT, ...editor, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw appError(ERROR_CODES.UPLOAD_REJECTED, 'send the file in the "file" field');
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    res.json({ data: await saveInput(req.params.name, new Uint8Array(req.file.buffer), req.query.date, who(req), { dryRun }) });
  } catch (err) {
    next(err);
  }
});

router.delete(INTRANSIT_ROUTES.INPUT, ...editor, async (req, res, next) => {
  try {
    await removeDaily(req.params.name, req.query.date, who(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.INPUT_HISTORY, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await masterHistory(req.params.name) });
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.INPUT_RESTORE, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await restoreVersion(req.params.name, ((req.body ?? {}) as { version?: unknown }).version, who(req)) });
  } catch (err) {
    next(err);
  }
});

// ---- CSV viewer ----------------------------------------------------------------------------------------------------

router.get(INTRANSIT_ROUTES.INPUT_PREVIEW, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await previewInput(req.params.name, req.query.date, pageQuery(req)) });
  } catch (err) {
    next(err);
  }
});

/** Send a stored file (disk or S3) as a download. */
const sendBlob = async (res: Response, next: NextFunction, blob: StoredBlob): Promise<void> => {
  const stream = await blob.stream();
  res.setHeader('Cache-Control', 'private, no-store');
  res.attachment(blob.name);
  res.setHeader('Content-Length', String(blob.size));
  pipeline(stream as NodeJS.ReadableStream, res, (err) => {
    if (err && !res.headersSent) next(err);
  });
};

router.get(INTRANSIT_ROUTES.INPUT_DOWNLOAD, ...viewer, async (req, res, next) => {
  try {
    await sendBlob(res, next, await inputBlob(req.params.name, req.query.date));
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_FILE_PREVIEW, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await previewRunFile(req.params.id, req.params.name, pageQuery(req)) });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_FILE_DOWNLOAD, ...viewer, async (req, res, next) => {
  try {
    await sendBlob(res, next, await runFileBlob(req.params.id, req.params.name));
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_SHEET_PREVIEW, ...reportReader, async (req, res, next) => {
  try {
    res.json({ data: await previewReportSheet(req.params.id, req.params.sheet, pageQuery(req)) });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_SHEET_DOWNLOAD, ...reportReader, async (req, res, next) => {
  try {
    const csv = await reportSheetCsv(req.params.id, req.params.sheet);
    const file = `${req.params.sheet.replace(/[^\w()+ -]/g, '_')}_run${req.params.id}.csv`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(`﻿${csv}`); // BOM so Excel opens it as UTF-8
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.COMBO_VARIANTS, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await mapVariants(((req.body ?? {}) as { variants?: VariantMap[] }).variants ?? [], who(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.SPLIT1_ROWS, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await addToSplit1(((req.body ?? {}) as { combos?: ComboRows[] }).combos ?? [], who(req)) });
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.RUNS, ...editor, async (req, res, next) => {
  try {
    const { asOf, fromDate, fetchFirst } = (req.body ?? {}) as { asOf?: unknown; fromDate?: unknown; fetchFirst?: unknown };
    if (asOf !== undefined && asOf !== '' && (typeof asOf !== 'string' || !DAY_RE.test(asOf) || Number.isNaN(Date.parse(asOf)))) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'asOf', code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, 'asOf') }]);
    }
    // a day, or a whole number of days before as-of; "" = no start date
    const from = typeof fromDate === 'string' || typeof fromDate === 'number' ? String(fromDate).trim() : fromDate;
    if (from !== undefined && from !== '' && (typeof from !== 'string' || !(/^\d+$/.test(from) || (DAY_RE.test(from) && !Number.isNaN(Date.parse(from)))))) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'fromDate', code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, 'fromDate') }]);
    }
    res.status(202).json({ data: await startReport(who(req), { asOf: (asOf as string) || undefined, fromDate: from as string | undefined, fetchFirst: fetchFirst !== false }) });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUNS, ...viewer, async (req, res, next) => {
  try {
    const items = await withSplit1(await listRuns(typeof req.query.kind === 'string' ? req.query.kind : undefined));
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: (await withSplit1([await getRun(req.params.id)]))[0] });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_LOG, ...viewer, async (req, res, next) => {
  try {
    res.type('text/plain').send(await getRunLog(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.RUN_REPORT, ...viewer, async (req, res, next) => {
  try {
    await sendBlob(res, next, await reportBlob(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete(INTRANSIT_ROUTES.RUN, ...editor, async (req, res, next) => {
  try {
    await deleteRun(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.CONNECTOR, ...editor, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { date?: unknown; only?: unknown; refreshCache?: unknown };
    const only = (Array.isArray(body.only) ? body.only : [body.only]).filter((o): o is string => typeof o === 'string' && !!o);
    const options: ConnectorOptions = {
      ...(typeof body.date === 'string' && body.date ? { date: body.date } : {}),
      ...(only.length ? { only } : {}),
      ...(body.refreshCache === true ? { refreshCache: true } : {}),
    };
    res.status(202).json({ data: await startConnector(req.params.source, who(req), options) });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.STORAGE_STATUS, ...editor, async (_req, res, next) => {
  try {
    res.json({ data: await storageStatus() });
  } catch (err) {
    next(err);
  }
});

router.post(INTRANSIT_ROUTES.STORAGE_RETRY, ...admin, async (_req, res, next) => {
  try {
    res.json({ data: await retryStorage() });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.SNAPSHOT, ...reportReader, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: await getSnapshot(req.query.date ?? req.query.day) });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.SNAPSHOT_FILE, ...reportReader, async (req, res, next) => {
  try {
    if (typeof req.query.key !== 'string' || !req.query.key) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, 'key');
    const { body, etag } = await snapshotFile(req.query.key, req.header('if-none-match') ?? undefined);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', `"${etag}"`);
    if (!body) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // the CSVs are large (tens of MB) and compress ~10x
    if (/\bgzip\b/.test(req.header('accept-encoding') ?? '')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      pipeline(body, createGzip(), res, (err) => err && !res.headersSent && next(err));
    } else pipeline(body, res, (err) => err && !res.headersSent && next(err));
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.PERIODS, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: storageOn() ? await listPeriods() : [] });
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.PERIOD_DOWNLOAD, ...viewer, async (req, res, next) => {
  try {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    const m = /^inventory\/(Weekly|Monthly) Snapshot\/(FY\d{2}-\d{2})\/([A-Za-z0-9_]+)\.xlsx$/.exec(key);
    if (!storageOn() || !m) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key || 'key');
    const o = await open(key);
    if (!o || o === 'not-modified') throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key);
    res.setHeader('Cache-Control', 'private, no-store');
    res.attachment(`Intransit_Stock_Report_${m[2]}_${m[3]}.xlsx`);
    res.setHeader('Content-Length', String(o.size));
    pipeline(o.body, res, (err) => err && !res.headersSent && next(err));
  } catch (err) {
    next(err);
  }
});

router.get(INTRANSIT_ROUTES.INVENTORY, requireAuth, requirePage(PAGE.INVENTORY, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    res.json({ data: await latestInventory() });
  } catch (err) {
    next(err);
  }
});

export default router;
