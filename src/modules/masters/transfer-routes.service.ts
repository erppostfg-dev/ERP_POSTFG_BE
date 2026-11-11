import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, MASTER_LOG_TYPE, TABLES } from '../../constants';
import { appError } from '../../utils/AppError';
import { Actor, checker } from './master-add.service';
import { editRowIn, setActiveIn } from './master-edit.service';

/*
 * D2C internal transfer routes on the Masters page (2026-11-03; plan "Route codes from the user's sheet"): one row per
 * (sending facility, transfer location) with the Uniware codes of that route. Loaded from the user's sheet
 * (npm run d2c:routes-load); here they are listed and edited. Edits go through the masters edit spec (type
 * transfer_route): same checks, conflict rule and master_change_logs history as every other master; no PO re-check.
 * The location's own fields (transfer_po_prefix, transfer_facility_id) are edited as a LOCATION row
 * (PATCH /masters/edit/location/:locationId).
 */

export interface TransferRouteItem {
  id: number;
  senderFacilityId: number;
  senderCode: string;
  locationId: string;
  channel: string;
  location: string | null;
  receivingFacilityId: number | null;
  receivingCode: string | null;
  poPrefix: string | null;
  uniwareChannelCode: string | null;
  customerCode: string | null;
  customerName: string | null;
  vendorCode: string | null;
  isActive: boolean;
  locationActive: boolean;
  missingVendor: boolean;
  missingCustomer: boolean;
  missingChannel: boolean;
  updatedAt: Date;
}

type Raw = {
  id: number; sender_id: number; sender_code: string; location_id: string | number; channel: string; location: string | null;
  receiving_id: number | null; receiving_code: string | null; po_prefix: string | null; uniware_channel_code: string | null;
  customer_code: string | null; customer_name: string | null; vendor_code: string | null; is_active: number; location_active: number; updated_at: Date;
};
const blank = (v: string | null) => !v || !v.trim();

/** GET /masters/transfer-routes: every route, by sender, channel, location. */
export const listTransferRoutes = async (): Promise<TransferRouteItem[]> => {
  const rows = await AppDataSource.query<Raw[]>(
    `SELECT r.id, r.dispatch_facility_id sender_id, f.code sender_code, r.location_id, d.channel_name channel, d.channel_location_code location,
            d.transfer_facility_id receiving_id, rf.code receiving_code, d.transfer_po_prefix po_prefix, r.uniware_channel_code,
            r.customer_code, r.customer_name, r.vendor_code, r.is_active, d.is_active location_active, r.updated_at
       FROM ${TABLES.D2C_TRANSFER_ROUTES} r
       JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = r.dispatch_facility_id
       JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = r.location_id
       LEFT JOIN ${TABLES.MASTER_FACILITIES} rf ON rf.id = d.transfer_facility_id
      ORDER BY f.code, d.channel_name, d.channel_location_code, r.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id), senderFacilityId: Number(r.sender_id), senderCode: r.sender_code, locationId: String(r.location_id), channel: r.channel,
    location: r.location, receivingFacilityId: r.receiving_id === null ? null : Number(r.receiving_id), receivingCode: r.receiving_code,
    poPrefix: r.po_prefix, uniwareChannelCode: r.uniware_channel_code, customerCode: r.customer_code, customerName: r.customer_name,
    vendorCode: r.vendor_code, isActive: !!Number(r.is_active), locationActive: !!Number(r.location_active),
    missingVendor: blank(r.vendor_code), missingCustomer: blank(r.customer_code), missingChannel: blank(r.uniware_channel_code),
    updatedAt: r.updated_at,
  }));
};

const CODE_KEYS = ['uniwareChannelCode', 'customerCode', 'vendorCode'] as const;

/**
 * PATCH /masters/transfer-routes/:id { changes: { uniwareChannelCode?, customerCode?, vendorCode?, isActive? },
 * original?: { same keys, as seen }, remark? } -> { changed: string[] }. One transaction: the code edits (masters
 * edit rules, 409 MASTER_EDIT_CONFLICT when someone else changed a field) and the switch on / off, each logged.
 */
export const editTransferRoute = async (rawId: unknown, body: unknown, by: Actor): Promise<{ changed: string[] }> => {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const changes = (b.changes && typeof b.changes === 'object' && !Array.isArray(b.changes) ? b.changes : {}) as Record<string, unknown>;
  const original = (b.original && typeof b.original === 'object' && !Array.isArray(b.original) ? b.original : {}) as Record<string, unknown>;
  const c = checker({ ...changes, remark: b.remark });
  const remark = c.remark();
  const codes = Object.fromEntries(Object.entries(changes).filter(([k]) => k !== 'isActive'));
  const hasActive = 'isActive' in changes;
  const active = hasActive ? c.bool('isActive') : null;
  if (!Object.keys(changes).length) c.bad('changes', 'FIELD_REQUIRED', 'changes');
  c.done();
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  if (!/^[1-9]\d{0,9}$/.test(id)) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'id', code: ERROR_CODES.FIELD_NOT_NUMBER, message: 'id must be a row id' }]);
  }
  return AppDataSource.transaction(async (m) => {
    const changed: string[] = [];
    if (Object.keys(codes).length) {
      const orig = Object.fromEntries(Object.entries(original).filter(([k]) => (CODE_KEYS as readonly string[]).includes(k)));
      const r = await editRowIn(m, MASTER_LOG_TYPE.TRANSFER_ROUTE, id, { changes: codes, original: orig, remark }, by);
      changed.push(...r.changed);
    }
    if (hasActive) {
      const r = await setActiveIn(m, MASTER_LOG_TYPE.TRANSFER_ROUTE, id, active!, remark, by);
      if (r.changed) changed.push('isActive');
    }
    return { changed };
  });
};
