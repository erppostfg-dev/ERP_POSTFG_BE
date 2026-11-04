import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import {
  ACCESS_LEVEL, CAPABILITY, D2C_EXPORT_LEVEL, D2C_LIMITS, D2C_QUERY, D2C_ROUTES, D2C_TAB, D2C_UPLOAD_FIELD, D2cTab, DAY_PATTERN, ERROR_CODES, errorMessage,
  LIVE, PAGE,
} from '../constants';
import { LOG_SOURCE } from '../constants/logging';
import { hasCapability } from '../modules/auth/access.service';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { inwardJob, setVarianceReason, startCreateInwardPo } from '../modules/d2c-transfers/inward-po.service';
import {
  D2cFilters, exportTransfers, getTransfer, listInvoices, listTransfers, nextReference, Paging, skuPicker, tabCounts, transferEvents, transferOptions,
} from '../modules/d2c-transfers/queries';
import { todayIst } from '../modules/d2c-transfers/reference';
import { cancelTransfer, closeShort, soJob, startCreateSo, stockCheck } from '../modules/d2c-transfers/so.service';
import { startSync, syncStatus } from '../modules/d2c-transfers/sync.service';
import { changeExpiry, checkId, createFromForm, editDraft } from '../modules/d2c-transfers/transfers.service';
import { importUpload, previewUpload, templateCsv, UploadFile } from '../modules/d2c-transfers/upload.service';
import { changesSince, lastLogId, onShipmentChange, ShipmentChange, startLive } from '../modules/po-overview/po-overview.live';
import { appError } from '../utils/AppError';
import { logError } from '../utils/classify-error';

/*
 * D2C internal transfers (2026-11-03; plan d2c-internal-transfers sections 1, 5, 8; phase 3 = no Uniware calls).
 * viewer / editor of /operations/d2c-transfers.
 *   GET   /d2c-transfers?tab=draft|sale_orders|create_inward_po|inward_pos|overview&q=&stage=&priority=&sender=&receiving=
 *         &dateFrom=&dateTo=&source=&channel=&type=&expired=true|false&page=&pageSize=      list (priority, PO date, uid)
 *   GET   /d2c-transfers/counts?<same filters>        transfers per tab
 *   GET   /d2c-transfers/export?level=po|sku&<filters>  CSV
 *   GET   /d2c-transfers/options                      senders, channels, locations (+ routes), types, priorities, defaults
 *   GET   /d2c-transfers/skus?q=                       SKU picker (active, not a combo, with MRP)
 *   GET   /d2c-transfers/next-reference?locationId=&poDate=&type=   the reference the next save would take
 *   GET   /d2c-transfers/template                     upload template (CSV)
 *   GET   /d2c-transfers/events                       SSE: `shipment` messages of transfers only (shared cursor, PO Overview's bus)
 *   GET   /d2c-transfers/changes?after=<logId>        the same, polled
 *   GET   /d2c-transfers/:id                          header, lines, invoices, route codes, timeline, edit token
 *   GET   /d2c-transfers/:id/events                   the timeline (shipment_logs, oldest first, with source tags)
 * editor:
 *   POST  /d2c-transfers/uploads/preview             multipart "file" (.csv, <= 2 MB, <= 5,000 rows): checks + proposed transfers
 *   POST  /d2c-transfers/uploads/import              the same file: all or nothing, drafts (source bulk_csv)
 *   POST  /d2c-transfers                             form: { senderId|sender, channel, locationId|location, poDate, priority,
 *                                                    type, expiry, remarks, lines: [{ skuCode, qty }] } -> draft (source screen)
 *   PATCH /d2c-transfers/:id                         { token, header?, lines? }: edit a draft
 *   POST  /d2c-transfers/:id/cancel                  { reason }: cancel (draft; with an SO: its open items are cancelled in
 *                                                    Uniware first, only before any dispatch; 409 D2C_NOT_LIVE / 422 refused)
 *   POST  /d2c-transfers/:id/expiry                  { date, remark? }: change the PO expiry date
 * phase 5 (Uniware sale orders; writes gated by d2c:settings.live + env D2C_UNIWARE_WRITES, else test facilities only):
 *   POST  /d2c-transfers/stock-check                 { ids }: per line needed vs available at the sender (read only)
 *   POST  /d2c-transfers/create-so                   { ids, stockWarnings?: { [id]: text } } -> 202 job { id, results so far }
 *   GET   /d2c-transfers/jobs/:jobId                 the job: status, done / total, per-transfer results
 *   POST  /d2c-transfers/:id/close-short             { reason }: cancel every open SO item in Uniware; lines cut to what is left
 * phase 6 (Uniware status sync, read-only on Uniware):
 *   GET   /d2c-transfers/sync-status  (viewer)        d2c:sync + this server's timer: last ok / error / counts, synced N min ago
 *   POST  /d2c-transfers/sync         (editor)        { ids?, full? } -> 202 { state: started | queued, ...status }: Sync now;
 *                                                    full = every stage incl. closed / cancelled (CAPABILITY.D2C_RESYNC, else 403)
 * phase 7 (inward POs at the receiving facility, one per dispatched invoice; GRN read by the sync):
 *   GET   /d2c-transfers/invoices?tab=create_inward_po|inward_pos&<list filters>&page=&pageSize=   (viewer) invoice rows
 *   POST  /d2c-transfers/create-inward-po        { invoiceIds } -> 202 job (GET /jobs/:jobId reads it too); gate = the receiving facility
 *   POST  /d2c-transfers/invoices/:invoiceId/variance-reason   { reason: short_received|damaged|excess|other, note }:
 *                                                    GRN-complete invoice with variance != 0 and no reason yet -> the transfer
 */

const router = Router();
const viewer = [requireAuth, requirePage(PAGE.D2C_TRANSFERS, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.D2C_TRANSFERS, ACCESS_LEVEL.EDITOR)];
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: D2C_LIMITS.UPLOAD_MAX_BYTES } }).single(D2C_UPLOAD_FIELD);
const Q = D2C_QUERY;
/** Excel opens a CSV as UTF-8 only with a byte-order mark. */
const UTF8_BOM = String.fromCharCode(0xfeff);
type Problem = { field: string; code: string; message: string };

const send = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json({ data: await fn(req) });
  } catch (err) {
    next(err);
  }
};
const actor = (req: Request) => ({ id: req.auth!.user.id });
const fileOf = (req: Request): UploadFile | undefined => (req.file ? { originalname: req.file.originalname, buffer: req.file.buffer } : undefined);

/** Filters + paging of the list / counts / export; 400 VALIDATION_FAILED with every bad parameter. */
const parseQuery = (req: Request): { filters: D2cFilters; paging: Paging } => {
  const problems: Problem[] = [];
  const text = (name: string): string | undefined => {
    const v = req.query[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' && s.trim() ? s.trim() : undefined;
  };
  const list = (name: string): string[] => {
    const v = req.query[name];
    const all = (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
    return [...new Set(all.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean))];
  };
  const day = (name: string): string | undefined => {
    const v = text(name);
    if (v && (!DAY_PATTERN.test(v) || Number.isNaN(Date.parse(v)))) {
      problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, name) });
      return undefined;
    }
    return v;
  };
  const int = (name: string, fallback: number, max: number): number => {
    const v = text(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_INT_RANGE, message: errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, name, 1, max) });
      return fallback;
    }
    return n;
  };
  const tabs = Object.values(D2C_TAB) as string[];
  const tab = text(Q.TAB) ?? D2C_TAB.OVERVIEW;
  if (!tabs.includes(tab)) problems.push({ field: Q.TAB, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, Q.TAB, tabs.join(', ')) });
  const expiredText = text(Q.EXPIRED);
  if (expiredText !== undefined && !['true', 'false'].includes(expiredText)) {
    problems.push({ field: Q.EXPIRED, code: ERROR_CODES.FIELD_NOT_BOOLEAN, message: errorMessage(ERROR_CODES.FIELD_NOT_BOOLEAN, Q.EXPIRED) });
  }
  const dateFrom = day(Q.DATE_FROM);
  const dateTo = day(Q.DATE_TO);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    problems.push({ field: Q.DATE_FROM, code: ERROR_CODES.FIELD_RANGE_REVERSED, message: errorMessage(ERROR_CODES.FIELD_RANGE_REVERSED, Q.DATE_FROM, Q.DATE_TO) });
  }
  const paging = { page: int(Q.PAGE, 1, Number.MAX_SAFE_INTEGER), pageSize: int(Q.PAGE_SIZE, D2C_LIMITS.DEFAULT_PAGE_SIZE, D2C_LIMITS.MAX_PAGE_SIZE) };
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return {
    filters: {
      tab: tab as D2cTab, q: text(Q.Q), stage: list(Q.STAGE), priority: list(Q.PRIORITY), sender: list(Q.SENDER), receiving: list(Q.RECEIVING),
      dateFrom, dateTo, source: list(Q.SOURCE), channel: list(Q.CHANNEL), type: list(Q.TYPE),
      expired: expiredText === undefined ? undefined : expiredText === 'true',
    },
    paging,
  };
};

router.get(D2C_ROUTES.LIST, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listTransfers(filters, paging);
    res.json({ data: items, meta: { ...paging, total } });
  } catch (err) {
    next(err);
  }
});
router.get(D2C_ROUTES.COUNTS, ...viewer, send((req) => tabCounts(parseQuery(req).filters)));
router.get(D2C_ROUTES.EXPORT, ...viewer, async (req, res, next) => {
  try {
    const level = typeof req.query[Q.LEVEL] === 'string' ? (req.query[Q.LEVEL] as string) : D2C_EXPORT_LEVEL.PO;
    const levels = Object.values(D2C_EXPORT_LEVEL) as string[];
    if (!levels.includes(level)) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: Q.LEVEL, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, Q.LEVEL, levels.join(', ')) }]);
    }
    const { csv, rows, truncated } = await exportTransfers(parseQuery(req).filters, level);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="d2c-transfers-${level}-${todayIst()}.csv"`);
    res.setHeader('X-Row-Count', String(rows));
    res.setHeader('X-Truncated', truncated ? 'true' : 'false');
    res.send(`${UTF8_BOM}${csv}`);
  } catch (err) {
    next(err);
  }
});
router.get(D2C_ROUTES.OPTIONS, ...viewer, send(() => transferOptions()));
router.get(D2C_ROUTES.SKUS, ...viewer, send((req) => skuPicker(typeof req.query.q === 'string' ? req.query.q : '')));
router.get(D2C_ROUTES.NEXT_REFERENCE, ...viewer, send((req) => nextReference(req.query as Record<string, unknown>)));
router.get(D2C_ROUTES.TEMPLATE, ...viewer, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="d2c-transfers-template.csv"');
  res.send(templateCsv());
});

/** A change as the D2C screen gets it: transfers only, without the flag. */
const forD2c = ({ isTransfer: _t, ...c }: ShipmentChange) => c;

router.get(D2C_ROUTES.CHANGES, ...viewer, async (req, res, next) => {
  try {
    const after = Number(req.query.after);
    const all = Number.isFinite(after) ? await changesSince(after) : [];
    // the cursor moves past channel-PO changes too (one cursor for both screens, plan 3)
    res.json({ data: { lastId: String(all.at(-1)?.logId ?? (Number.isFinite(after) ? after : await lastLogId())), changes: all.filter((c) => c.isTransfer).map(forD2c) } });
  } catch (err) {
    next(err);
  }
});

/** Server-Sent Events, like PO Overview's: same bus and cursor, only transfer changes; Last-Event-ID replays. */
router.get(D2C_ROUTES.EVENTS, ...viewer, async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const write = (event: string, data: unknown, id?: string) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await startLive();
    const after = Number(req.header('Last-Event-ID') ?? req.query.after);
    if (Number.isFinite(after)) for (const c of await changesSince(after)) if (c.isTransfer) write(LIVE.EVENT_SHIPMENT, forD2c(c), c.logId);
    write(LIVE.EVENT_PING, { lastId: String(await lastLogId()) });
  } catch (err) {
    logError(LOG_SOURCE.DB, '[live] d2c stream start failed (the screen falls back to polling)', err);
  }
  const off = onShipmentChange((c) => { if (c.isTransfer) write(LIVE.EVENT_SHIPMENT, forD2c(c), c.logId); });
  const beat = setInterval(() => write(LIVE.EVENT_PING, { at: Date.now() }), LIVE.HEARTBEAT_MS);
  req.on('close', () => { off(); clearInterval(beat); });
});

// editor: auth before the file is read
router.post(D2C_ROUTES.UPLOAD_PREVIEW, ...editor, upload, send((req) => previewUpload(fileOf(req))));
router.post(D2C_ROUTES.UPLOAD_IMPORT, ...editor, upload, send((req) => importUpload(fileOf(req), actor(req)), 201));
router.post(D2C_ROUTES.LIST, ...editor, send(async (req) => {
  const created = await createFromForm(req.body, actor(req));
  return { ...(await getTransfer(created.uid)), warnings: created.warnings };
}, 201));

router.post(D2C_ROUTES.STOCK_CHECK, ...editor, send((req) => stockCheck(req.body)));
router.post(D2C_ROUTES.CREATE_SO, ...editor, send((req) => startCreateSo(req.body, actor(req)), 202));
router.get(D2C_ROUTES.JOB, ...editor, send(async (req) => inwardJob(String(req.params.jobId)) ?? soJob(String(req.params.jobId))));
router.get(D2C_ROUTES.INVOICES, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listInvoices(filters, paging);
    res.json({ data: items, meta: { ...paging, total } });
  } catch (err) {
    next(err);
  }
});
router.post(D2C_ROUTES.CREATE_INWARD_PO, ...editor, send((req) => startCreateInwardPo(req.body, actor(req)), 202));
router.post(D2C_ROUTES.VARIANCE_REASON, ...editor, send(async (req) => {
  const r = await setVarianceReason(String(req.params.invoiceId), req.body, actor(req));
  return { ...(await getTransfer(r.uid)), varianceReason: r };
}));

router.get(D2C_ROUTES.SYNC_STATUS, ...viewer, send(() => syncStatus()));
router.post(D2C_ROUTES.SYNC, ...editor, send(async (req) => {
  const full = !!req.body && typeof req.body === 'object' && (req.body as { full?: unknown }).full === true;
  const canResync = full ? await hasCapability(req.auth!.user.id, req.auth!.roles, CAPABILITY.D2C_RESYNC) : false;
  return startSync(req.body, canResync);
}, 202));

router.get(D2C_ROUTES.ONE_EVENTS, ...viewer, send((req) => transferEvents(checkId(req.params.id))));
router.get(D2C_ROUTES.ONE, ...viewer, send((req) => getTransfer(checkId(req.params.id))));
router.patch(D2C_ROUTES.ONE, ...editor, send(async (req) => {
  const r = await editDraft(req.params.id, req.body, actor(req));
  return { ...(await getTransfer(req.params.id)), changed: r.changed };
}));
router.post(D2C_ROUTES.CANCEL, ...editor, send(async (req) => {
  const r = await cancelTransfer(req.params.id, req.body, actor(req));
  return { ...(await getTransfer(req.params.id)), uniware: r.uniware };
}));
router.post(D2C_ROUTES.CLOSE_SHORT, ...editor, send(async (req) => {
  const r = await closeShort(req.params.id, req.body, actor(req));
  return { ...(await getTransfer(req.params.id)), closeShort: r };
}));
router.post(D2C_ROUTES.EXPIRY, ...editor, send(async (req) => {
  const r = await changeExpiry(req.params.id, req.body, actor(req));
  return { ...(await getTransfer(req.params.id)), changed: r.changed };
}));

export default router;
