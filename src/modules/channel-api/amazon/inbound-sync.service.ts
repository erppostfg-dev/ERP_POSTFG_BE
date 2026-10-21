import crypto from 'crypto';
import { In, IsNull, Not } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import {
  AMAZON_EDITABLE_STATUSES, AMAZON_FINAL_STATUSES, AMAZON_RECEIVING_STATUSES, CHANNEL_API, INBOUND_EVENT, INBOUND_EVENT_SOURCE,
  INBOUND_SYNC, INBOUND_TEXT, SOURCE_SYSTEM, UPLOAD_STATUS, type InboundEventKind, type InboundEventSource,
} from '../../../constants';
import { ChannelApiSync, InboundPlan, InboundShipment, InboundShipmentEvent, InboundShipmentLine, PoUpload } from '../../../entities';
import { LOG_SOURCE } from '../../../constants/logging';
import { log } from '../../../utils/logger';
import * as api from './inbound-api';

/*
 * Amazon inbound tracking (user, 2026-10-19): keeps inbound_plans / inbound_shipments / lines / events up to date while
 * asking Amazon for as little as possible.
 *   A. New plans: list plans newest first and stop at the first one we know (first run: plans of the last 30 days). A
 *      new plan is read ONCE: the plan (all shipment statuses), its items (what was asked), each shipment's FBA id + FC,
 *      and each shipment's lines. Plans not split into shipments yet are looked at again for a few days.
 *   B. Changes: one call "shipments updated since the last check" (all plans, every status). Each is compared with our
 *      record: status changed -> update + history; lines fetched only while lines can still change (WORKING /
 *      READY_TO_SHIP), when receiving (received quantities, at most once a day) and when it closes. Same lines
 *      (fingerprint) -> nothing. Lines changed after the sale order was punched in Uniware, or cancelled after it ->
 *      attention for a person; the sale order itself is never touched.
 *   C. PO links: shipments are linked to the po_uploads row the PO chain made for the same FBA id.
 *   D. Once a day: every open shipment is checked by id (50 per call) to catch anything missed: status always; lines only
 *      when the status moved or it has a POST_FG PO not yet in Uniware; received quantities at most once a day.
 * Dry run (apply false) reads Amazon and our DB and writes nothing. The check point moves only after a successful apply.
 * Self-healing: a failed run keeps the old check point (the next run asks from there); one bad shipment never stops
 * the others; Amazon calls retry by themselves (spapi.client).
 */

const SRC = SOURCE_SYSTEM.AMAZON_SPAPI;
const DAY_MS = 864e5;
const cut = (s: string | null | undefined, n: number = INBOUND_SYNC.TEXT_MAX) => (s ?? '').slice(0, n) || null;
const has = (list: readonly string[], v: string) => list.includes(v);

export interface InboundRunOptions {
  apply: boolean;
  source: InboundEventSource;
  /** First run / --days: plans created in the last N days. */
  lookbackDays?: number;
  /** Also run the daily check of open shipments now. */
  sweep?: boolean;
}

export interface InboundReport {
  apply: boolean;
  since: string;
  until: string;
  calls: number;
  plans: { new: number; rechecked: number; stillUnsplit: number };
  shipments: { new: number; fromPlans: number; statusChanged: number; linesChanged: number; receivedUpdated: number; unchanged: number; attention: number; linked: number; swept: number };
  /** One line per change, for the console. */
  changes: string[];
  errors: string[];
  /** Dry run: calls an apply would add (lines / shipment reads). */
  estimatedApplyCalls?: number;
}

const repo = {
  plans: () => AppDataSource.getRepository(InboundPlan),
  ships: () => AppDataSource.getRepository(InboundShipment),
  lines: () => AppDataSource.getRepository(InboundShipmentLine),
  events: () => AppDataSource.getRepository(InboundShipmentEvent),
  sync: () => AppDataSource.getRepository(ChannelApiSync),
  uploads: () => AppDataSource.getRepository(PoUpload),
};

/** Same SKUs + same planned quantities = same fingerprint. */
const fingerprint = (items: api.V0Item[]): string =>
  crypto.createHash('sha1').update(items.map((i) => `${i.SellerSKU}:${Number(i.QuantityShipped) || 0}`).sort().join('|')).digest('hex');

const sum = (items: api.V0Item[], k: 'QuantityShipped' | 'QuantityReceived') => items.reduce((a, i) => a + (Number(i[k]) || 0), 0);

const newReport = (apply: boolean, since: Date, until: Date): InboundReport => ({
  apply, since: since.toISOString(), until: until.toISOString(), calls: 0,
  plans: { new: 0, rechecked: 0, stillUnsplit: 0 },
  shipments: { new: 0, fromPlans: 0, statusChanged: 0, linesChanged: 0, receivedUpdated: 0, unchanged: 0, attention: 0, linked: 0, swept: 0 },
  changes: [], errors: [],
});

const event = (shipmentId: number, kind: InboundEventKind, source: InboundEventSource, seenAt: Date, oldValue?: string | null, newValue?: string | null, detail?: Record<string, unknown>) =>
  repo.events().create({ shipmentId, kind, source, seenAt, oldValue: cut(oldValue), newValue: cut(newValue), detail: detail ?? null });

/** The sale order of this shipment is already in Uniware (marked uploaded). */
const punched = async (externalId: string): Promise<boolean> =>
  !!(await repo.uploads().findOne({ select: ['id', 'uniwareUploadedAt'], where: { sourceSystem: SRC, externalId } }))?.uniwareUploadedAt;

/** The shipment has our PO and its sale order is not yet marked uploaded in Uniware (a line change still matters). */
const openPo = async (uploadId: string | null): Promise<boolean> =>
  !!uploadId && !(await repo.uploads().findOne({ select: ['id', 'uniwareUploadedAt'], where: { id: uploadId } }))?.uniwareUploadedAt;

/** Per SKU: old -> new planned quantity (added / removed / changed). */
const lineDiff = (old: InboundShipmentLine[], now: api.V0Item[]) => {
  const was = new Map(old.map((l) => [l.sellerSku, l.qtyPlanned]));
  const is = new Map(now.map((i) => [i.SellerSKU, Number(i.QuantityShipped) || 0]));
  const out: { sku: string; from: number | null; to: number | null }[] = [];
  for (const [sku, q] of is) if (was.get(sku) !== q) out.push({ sku, from: was.get(sku) ?? null, to: q });
  for (const [sku, q] of was) if (!is.has(sku)) out.push({ sku, from: q, to: null });
  return out;
};

/** Writes a shipment's lines as Amazon has them now (in the caller's transaction). */
const saveLines = async (m: typeof AppDataSource.manager, shipmentId: number, items: api.V0Item[], now: Date) => {
  const r = m.getRepository(InboundShipmentLine);
  const old = await r.findBy({ shipmentId });
  const keep = new Set(items.map((i) => i.SellerSKU));
  const gone = old.filter((l) => !keep.has(l.sellerSku)).map((l) => l.id);
  if (gone.length) await r.delete({ id: In(gone) });
  for (const i of items) {
    const row = old.find((l) => l.sellerSku === i.SellerSKU);
    await r.save({
      ...(row ?? {}), shipmentId, sellerSku: i.SellerSKU, fnsku: i.FulfillmentNetworkSKU ?? row?.fnsku ?? null, asin: row?.asin ?? null,
      qtyPlanned: Number(i.QuantityShipped) || 0, qtyReceived: i.QuantityReceived === undefined ? (row?.qtyReceived ?? null) : Number(i.QuantityReceived) || 0,
      updatedAt: now,
    });
  }
};

/** A shipment seen for the first time: its record, lines and the "discovered" history row. */
const createShipment = async (
  rep: InboundReport, source: InboundEventSource, now: Date,
  s: { externalId: string; status: string; name?: string; fc?: string; city?: string; pincode?: string; planRowId?: number | null; channelShipmentId?: string | null },
  items: api.V0Item[] | null,
): Promise<InboundShipment> =>
  AppDataSource.transaction(async (m) => {
    const ship = await m.getRepository(InboundShipment).save(m.getRepository(InboundShipment).create({
      sourceSystem: SRC, externalId: s.externalId, planRowId: s.planRowId ?? null, channelShipmentId: s.channelShipmentId ?? null,
      name: cut(s.name), fcCode: cut(s.fc, 20), fcCity: cut(s.city, 100), fcPincode: cut(s.pincode, 10), status: s.status, statusSince: now,
      skuCount: items ? items.length : null, unitsPlanned: items ? sum(items, 'QuantityShipped') : null,
      unitsReceived: items && has(AMAZON_RECEIVING_STATUSES, s.status) ? sum(items, 'QuantityReceived') : null,
      linesFingerprint: items ? fingerprint(items) : null, linesCheckedAt: items ? now : null,
      receivedCheckedAt: items && has(AMAZON_RECEIVING_STATUSES, s.status) ? now : null,
      firstSeenAt: now, lastSeenAt: now,
    }));
    if (items) await saveLines(m, ship.id, items, now);
    await m.getRepository(InboundShipmentEvent).save(event(ship.id, INBOUND_EVENT.DISCOVERED, source, now, null, s.status, {
      fc: s.fc ?? null, skus: items?.length ?? null, units: items ? sum(items, 'QuantityShipped') : null, planKnown: !!s.planRowId,
    }));
    rep.changes.push(`new ${s.externalId} ${s.fc ?? ''} ${s.status}${items ? ` · ${items.length} SKUs, ${sum(items, 'QuantityShipped')} units` : ''}`);
    return ship;
  });

/**
 * Compares one shipment Amazon returned with our record and writes only the difference.
 * forceLines: read the lines whatever the status (a person's Refresh, the re-check before a CSV download).
 */
const applyChange = async (rep: InboundReport, s: api.V0Shipment, opts: { apply: boolean; source: InboundEventSource; now: Date; forceLines?: boolean; fetchedThisRun: Set<string> }) => {
  const { now } = opts;
  const row = await repo.ships().findOneBy({ sourceSystem: SRC, externalId: s.ShipmentId });
  const status = s.ShipmentStatus;

  if (!row) {
    rep.shipments.new++;
    // Lines only for shipments still open: a closed / cancelled one of an older plan is recorded by its status only.
    const wantLines = !has(AMAZON_FINAL_STATUSES, status);
    if (!opts.apply) { rep.estimatedApplyCalls = (rep.estimatedApplyCalls ?? 0) + (wantLines ? 1 : 0); return; }
    const items = wantLines ? await api.shipmentItems(s.ShipmentId) : null;
    opts.fetchedThisRun.add(s.ShipmentId);
    await createShipment(rep, opts.source, now, {
      externalId: s.ShipmentId, status, name: s.ShipmentName, fc: s.DestinationFulfillmentCenterId,
    }, items);
    return;
  }

  const statusChanged = row.status !== status;
  const receivingDue = has(AMAZON_RECEIVING_STATUSES, status) &&
    (statusChanged || !row.receivedCheckedAt || now.getTime() - row.receivedCheckedAt.getTime() > INBOUND_SYNC.RECEIVED_REFRESH_HOURS * 3600e3);
  // Lines of a still-editable shipment (WORKING / READY_TO_SHIP): a poll or Refresh reads them (Amazon listed it as
  // changed). The daily check re-reads them only where a change still matters (user, 2026-10-21): the status moved, or
  // it has a POST_FG PO not yet punched in Uniware; everything else editable is left to the polls, the Refresh button
  // and the re-check before a CSV download. Received quantities: at most once a day (receivingDue).
  const editable = has(AMAZON_EDITABLE_STATUSES, status);
  const editableDue = editable && (opts.source !== INBOUND_EVENT_SOURCE.SWEEP || statusChanged || (await openPo(row.poUploadId)));
  const needLines = !opts.fetchedThisRun.has(s.ShipmentId) && (opts.forceLines || editableDue || receivingDue);

  if (!opts.apply) {
    if (statusChanged) { rep.shipments.statusChanged++; rep.changes.push(`${s.ShipmentId} ${row.fcCode ?? ''}: ${row.status} -> ${status}`); }
    else rep.shipments.unchanged++;
    if (needLines) rep.estimatedApplyCalls = (rep.estimatedApplyCalls ?? 0) + 1;
    return;
  }

  const items = needLines ? await api.shipmentItems(s.ShipmentId) : null;
  if (items) opts.fetchedThisRun.add(s.ShipmentId);
  const oldLines = items ? await repo.lines().findBy({ shipmentId: row.id }) : [];
  const fp = items ? fingerprint(items) : null;
  const linesChanged = !!items && !!row.linesFingerprint && fp !== row.linesFingerprint;
  const received = items ? sum(items, 'QuantityReceived') : null;
  const receivedChanged = items !== null && has(AMAZON_RECEIVING_STATUSES, status) && received !== row.unitsReceived;
  const isPunched = (linesChanged || (statusChanged && has(['CANCELLED', 'DELETED'], status))) ? await punched(row.externalId) : false;

  if (!statusChanged && !linesChanged && !receivedChanged && !(items && !row.linesFingerprint)) {
    rep.shipments.unchanged++;
    await repo.ships().update({ id: row.id }, { lastSeenAt: now, ...(items ? { linesCheckedAt: now } : {}), ...(items && has(AMAZON_RECEIVING_STATUSES, status) ? { receivedCheckedAt: now } : {}) });
    return;
  }

  await AppDataSource.transaction(async (m) => {
    const ev = m.getRepository(InboundShipmentEvent);
    const patch: Partial<Omit<InboundShipment, 'plan' | 'poUpload'>> = { lastSeenAt: now };
    if (statusChanged) {
      Object.assign(patch, { status, statusSince: now });
      await ev.save(event(row.id, INBOUND_EVENT.STATUS_CHANGED, opts.source, now, row.status, status));
      rep.shipments.statusChanged++;
      rep.changes.push(`${row.externalId} ${row.fcCode ?? ''}: ${row.status} -> ${status}`);
      if (isPunched && has(['CANCELLED', 'DELETED'], status)) {
        patch.attention = cut(INBOUND_TEXT.CANCELLED_AFTER_PUNCH(status));
        await ev.save(event(row.id, INBOUND_EVENT.ATTENTION, opts.source, now, null, patch.attention));
        rep.shipments.attention++;
      }
    }
    if (items) {
      Object.assign(patch, { linesFingerprint: fp, linesCheckedAt: now, skuCount: items.length, unitsPlanned: sum(items, 'QuantityShipped') });
      if (linesChanged) {
        const diff = lineDiff(oldLines, items);
        await ev.save(event(row.id, INBOUND_EVENT.LINES_CHANGED, opts.source, now, `${row.skuCount} SKUs, ${row.unitsPlanned} units`,
          `${items.length} SKUs, ${sum(items, 'QuantityShipped')} units`, { diff }));
        rep.shipments.linesChanged++;
        rep.changes.push(`${row.externalId}: lines changed (${diff.length} SKU(s))`);
        // Never touch a punched sale order: a person decides (top-up / cancel items in Uniware).
        patch.attention = cut(isPunched ? INBOUND_TEXT.LINES_CHANGED_AFTER_PUNCH : INBOUND_TEXT.LINES_CHANGED_BEFORE_PUNCH);
        await ev.save(event(row.id, INBOUND_EVENT.ATTENTION, opts.source, now, null, patch.attention));
        rep.shipments.attention++;
      }
      if (has(AMAZON_RECEIVING_STATUSES, status)) {
        Object.assign(patch, { unitsReceived: received, receivedCheckedAt: now });
        if (receivedChanged) {
          await ev.save(event(row.id, INBOUND_EVENT.RECEIVED_UPDATED, opts.source, now, row.unitsReceived === null ? null : String(row.unitsReceived), String(received),
            { shipped: sum(items, 'QuantityShipped') }));
          rep.shipments.receivedUpdated++;
          rep.changes.push(`${row.externalId}: received ${received} of ${sum(items, 'QuantityShipped')}`);
        }
      }
      await saveLines(m, row.id, items, now);
    }
    await m.getRepository(InboundShipment).update({ id: row.id }, patch);
  });
};

/** A. Plans created since the last known one (first run: the last N days), each read once. */
const discoverPlans = async (rep: InboundReport, opts: InboundRunOptions, now: Date, fetched: Set<string>) => {
  const known = new Set((await repo.plans().find({ select: ['planId'], where: { sourceSystem: SRC } })).map((p) => p.planId));
  const cutoff = new Date(now.getTime() - (opts.lookbackDays ?? INBOUND_SYNC.FIRST_LOOKBACK_DAYS) * DAY_MS);
  const fresh: api.PlanListItem[] = [];
  let token: string | undefined;
  let stop = false;
  do {
    const page = await api.listPlansPage(token);
    for (const p of page.inboundPlans ?? []) {
      const created = p.createdAt ? new Date(p.createdAt) : now;
      if (created < cutoff) { stop = true; break; }
      if (known.has(p.inboundPlanId)) {
        // A normal run stops at the first plan it knows (all older ones are known). With --days (a first load or its
        // re-run after a stop) known plans are skipped and the listing goes on to the cut-off, so nothing is missed.
        if (opts.lookbackDays === undefined) { stop = true; break; }
        continue;
      }
      fresh.push(p);
    }
    token = page.pagination?.nextToken;
  } while (!stop && token);

  // Plans we hold but Amazon had not split yet (0 shipments): look again for a few days.
  const unsplit = await repo.plans().find({ where: { sourceSystem: SRC, shipmentCount: 0 } });
  const recheck = unsplit.filter((p) => p.createdAtChannel && now.getTime() - p.createdAtChannel.getTime() < INBOUND_SYNC.UNSPLIT_RECHECK_DAYS * DAY_MS);
  rep.plans.new = fresh.length;
  rep.plans.rechecked = recheck.length;

  for (const item of [...fresh, ...recheck.map((p) => ({ inboundPlanId: p.planId }) as api.PlanListItem)]) {
    try {
      const plan = await api.getPlan(item.inboundPlanId);
      const shipments = plan.shipments ?? [];
      if (!opts.apply) {
        rep.shipments.fromPlans += shipments.length;
        rep.estimatedApplyCalls = (rep.estimatedApplyCalls ?? 0) + 1 + shipments.length * 2;
        rep.changes.push(`plan ${plan.inboundPlanId.slice(0, 12)}… ${plan.createdAt?.slice(0, 10) ?? ''}: ${shipments.length} shipment(s)`);
        continue;
      }
      const planItems = await api.getPlanItems(plan.inboundPlanId);
      const existing = await repo.plans().findOneBy({ sourceSystem: SRC, planId: plan.inboundPlanId });
      const row = await repo.plans().save({
        ...(existing ?? {}), sourceSystem: SRC, planId: plan.inboundPlanId, name: cut(plan.name), status: cut(plan.status, 30),
        shipFromName: cut(plan.sourceAddress?.name ?? plan.sourceAddress?.companyName), shipFromPincode: cut(plan.sourceAddress?.postalCode, 10),
        createdAtChannel: plan.createdAt ? new Date(plan.createdAt) : null, updatedAtChannel: plan.lastUpdatedAt ? new Date(plan.lastUpdatedAt) : null,
        planSkuCount: planItems.length, planUnits: planItems.reduce((a, i) => a + (Number(i.quantity) || 0), 0), shipmentCount: shipments.length,
        firstSeenAt: existing?.firstSeenAt ?? now, lastCheckedAt: now,
      });
      if (!shipments.length) rep.plans.stillUnsplit++;
      rep.changes.push(`plan ${plan.inboundPlanId.slice(0, 12)}… ${plan.createdAt?.slice(0, 10) ?? ''}: ${shipments.length} shipment(s), ${row.planUnits} units`);
      for (const ps of shipments) {
        try {
          const sh = await api.getShipment(plan.inboundPlanId, ps.shipmentId);
          const fba = sh.shipmentConfirmationId;
          if (!fba) continue; // not confirmed yet: Amazon has no FBA id for it; the next run looks again via the unsplit / change list
          const dest = sh.destination;
          const already = await repo.ships().findOneBy({ sourceSystem: SRC, externalId: fba });
          if (already) {
            // Seen before through the change list (its plan was unknown): attach it to the plan.
            await repo.ships().update({ id: already.id }, { planRowId: row.id, channelShipmentId: ps.shipmentId, fcCity: cut(dest?.address?.city, 100), fcPincode: cut(dest?.address?.postalCode, 10) });
            continue;
          }
          const status = sh.status ?? ps.status ?? 'WORKING';
          const items = has(AMAZON_FINAL_STATUSES, status) && status !== 'CLOSED' ? null : await api.shipmentItems(fba);
          fetched.add(fba);
          await createShipment(rep, opts.source, now, {
            externalId: fba, status, name: sh.name, fc: dest?.warehouseId, city: dest?.address?.city, pincode: dest?.address?.postalCode,
            planRowId: row.id, channelShipmentId: ps.shipmentId,
          }, items);
          rep.shipments.fromPlans++;
        } catch (err) {
          rep.errors.push(`plan ${plan.inboundPlanId} shipment ${ps.shipmentId}: ${(err as Error).message}`.slice(0, CHANNEL_API.ERROR_MAX));
        }
      }
    } catch (err) {
      rep.errors.push(`plan ${item.inboundPlanId}: ${(err as Error).message}`.slice(0, CHANNEL_API.ERROR_MAX));
    }
  }
};

/** C. Links shipments to the PO the PO chain made for the same FBA id. */
export const linkPos = async (rep?: InboundReport): Promise<number> => {
  const open = await repo.ships().find({ select: ['id', 'externalId'], where: { sourceSystem: SRC, poUploadId: IsNull() } });
  if (!open.length) return 0;
  const ups = await repo.uploads().find({
    select: ['id', 'externalId', 'poNumber'],
    where: { sourceSystem: SRC, externalId: In(open.map((s) => s.externalId)), status: Not(UPLOAD_STATUS.FAILED) },
  });
  const now = new Date();
  for (const u of ups) {
    const s = open.find((x) => x.externalId === u.externalId);
    if (!s) continue;
    await AppDataSource.transaction(async (m) => {
      await m.getRepository(InboundShipment).update({ id: s.id }, { poUploadId: u.id });
      await m.getRepository(InboundShipmentEvent).save(event(s.id, INBOUND_EVENT.PO_LINKED, INBOUND_EVENT_SOURCE.POLL, now, null, `upload ${u.id}`));
    });
  }
  if (rep) rep.shipments.linked += ups.length;
  return ups.length;
};

const syncRow = async (): Promise<ChannelApiSync> =>
  (await repo.sync().findOneBy({ connector: INBOUND_SYNC.CONNECTOR_KEY })) ?? repo.sync().create({ connector: INBOUND_SYNC.CONNECTOR_KEY, failures: 0 });

/** D. Every open shipment checked by id (catches anything a poll missed). */
const sweepOpen = async (rep: InboundReport, opts: InboundRunOptions, now: Date, fetched: Set<string>) => {
  const open = await repo.ships().find({ select: ['externalId'], where: { sourceSystem: SRC, status: Not(In([...AMAZON_FINAL_STATUSES])) } });
  if (!open.length) return;
  const found = await api.shipmentsByIds(open.map((s) => s.externalId));
  rep.shipments.swept = found.length;
  for (const s of found) {
    try { await applyChange(rep, s, { apply: opts.apply, source: INBOUND_EVENT_SOURCE.SWEEP, now, fetchedThisRun: fetched }); }
    catch (err) { rep.errors.push(`${s.ShipmentId}: ${(err as Error).message}`.slice(0, CHANNEL_API.ERROR_MAX)); }
  }
};

/** One tracking run (scheduler, command line). */
export const runInboundSync = async (opts: InboundRunOptions): Promise<InboundReport> => {
  const startCalls = api.calls.count;
  const state = await syncRow();
  const now = new Date();
  const until = new Date(now.getTime() - CHANNEL_API.SETTLE_MS);
  const since = state.syncedUntil && opts.lookbackDays === undefined
    ? new Date(state.syncedUntil.getTime() - CHANNEL_API.OVERLAP_MS)
    : new Date(now.getTime() - (opts.lookbackDays ?? INBOUND_SYNC.FIRST_LOOKBACK_DAYS) * DAY_MS);
  const rep = newReport(opts.apply, since, until);
  const fetched = new Set<string>();

  await discoverPlans(rep, opts, now, fetched);
  const changed = [...new Map((await api.listChangedShipments(since, until)).map((s) => [s.ShipmentId, s])).values()];
  log.info(LOG_SOURCE.AMAZON, `[inbound] ${changed.length} shipment(s) changed since ${since.toISOString()}`);
  for (const s of changed) {
    try { await applyChange(rep, s, { apply: opts.apply, source: opts.source, now, fetchedThisRun: fetched }); }
    catch (err) { rep.errors.push(`${s.ShipmentId}: ${(err as Error).message}`.slice(0, CHANNEL_API.ERROR_MAX)); }
  }
  const lastSweep = (state.lastResult?.lastSweepAt as string | undefined) ? new Date(state.lastResult?.lastSweepAt as string) : null;
  const sweepDue = opts.sweep || (opts.apply && (!lastSweep || now.getTime() - lastSweep.getTime() > DAY_MS));
  if (sweepDue) await sweepOpen(rep, opts, now, fetched);
  if (opts.apply) await linkPos(rep);
  rep.calls = api.calls.count - startCalls;

  if (opts.apply) {
    await repo.sync().save({
      ...state, syncedUntil: until, lastRunAt: now, lastSuccessAt: new Date(), failures: 0,
      lastError: rep.errors.length ? `${rep.errors.length} item(s) failed (retried by the next run / daily check)` : null,
      lastResult: { plans: rep.plans, shipments: rep.shipments, calls: rep.calls, lastSweepAt: sweepDue ? now.toISOString() : (lastSweep?.toISOString() ?? null) },
    });
  }
  return rep;
};

/** A run that failed as a whole: counted, check point kept (the next run asks from the same point). */
export const recordInboundFailure = async (err: unknown): Promise<void> => {
  const state = await syncRow();
  await repo.sync().save({ ...state, lastRunAt: new Date(), failures: (state.failures ?? 0) + 1, lastError: (err instanceof Error ? err.message : String(err)).slice(0, CHANNEL_API.ERROR_MAX) });
};

/** A person's Refresh (or the re-check before a CSV download): this one shipment, lines included. */
export const refreshShipment = async (externalId: string): Promise<InboundReport> => {
  const now = new Date();
  const rep = newReport(true, now, now);
  const start = api.calls.count;
  const [s] = await api.shipmentsByIds([externalId]);
  if (s) await applyChange(rep, s, { apply: true, source: INBOUND_EVENT_SOURCE.REFRESH, now, forceLines: true, fetchedThisRun: new Set() });
  await linkPos(rep);
  rep.calls = api.calls.count - start;
  return rep;
};
