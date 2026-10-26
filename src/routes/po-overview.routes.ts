import { Request, Router } from 'express';
import {
  ACCESS_LEVEL,
  LIVE,
  DAY_PATTERN,
  ERROR_CODES,
  errorMessage,
  NOT_ASSIGNED_DATE,
  NotAssignedDate,
  PAGE,
  PO_OVERVIEW_LIST,
  PO_OVERVIEW_QUERY,
  PO_OVERVIEW_ROUTES,
  PO_REVIEW_REMARK_MAX,
  UPLOAD_ID_PATTERN,
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { Paging, PoOverviewFilters } from '../modules/po-overview/po-overview.queries';
import { accessFor } from '../modules/po-overview/po-overview.access';
import { editOptions, FieldChanges, saveShipment, shipmentHistory } from '../modules/po-overview/po-overview.edit';
import { changesSince, lastLogId, onShipmentChange, startLive } from '../modules/po-overview/po-overview.live';
import { getColumns, getFilterOptions, getShipment, hiddenFields, listLines, listShipments } from '../modules/po-overview/po-overview.service';
import { appError } from '../utils/AppError';
import { LOG_SOURCE } from '../constants/logging';
import { logError } from '../utils/classify-error';

/*
 * PO Overview routes (read-only, viewer on /operations/po-overview):
 *   GET /po-overview/shipments        Shipment Status tab: our POs, newest first, paged, filtered.
 *   GET /po-overview/lines            PO Format Data tab: their lines with the shipment's fields, same filters + skuCode.
 *   GET /po-overview/shipments/:uid   one shipment and its lines (details drawer).
 *   GET /po-overview/filter-options   dropdown values.
 *   GET /po-overview/columns          the column groups per team (workflow order) and this person's access to each.
 * Lists: { data: Item[], meta: { page, pageSize, total } }. Multi-value filters repeat the parameter
 * (?channel=Zepto&channel=Blinkit); "Not Assigned" picks empty values. Details in API_REFERENCE.md.
 * Every response follows the person's access (accessFor: team, page access, role, facilities): column groups they may
 * not see are removed, and each shipment says whether they may edit it (canEdit).
 *   PATCH /po-overview/shipments/:uid          save changed fields { changes: { f: { from, to } }, remark? } (editor);
 *                                              returns the shipment as the person sees it. Checks: po-overview.edit.ts.
 *   GET   /po-overview/shipments/:uid/history  who changed what, newest first.
 *   GET   /po-overview/edit-options            dropdowns of the edit form (statuses, transporters, appointment remarks).
 *   GET   /po-overview/events                  Server-Sent Events: `shipment` { uid, logId, action, fields, by } after
 *                                              every change, `ping` every LIVE.HEARTBEAT_MS; Last-Event-ID replays.
 *   GET   /po-overview/changes?after=<logId>   the same changes as a plain answer, for screens whose SSE is down.
 */

const router = Router();
const Q = PO_OVERVIEW_QUERY;
type Problem = { field: string; code: string; message: string };

const parseQuery = (req: Request): { filters: PoOverviewFilters; paging: Paging } => {
  const problems: Problem[] = [];
  const text = (name: string): string | undefined => {
    const v = req.query[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' && s.trim() ? s.trim() : undefined;
  };
  const list = (name: string): string[] => {
    const v = req.query[name];
    const all = (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
    return [...new Set(all.map((x) => x.trim()).filter(Boolean))];
  };
  const dayOf = (name: string): string | undefined => {
    const v = text(name);
    if (v && (!DAY_PATTERN.test(v) || Number.isNaN(Date.parse(v)))) {
      problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, name) });
      return undefined;
    }
    return v;
  };
  const dayRange = (fromName: string, toName: string): [string | undefined, string | undefined] => {
    const from = dayOf(fromName);
    const to = dayOf(toName);
    if (from && to && from > to) {
      problems.push({ field: fromName, code: ERROR_CODES.FIELD_RANGE_REVERSED, message: errorMessage(ERROR_CODES.FIELD_RANGE_REVERSED, fromName, toName) });
    }
    return [from, to];
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

  const allowedDates = Object.values(NOT_ASSIGNED_DATE) as string[];
  const notAssigned = list(Q.NOT_ASSIGNED);
  const badDate = notAssigned.find((d) => !allowedDates.includes(d));
  if (badDate) {
    problems.push({ field: Q.NOT_ASSIGNED, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, Q.NOT_ASSIGNED, allowedDates.join(', ')) });
  }
  const [poDateFrom, poDateTo] = dayRange(Q.PO_DATE_FROM, Q.PO_DATE_TO);
  const [workingDateFrom, workingDateTo] = dayRange(Q.WORKING_DATE_FROM, Q.WORKING_DATE_TO);
  const [dispatchDateFrom, dispatchDateTo] = dayRange(Q.DISPATCH_DATE_FROM, Q.DISPATCH_DATE_TO);
  const [appointmentDateFrom, appointmentDateTo] = dayRange(Q.APPOINTMENT_DATE_FROM, Q.APPOINTMENT_DATE_TO);
  const paging = { page: int(Q.PAGE, 1, Number.MAX_SAFE_INTEGER), pageSize: int(Q.PAGE_SIZE, PO_OVERVIEW_LIST.DEFAULT_PAGE_SIZE, PO_OVERVIEW_LIST.MAX_PAGE_SIZE) };

  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return {
    filters: {
      q: text(Q.Q),
      skuCode: text(Q.SKU_CODE),
      docketNo: text(Q.DOCKET_NO),
      brand: list(Q.BRAND),
      channel: list(Q.CHANNEL),
      facility: list(Q.FACILITY),
      location: list(Q.LOCATION),
      statusPlanning: list(Q.STATUS_PLANNING),
      statusWarehouse: list(Q.STATUS_WAREHOUSE),
      statusLogistics: list(Q.STATUS_LOGISTICS),
      statusFinal: list(Q.STATUS_FINAL),
      transporter: list(Q.TRANSPORTER),
      notAssigned: notAssigned as NotAssignedDate[],
      poDateFrom,
      poDateTo,
      workingDateFrom,
      workingDateTo,
      dispatchDateFrom,
      dispatchDateTo,
      appointmentDateFrom,
      appointmentDateTo,
    },
    paging,
  };
};

const viewer = [requireAuth, requirePage(PAGE.PO_OVERVIEW, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.PO_OVERVIEW, ACCESS_LEVEL.EDITOR)];

/** { changes: { field: { from, to } }, remark? } -> checked shape (values are checked per column in saveShipment). */
const parseSave = (body: unknown): { changes: FieldChanges; remark?: string } => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const raw = b.changes;
  const problems: Problem[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) problems.push({ field: 'changes', code: ERROR_CODES.FIELD_NOT_OBJECT, message: errorMessage(ERROR_CODES.FIELD_NOT_OBJECT, 'changes') });
  const changes: FieldChanges = {};
  for (const [f, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || !('to' in v)) problems.push({ field: `changes.${f}`, code: ERROR_CODES.FIELD_NOT_OBJECT, message: errorMessage(ERROR_CODES.FIELD_NOT_OBJECT, `changes.${f}`) });
    else changes[f] = { from: (v as { from?: unknown }).from ?? null, to: (v as { to: unknown }).to };
  }
  const remark = typeof b.remark === 'string' ? b.remark : undefined;
  if (remark && remark.length > PO_REVIEW_REMARK_MAX) problems.push({ field: 'remark', code: ERROR_CODES.FIELD_TOO_LONG, message: errorMessage(ERROR_CODES.FIELD_TOO_LONG, 'remark', PO_REVIEW_REMARK_MAX) });
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return { changes, remark };
};

router.get(PO_OVERVIEW_ROUTES.SHIPMENTS, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listShipments(filters, paging, await accessFor(req.auth!.user, req.auth!.roles));
    res.json({ data: items, meta: { ...paging, total } });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.LINES, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listLines(filters, paging, await accessFor(req.auth!.user, req.auth!.roles));
    res.json({ data: items, meta: { ...paging, total } });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.FILTER_OPTIONS, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: await getFilterOptions() });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.COLUMNS, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: getColumns(await accessFor(req.auth!.user, req.auth!.roles)) });
  } catch (err) {
    next(err);
  }
});

router.patch(PO_OVERVIEW_ROUTES.SHIPMENT, ...editor, async (req, res, next) => {
  try {
    const { uid } = req.params;
    if (!UPLOAD_ID_PATTERN.test(uid)) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
    const { changes, remark } = parseSave(req.body);
    const access = await accessFor(req.auth!.user, req.auth!.roles);
    const { logIds } = await saveShipment(uid, changes, remark, req.auth!.user, access);
    res.json({ data: { ...(await getShipment(uid, access)), logIds } });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.SHIPMENT_HISTORY, ...viewer, async (req, res, next) => {
  try {
    const { uid } = req.params;
    if (!UPLOAD_ID_PATTERN.test(uid)) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
    res.json({ data: await shipmentHistory(uid, hiddenFields(await accessFor(req.auth!.user, req.auth!.roles))) });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.EDIT_OPTIONS, ...viewer, async (_req, res, next) => {
  try {
    res.json({ data: await editOptions() });
  } catch (err) {
    next(err);
  }
});

/** "changes since <logId>": the fallback a screen polls while its SSE is down. No `after` = just the current cursor. */
router.get(PO_OVERVIEW_ROUTES.CHANGES, ...viewer, async (req, res, next) => {
  try {
    const after = Number(req.query.after);
    const hidden = hiddenFields(await accessFor(req.auth!.user, req.auth!.roles));
    const changes = Number.isFinite(after) ? (await changesSince(after)).map((c) => ({ ...c, fields: c.fields.filter((f) => !hidden.has(f)) })) : [];
    res.json({ data: { lastId: String(changes.at(-1)?.logId ?? (Number.isFinite(after) ? after : await lastLogId())), changes } });
  } catch (err) {
    next(err);
  }
});

/**
 * Server-Sent Events. The browser reconnects by itself and sends Last-Event-ID: the changes after it are replayed, so
 * a dropped connection loses nothing. X-Accel-Buffering stops a proxy from holding the messages back (prod checklist).
 */
router.get(PO_OVERVIEW_ROUTES.EVENTS, ...viewer, async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: string, data: unknown, id?: string) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let hidden = new Set<string>();
  try {
    await startLive();
    hidden = hiddenFields(await accessFor(req.auth!.user, req.auth!.roles));
    const after = Number(req.header('Last-Event-ID') ?? req.query.after);
    if (Number.isFinite(after)) for (const c of await changesSince(after)) send(LIVE.EVENT_SHIPMENT, { ...c, fields: c.fields.filter((f) => !hidden.has(f)) }, c.logId);
    send(LIVE.EVENT_PING, { lastId: String(await lastLogId()) });
  } catch (err) {
    logError(LOG_SOURCE.DB, '[live] stream start failed (the screen falls back to polling)', err);
  }
  const off = onShipmentChange((c) => send(LIVE.EVENT_SHIPMENT, { ...c, fields: c.fields.filter((f) => !hidden.has(f)) }, c.logId));
  const beat = setInterval(() => send(LIVE.EVENT_PING, { at: Date.now() }), LIVE.HEARTBEAT_MS);
  req.on('close', () => { off(); clearInterval(beat); });
});

router.get(PO_OVERVIEW_ROUTES.SHIPMENT, ...viewer, async (req, res, next) => {
  try {
    const { uid } = req.params;
    if (!UPLOAD_ID_PATTERN.test(uid)) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
    res.json({ data: await getShipment(uid, await accessFor(req.auth!.user, req.auth!.roles)) });
  } catch (err) {
    next(err);
  }
});

export default router;
