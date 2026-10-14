import { Request, Router } from 'express';
import {
  ACCESS_LEVEL,
  DAY_PATTERN,
  ERROR_CODES,
  errorMessage,
  NOT_ASSIGNED_DATE,
  NotAssignedDate,
  PAGE,
  PO_OVERVIEW_LIST,
  PO_OVERVIEW_QUERY,
  PO_OVERVIEW_ROUTES,
  UPLOAD_ID_PATTERN,
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { Paging, PoOverviewFilters } from '../modules/po-overview/po-overview.queries';
import { getColumns, getFilterOptions, getShipment, listLines, listShipments } from '../modules/po-overview/po-overview.service';
import { appError } from '../utils/AppError';

/*
 * PO Overview routes (read-only, viewer on /operations/po-overview):
 *   GET /po-overview/shipments        Shipment Status tab: our POs, newest first, paged, filtered.
 *   GET /po-overview/lines            PO Format Data tab: their lines with the shipment's fields, same filters + skuCode.
 *   GET /po-overview/shipments/:uid   one shipment and its lines (details drawer).
 *   GET /po-overview/filter-options   dropdown values.
 *   GET /po-overview/columns          the column groups per team (workflow order) and this person's access to each.
 * Lists: { data: Item[], meta: { page, pageSize, total } }. Multi-value filters repeat the parameter
 * (?channel=Zepto&channel=Blinkit); "Not Assigned" picks empty values. Details in API_REFERENCE.md.
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

router.get(PO_OVERVIEW_ROUTES.SHIPMENTS, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listShipments(filters, paging);
    res.json({ data: items, meta: { ...paging, total } });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.LINES, ...viewer, async (req, res, next) => {
  try {
    const { filters, paging } = parseQuery(req);
    const { items, total } = await listLines(filters, paging);
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
    res.json({ data: await getColumns(req.auth!.user.id, req.auth!.roles) });
  } catch (err) {
    next(err);
  }
});

router.get(PO_OVERVIEW_ROUTES.SHIPMENT, ...viewer, async (req, res, next) => {
  try {
    const { uid } = req.params;
    if (!UPLOAD_ID_PATTERN.test(uid)) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
    res.json({ data: await getShipment(uid) });
  } catch (err) {
    next(err);
  }
});

export default router;
