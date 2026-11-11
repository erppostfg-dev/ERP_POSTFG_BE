import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  ERROR_CODES, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, UNIWARE_CREATE, UNIWARE_CREATE_OPEN, UNIWARE_CREATE_STATUS, UPLOAD_STATUS,
  UniwareCreateStatus,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { DetailsChannel, MasterPurchaseOrder, PoUpload, ShipmentLog, UniwareCreate } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
import { openS3File } from '../email-intake/s3-mirror.service';
import { flushChanges } from '../po-overview/po-overview.live';
import { bumpReview } from '../po-review/po-review.live';
import { runGentle } from '../po-uniware-sync/pacing';
import { readSaleOrder } from '../po-uniware-sync/sale-order';
import { runPoSyncPass } from '../po-uniware-sync/sync.service';
import { isThrottled, poUniwareClient, refusalMessages, UniwarePoster } from '../po-uniware-sync/uniware-client';
import { unverifiedIds } from '../po-verify/po-verify.service';
import { buildCreateRequest } from './payload';

/*
 * Create in Uniware (2026-11-09, constants/uniware-create.ts): the ONE write to Uniware. queueCreates (Processed tab,
 * editor) checks every ticked PO and queues it; the worker creates them CONCURRENCY at a time. Per PO:
 *   1. saleorder/get first: Uniware already has the code -> "exists", nothing sent (a retry never makes a second order);
 *   2. the request from the PO's sale order CSV (S3) + its location's address (payload.ts); anything missing -> failed,
 *      nothing sent;
 *   3. saleOrder/create; on any error saleorder/get again: there -> created; Uniware refused -> failed with its own
 *      messages; network / timeout -> queued again (MAX_ATTEMPTS in all); a 429 stops the round (the rest next round);
 *   4. created / exists: the upload is marked uploaded (who asked, when), History says so (source tool_api), the screens
 *      are told and the status sync reads the PO at once.
 * Restart-safe: a row left "creating" goes back to "queued" when the worker starts. OFF unless UNIWARE_CREATE_ENABLED.
 */

const LOG = '[uniware-create]';

export interface CreateActor { id: number; email: string }
export interface Refused { uploadId: string; reason: string }

const readText = async (s3Url: string): Promise<string> => {
  const f = await openS3File(s3Url);
  if (!f) throw new Error(`sale order CSV not found in S3 (${s3Url})`);
  const chunks: Buffer[] = [];
  for await (const c of f.body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

const checkOn = () => {
  if (!env.uniwareCreate.enabled) throw appError(ERROR_CODES.UNIWARE_CREATE_OFF);
  if (!env.uniwareCreate.orderPhone) throw appError(ERROR_CODES.UNIWARE_CREATE_NO_PHONE);
};

// ---- the request (Processed tab) ---------------------------------------------------------------------------------------

/** One ticked PO with what it needs, or why it cannot go (the same checks for Create and Preview). */
interface Checked {
  id: string;
  upload: PoUpload | undefined;
  po: MasterPurchaseOrder | undefined;
  reason: string | null;
}

const checkIds = async (ids: string[]): Promise<Checked[]> => {
  if (!ids.length) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  if (ids.length > UNIWARE_CREATE.MAX_IDS) throw appError(ERROR_CODES.UNIWARE_CREATE_TOO_MANY, UNIWARE_CREATE.MAX_IDS);
  const uploads = await AppDataSource.getRepository(PoUpload).findBy({ id: In(ids) });
  const pos = await AppDataSource.getRepository(MasterPurchaseOrder).find({
    select: ['uid', 'orderNo1', 'facility', 'transferCode', 'locationId', 'channel', 'poNumber'],
    where: { uid: In(uploads.map((u) => u.poUid).filter((x): x is string => !!x)) },
  });
  const open = await AppDataSource.getRepository(UniwareCreate).find({ select: ['uploadId'], where: { uploadId: In(ids), status: In([...UNIWARE_CREATE_OPEN]) } });
  const unverified = new Set(await unverifiedIds(ids));
  return ids.map((id) => {
    const upload = uploads.find((x) => String(x.id) === id);
    const po = upload?.poUid ? pos.find((p) => String(p.uid) === String(upload.poUid)) : undefined;
    const reason = !upload ? 'no such upload'
      : upload.status !== UPLOAD_STATUS.COMPLETED || !upload.uniwareCsvUrl ? 'not processed: no sale order yet'
        : !po?.orderNo1 || !po.facility || po.transferCode ? 'its saved PO has no sale order code or facility'
          : unverified.has(id) ? 'not verified yet'
            : upload.uniwareUploadedAt ? 'already marked uploaded into Uniware'
              : open.some((o) => String(o.uploadId) === id) ? 'already being created'
                : null;
    return { id, upload, po, reason };
  });
};

/** The saleOrder/create request of one PO: its CSV in S3 + its location's address (payload.ts). */
const requestFor = async (csvUrl: string, po: Pick<MasterPurchaseOrder, 'locationId' | 'channel'>, phone: string) => {
  const loc = po.locationId ? await AppDataSource.getRepository(DetailsChannel).findOne({ where: { id: po.locationId } }) : null;
  return buildCreateRequest(await readText(csvUrl), {
    name: loc?.consigneeName || po.channel, line1: loc?.finalShippingAddress ?? null, city: loc?.city ?? null,
    state: loc?.consigneeState ?? null, pincode: loc?.consigneePinCode ?? null, gstin: loc?.consigneeGstNumber ?? null,
  }, phone);
};

/** Queues the ticked POs that can be created; the others come back with the reason. */
export const queueCreates = async (ids: string[], by: CreateActor): Promise<{ queued: string[]; refused: Refused[] }> => {
  checkOn();
  const checked = await checkIds(ids);
  const refused: Refused[] = checked.filter((c) => c.reason).map((c) => ({ uploadId: c.id, reason: c.reason! }));
  const rows: Partial<UniwareCreate>[] = checked.filter((c) => !c.reason).map(({ id, po }) => ({
    uploadId: id, poUid: String(po!.uid), saleOrderCode: po!.orderNo1!, facility: po!.facility!, status: UNIWARE_CREATE_STATUS.QUEUED, requestedBy: by.id,
  }));
  if (rows.length) {
    await AppDataSource.getRepository(UniwareCreate).insert(rows);
    log.info(LOG_SOURCE.APP, `${LOG} ${by.email} queued ${rows.length} PO(s): ${rows.map((r) => r.saleOrderCode).join(', ')}`);
    bumpReview();
    kickUniwareCreate();
  }
  return { queued: rows.map((r) => String(r.uploadId)), refused };
};

export interface PreviewItem {
  uploadId: string;
  poNumber: string | null;
  saleOrderCode: string | null;
  /** Would it be sent now (all checks pass and nothing is missing)? */
  wouldSend: boolean;
  /** Why it would not be sent (a check, or what the request lacks). */
  problems: string[];
  /** The phone is a server setting: not set here = shown, not counted as a problem of the PO. */
  phoneSet: boolean;
  summary: {
    channel: string; customerCode: string; facility: string; displayOrderCode: string; poDate: string | null;
    units: number; value: number; gstin: string | null;
    address: { name: string; line1: string; city: string; state: string; pincode: string | null };
    lines: { sku: string; units: number; price: number; value: number }[];
  } | null;
  /** The exact JSON that would go to saleOrder/create (items folded per line in `summary.lines`). */
  request: Record<string, unknown> | null;
}

/**
 * Preview (2026-11-09, user: "give me preview"): the same checks and the same request as Create, for ticked POs, but
 * NOTHING is sent to Uniware and NOTHING is written (no queue row, no mark, no History). Works with Create switched off
 * (also on a laptop): it only reads the database and the CSVs in S3.
 */
export const previewCreates = async (ids: string[]): Promise<{ createEnabled: boolean; items: PreviewItem[] }> => {
  const checked = await checkIds(ids);
  const phone = env.uniwareCreate.orderPhone;
  const items: PreviewItem[] = [];
  for (const c of checked) {
    const base = { uploadId: c.id, poNumber: c.po?.poNumber ?? c.upload?.poNumber ?? null, saleOrderCode: c.po?.orderNo1 ?? null, phoneSet: !!phone };
    if (c.reason || !c.upload?.uniwareCsvUrl || !c.po) {
      items.push({ ...base, wouldSend: false, problems: [c.reason ?? 'no sale order CSV'], summary: null, request: null });
      continue;
    }
    try {
      // the phone is checked on its own (phoneSet): a placeholder keeps it out of the PO's problems
      const built = await requestFor(c.upload.uniwareCsvUrl, c.po, phone || UNIWARE_CREATE.PREVIEW_PHONE);
      const problems = [...built.missing];
      const r = built.request;
      if (r && r.saleOrderCode !== c.po.orderNo1) problems.push(`the CSV says ${r.saleOrderCode}, the PO ${c.po.orderNo1 ?? '-'}`);
      const so = (r?.payload.saleOrder ?? null);
      const addr = (so?.addresses as Record<string, string>[] | undefined)?.[0];
      const lines = new Map<string, { sku: string; units: number; price: number; value: number }>();
      for (const i of (so?.saleOrderItems as { code: string; itemSku: string; sellingPrice: number }[] | undefined) ?? []) {
        const key = i.code.split('-').slice(0, -1).join('-');
        const l = lines.get(key) ?? { sku: i.itemSku, units: 0, price: i.sellingPrice, value: 0 };
        l.units += 1;
        l.value = Math.round((l.value + i.sellingPrice) * 100) / 100;
        lines.set(key, l);
      }
      items.push({
        ...base, wouldSend: !problems.length && !!r, problems,
        summary: r && so && addr ? {
          channel: String(so.channel), customerCode: String(so.customerCode), facility: r.facility, displayOrderCode: String(so.displayOrderCode),
          poDate: (so.displayOrderDateTime as string | undefined)?.slice(0, 10) ?? null, units: r.items, value: r.value,
          gstin: (so.customerGSTIN as string | undefined) ?? null,
          address: { name: addr.name, line1: addr.addressLine1, city: addr.city, state: addr.state, pincode: addr.pincode ?? null },
          lines: [...lines.values()],
        } : null,
        request: r ? r.payload : null,
      });
    } catch (err) {
      items.push({ ...base, wouldSend: false, problems: [err instanceof Error ? err.message : String(err)], summary: null, request: null });
    }
  }
  return { createEnabled: env.uniwareCreate.enabled && !!phone, items };
};

/** The latest request of each upload asked (Processed tab), and whether the button is on. */
export const createStates = async (ids: string[]) => {
  const rows = ids.length
    ? await AppDataSource.getRepository(UniwareCreate).find({
      select: ['id', 'uploadId', 'saleOrderCode', 'status', 'attempts', 'error', 'items', 'orderValue', 'requestedAt', 'finishedAt'],
      where: { uploadId: In(ids) }, order: { id: 'DESC' },
    })
    : [];
  const latest = new Map<string, UniwareCreate>();
  for (const r of rows) if (!latest.has(String(r.uploadId))) latest.set(String(r.uploadId), r);
  return {
    enabled: env.uniwareCreate.enabled && !!env.uniwareCreate.orderPhone,
    items: [...latest.values()].map((r) => ({
      uploadId: String(r.uploadId), saleOrderCode: r.saleOrderCode, status: r.status, attempts: r.attempts, error: r.error,
      items: r.items, orderValue: r.orderValue === null ? null : Number(r.orderValue), requestedAt: r.requestedAt, finishedAt: r.finishedAt,
    })),
  };
};

// ---- one PO ------------------------------------------------------------------------------------------------------------

const finish = async (row: UniwareCreate, status: UniwareCreateStatus, extra: Partial<UniwareCreate> = {}) => {
  const now = new Date();
  const done = status === UNIWARE_CREATE_STATUS.CREATED || status === UNIWARE_CREATE_STATUS.EXISTS;
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(UniwareCreate).update({ id: row.id }, { status, finishedAt: status === UNIWARE_CREATE_STATUS.QUEUED ? null : now, ...extra });
    if (!done) return;
    // in Uniware now: the upload counts as uploaded (as the person who asked), History says how it got there
    await m.getRepository(PoUpload).createQueryBuilder().update()
      .set({ uniwareUploadedAt: now, uniwareUploadedBy: row.requestedBy })
      .where('id = :id AND uniware_uploaded_at IS NULL', { id: row.uploadId }).execute();
    await m.getRepository(ShipmentLog).insert({
      shipmentUid: row.poUid, userId: row.requestedBy, action: SHIPMENT_LOG_ACTION.UNIWARE_UPLOADED, source: SHIPMENT_LOG_SOURCE.TOOL_API,
      remark: `${row.saleOrderCode} ${status === UNIWARE_CREATE_STATUS.CREATED ? 'created in Uniware (API)' : 'already in Uniware: nothing sent'}`,
    });
  });
  bumpReview();
  if (done) {
    void flushChanges();
    // its Uniware status at once (read-only)
    await runPoSyncPass({ uids: [row.poUid], manual: true }).catch((err) => logError(LOG_SOURCE.APP, `${LOG} status read of ${row.saleOrderCode} failed`, err));
  }
};

const errorText = (err: unknown): string => (refusalMessages(err) ?? [err instanceof Error ? err.message : String(err)]).join(' | ').slice(0, 2000);

/** Works one claimed row; throws only a 429 (the round stops). */
const createOne = async (row: UniwareCreate, api: UniwarePoster) => {
  // 1. already there?
  if (await readSaleOrder(api, row.saleOrderCode, row.facility)) return finish(row, UNIWARE_CREATE_STATUS.EXISTS);

  // 2. the request
  const upload = await AppDataSource.getRepository(PoUpload).findOne({ select: ['id', 'uniwareCsvUrl'], where: { id: row.uploadId } });
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOne({ select: ['uid', 'orderNo1', 'locationId', 'channel'], where: { uid: row.poUid } });
  if (!upload?.uniwareCsvUrl || !po) return finish(row, UNIWARE_CREATE_STATUS.FAILED, { error: 'the PO or its sale order CSV is gone' });
  if (po.orderNo1 !== row.saleOrderCode) return finish(row, UNIWARE_CREATE_STATUS.FAILED, { error: `the PO's sale order code changed to ${po.orderNo1 ?? '-'}: ask again` });
  const built = await requestFor(upload.uniwareCsvUrl, po, env.uniwareCreate.orderPhone);
  if (!built.request) return finish(row, UNIWARE_CREATE_STATUS.FAILED, { error: `not sent, missing: ${built.missing.join('; ')}` });
  const { request } = built;
  if (request.saleOrderCode !== row.saleOrderCode) return finish(row, UNIWARE_CREATE_STATUS.FAILED, { error: `the CSV says ${request.saleOrderCode}, the PO ${row.saleOrderCode}` });
  const sizes = { items: request.items, orderValue: request.value.toFixed(2) };

  // 3. create; any error -> read back
  try {
    await api.post(UNIWARE_CREATE.CREATE_SO, request.payload, request.facility);
    log.info(LOG_SOURCE.APP, `${LOG} created ${row.saleOrderCode} (${request.items} unit(s), ${request.value})`);
    return finish(row, UNIWARE_CREATE_STATUS.CREATED, sizes);
  } catch (err) {
    if (isThrottled(err)) throw err;
    const there = await readSaleOrder(api, row.saleOrderCode, row.facility).catch(() => null);
    if (there) return finish(row, UNIWARE_CREATE_STATUS.CREATED, sizes);
    const refused = refusalMessages(err) !== null;
    const again = !refused && row.attempts < UNIWARE_CREATE.MAX_ATTEMPTS;
    logError(LOG_SOURCE.APP, `${LOG} ${row.saleOrderCode} ${refused ? 'refused by Uniware' : again ? 'failed, will try again' : 'failed'}`, err);
    return finish(row, again ? UNIWARE_CREATE_STATUS.QUEUED : UNIWARE_CREATE_STATUS.FAILED, { ...sizes, error: errorText(err) });
  }
};

// ---- the worker --------------------------------------------------------------------------------------------------------

let running = false;
let again = false;
let timer: NodeJS.Timeout | undefined;

/** Takes a queued row for this server (another server may take it first). */
const claim = async (id: string): Promise<UniwareCreate | null> => {
  const r = await AppDataSource.getRepository(UniwareCreate).createQueryBuilder().update()
    .set({ status: UNIWARE_CREATE_STATUS.CREATING, startedAt: new Date(), attempts: () => 'attempts + 1' })
    .where('id = :id AND status = :queued', { id, queued: UNIWARE_CREATE_STATUS.QUEUED }).execute();
  return r.affected ? AppDataSource.getRepository(UniwareCreate).findOneBy({ id }) : null;
};

/** One round over the queue; true = a 429 stopped it. */
export const runCreateRound = async (api: UniwarePoster = poUniwareClient()): Promise<{ throttled: boolean }> => {
  const queued = await AppDataSource.getRepository(UniwareCreate).find({ select: ['id'], where: { status: UNIWARE_CREATE_STATUS.QUEUED }, order: { id: 'ASC' }, take: 100 });
  const result = await runGentle(queued, { concurrency: UNIWARE_CREATE.CONCURRENCY, gapMs: UNIWARE_CREATE.CALL_GAP_MS }, async ({ id }) => {
    const row = await claim(id);
    if (!row) return;
    try {
      await createOne(row, api);
    } catch (err) {
      // 429: back in the queue for the next round; anything else unexpected: kept with its reason
      const throttled = isThrottled(err);
      await finish(row, throttled || row.attempts < UNIWARE_CREATE.MAX_ATTEMPTS ? UNIWARE_CREATE_STATUS.QUEUED : UNIWARE_CREATE_STATUS.FAILED, { error: errorText(err) })
        .catch((e) => logError(LOG_SOURCE.APP, `${LOG} could not save the state of ${row.saleOrderCode}`, e));
      if (throttled) throw err;
    }
  });
  return { throttled: result.throttled };
};

/** Starts a round now (or right after the one running). Never throws. */
export const kickUniwareCreate = (): void => {
  if (!env.uniwareCreate.enabled) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  void runCreateRound()
    .catch((err) => logError(LOG_SOURCE.APP, `${LOG} round failed`, err))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kickUniwareCreate();
      }
    });
};

/** server.ts: rows left "creating" by a stop go back to the queue; then a round now and one every minute. */
export const startUniwareCreate = (): { stop: () => void } | undefined => {
  if (!env.uniwareCreate.enabled) return undefined;
  void AppDataSource.getRepository(UniwareCreate)
    .update({ status: UNIWARE_CREATE_STATUS.CREATING }, { status: UNIWARE_CREATE_STATUS.QUEUED })
    .then(() => kickUniwareCreate())
    .catch((err) => logError(LOG_SOURCE.APP, `${LOG} could not reset unfinished rows`, err));
  timer = setInterval(kickUniwareCreate, 60_000);
  log.info(LOG_SOURCE.APP, `${LOG} on (creates sale orders in Uniware when asked)`);
  return { stop: () => clearInterval(timer) };
};
