import { DataSource, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import {
  CSV_LIST_SEPARATOR,
  MASTER_CSV_COLUMNS,
  MASTER_LOAD_TYPE,
  MasterLoadType,
  MasterSource,
  REMARK_LIST,
  RemarkList,
  STATUS_STAGE,
  StatusStage,
} from '../../constants';
import {
  DetailsChannel,
  MasterAppointmentRemark,
  MasterChannel,
  MasterCourierPartner,
  MasterCourierRate,
  MasterFacility,
  MasterFinalStatusMap,
  MasterShipmentStatus,
} from '../../entities';
import { codeIndex, matchKey } from './master-match';

/*
 * masters:load: plans what one CSV changes in one master table, then (with --apply) writes it in one transaction.
 *   - A row is found by its key (code or alias for facilities / partners; the natural key for the others); found =
 *     update the columns the file HAS (a column missing from the header is left alone), else add.
 *   - Rows in the file become active and get the file's source. Nothing is ever deleted or switched off: rows in the DB
 *     but not in the file are only listed ("not in file"), for the user to decide.
 *   - A spelling of a code that differs from the DB (other than case) is kept as an alias; --set-code makes the file's
 *     spelling the code instead (the old code becomes an alias): for the real Uniware facility codes.
 *   - channel: fills PEPIMS's channel-location fields of existing details_channels rows (never adds a location).
 */

export interface LoadChange {
  action: 'add' | 'update' | 'same' | 'skip';
  key: string;
  detail?: string;
}

export interface LoadPlan {
  type: MasterLoadType;
  changes: LoadChange[];
  /** Active rows of the table the file does not have (report only). */
  notInFile: string[];
  /** Writes the adds and updates; call inside a transaction. */
  apply: (m: EntityManager) => Promise<void>;
}

export interface LoadOptions {
  source: MasterSource;
  /** Facilities / partners: the file's spelling becomes the code. */
  setCode?: boolean;
}

type Rec = Record<string, string>;
type Op = (m: EntityManager) => Promise<void>;

const txt = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
const list = (v: string | undefined): string[] => (v ?? '').split(CSV_LIST_SEPARATOR).map((s) => s.trim()).filter(Boolean);
/** '' -> null; not a number -> undefined (the row is skipped). */
const num = (v: string | undefined): number | null | undefined => {
  if (!v || !v.trim()) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const norm = (v: unknown): string => JSON.stringify(Array.isArray(v) ? [...v].sort() : v ?? null);

/** "field: old -> new" for every field whose value changes. */
const diff = (old: ObjectLiteral, next: ObjectLiteral): string[] =>
  Object.keys(next).filter((k) => norm(old[k]) !== norm(next[k])).map((k) => `${k}: ${norm(old[k])} -> ${norm(next[k])}`);

/** Keeps only the fields whose CSV column is in the header. */
const pick = <T extends ObjectLiteral>(header: string[], fields: [string, keyof T, unknown][]): Partial<T> =>
  Object.fromEntries(fields.filter(([col]) => header.includes(col)).map(([, key, value]) => [key, value])) as Partial<T>;

/** Missing required columns, for the usage error. */
export const missingColumns = (type: MasterLoadType, header: string[]): string[] =>
  MASTER_CSV_COLUMNS[type].required.filter((c) => !header.includes(c));

class Planner {
  readonly changes: LoadChange[] = [];
  readonly ops: Op[] = [];
  private readonly seen = new Set<string>();

  /** false (and a skip) when the key was already in the file. */
  first(key: string): boolean {
    if (this.seen.has(matchKey(key))) {
      this.changes.push({ action: 'skip', key, detail: 'duplicate row in the file (the first one is used)' });
      return false;
    }
    this.seen.add(matchKey(key));
    return true;
  }

  skip(key: string, detail: string): void {
    this.changes.push({ action: 'skip', key, detail });
  }

  upsert<T extends ObjectLiteral>(target: EntityTarget<T>, key: string, existing: (T & { id: number | string }) | null, next: Partial<T>, note?: string): void {
    if (!existing) {
      this.changes.push({ action: 'add', key, detail: note });
      this.ops.push(async (m) => { await m.getRepository(target).insert(next as never); });
      return;
    }
    const changed = diff(existing, next);
    if (!changed.length) {
      this.changes.push({ action: 'same', key, detail: note });
      return;
    }
    this.changes.push({ action: 'update', key, detail: [note, ...changed].filter(Boolean).join('; ') });
    this.ops.push(async (m) => { await m.getRepository(target).update(existing.id, next as never); });
  }

  plan(type: MasterLoadType, notInFile: string[]): LoadPlan {
    const ops = this.ops;
    return { type, changes: this.changes, notInFile, apply: async (m) => { for (const op of ops) await op(m); } };
  }
}

/** Code + aliases after a file row matched `existing` (see the header: --set-code). */
const codeAndAliases = (existing: { code: string; aliases: string[] | null } | null, code: string, fileAliases: string[], setCode: boolean) => {
  if (!existing) return { code, aliases: fileAliases.length ? fileAliases : null, note: undefined };
  const aliases = new Set([...(existing.aliases ?? []), ...fileAliases]);
  let finalCode = existing.code;
  let note: string | undefined;
  if (existing.code !== code) {
    if (setCode) {
      finalCode = code;
      aliases.add(existing.code);
      note = `code ${existing.code} -> ${code} (old code kept as alias)`;
    } else {
      if (matchKey(existing.code) !== matchKey(code)) aliases.add(code);
      note = `file spelling "${code}" matched "${existing.code}"`;
    }
  }
  for (const a of [...aliases]) if (matchKey(a) === matchKey(finalCode) && a === finalCode) aliases.delete(a);
  return { code: finalCode, aliases: aliases.size ? [...aliases].sort() : null, note };
};

const planFacilities = async (db: DataSource, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const rows = await db.getRepository(MasterFacility).find();
  const idx = codeIndex(rows);
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const code = txt(r.facility);
    if (!code) { p.skip('(empty)', 'no facility code'); continue; }
    if (!p.first(code)) continue;
    const existing = idx.find(code) ?? list(r.aliases).map((a) => idx.find(a)).find(Boolean) ?? null;
    if (existing) used.add(existing.id);
    const ca = codeAndAliases(existing, code, list(r.aliases), !!o.setCode);
    const next: Partial<MasterFacility> = {
      code: ca.code,
      aliases: ca.aliases,
      ...pick<MasterFacility>(header, [
        ['pickupLocation', 'pickupLocation', txt(r.pickupLocation)],
        ['name', 'name', txt(r.name)],
        ['entity', 'entity', txt(r.entity)],
        ['state', 'state', txt(r.state)],
        ['facilityType', 'facilityType', txt(r.facilityType)],
        ['billToGstin', 'billToGstin', txt(r.billToGstin)],
        ['shipToGstin', 'shipToGstin', txt(r.shipToGstin)],
        ['remarks', 'remarks', txt(r.remarks)],
      ]),
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterFacility, code, existing, next, ca.note);
  }
  return p.plan(MASTER_LOAD_TYPE.FACILITY, rows.filter((f) => f.isActive && !used.has(f.id)).map((f) => `${f.code} (${f.source})`));
};

const planCourierPartners = async (db: DataSource, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const rows = await db.getRepository(MasterCourierPartner).find();
  const idx = codeIndex(rows);
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const code = txt(r.courierPartnerMode);
    if (!code) { p.skip('(empty)', 'no courierPartnerMode'); continue; }
    if (!p.first(code)) continue;
    const money = [r.appointmentChargeYes, r.appointmentChargeNo, r.docketCharges, r.tat].map(num);
    if (money.some((n) => n === undefined)) { p.skip(code, 'a charge or tat is not a number'); continue; }
    const existing = idx.find(code) ?? list(r.aliases).map((a) => idx.find(a)).find(Boolean) ?? null;
    if (existing) used.add(existing.id);
    const ca = codeAndAliases(existing, code, list(r.aliases), !!o.setCode);
    const next: Partial<MasterCourierPartner> = {
      code: ca.code,
      aliases: ca.aliases,
      ...pick<MasterCourierPartner>(header, [
        ['courierPartner', 'partner', txt(r.courierPartner)],
        ['courierMode', 'mode', txt(r.courierMode)],
        ['courierType', 'courierType', txt(r.courierType)],
        ['appointmentChargeYes', 'appointmentChargeYes', money[0]],
        ['appointmentChargeNo', 'appointmentChargeNo', money[1]],
        ['docketCharges', 'docketCharges', money[2]],
        ['tat', 'tatDays', money[3]],
      ]),
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterCourierPartner, code, existing, next, ca.note);
  }
  return p.plan(MASTER_LOAD_TYPE.COURIER_PARTNER, rows.filter((f) => f.isActive && !used.has(f.id)).map((f) => `${f.code} (${f.source})`));
};

const planCourierRates = async (db: DataSource, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const partners = codeIndex(await db.getRepository(MasterCourierPartner).find());
  const rows = await db.getRepository(MasterCourierRate).find();
  const keyOf = (partnerId: number, from: string, to: string) => `${partnerId}|${matchKey(from)}|${matchKey(to)}`;
  const byKey = new Map(rows.map((r) => [keyOf(r.courierPartnerId, r.pickupLocation, r.dropLocation), r]));
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const label = `${r.courierPartner} ${r.pickupLocation} -> ${r.dropLocation}`;
    const partner = partners.find(r.courierPartner);
    const from = txt(r.pickupLocation);
    const to = txt(r.dropLocation);
    if (!partner) { p.skip(label, 'courier partner not in master_courier_partners (load courier-partner first)'); continue; }
    if (!from || !to) { p.skip(label, 'pickup or drop location empty'); continue; }
    const rate = num(r.ratesPerKg);
    const tat = num(r.tat);
    if (rate === undefined || tat === undefined) { p.skip(label, 'ratesPerKg or tat is not a number'); continue; }
    if (!p.first(keyOf(partner.id, from, to))) continue;
    const existing = byKey.get(keyOf(partner.id, from, to)) ?? null;
    if (existing) used.add(existing.id);
    const next: Partial<MasterCourierRate> = {
      courierPartnerId: partner.id,
      pickupLocation: existing?.pickupLocation ?? from,
      dropLocation: existing?.dropLocation ?? to,
      ...pick<MasterCourierRate>(header, [['ratesPerKg', 'ratePerKg', rate], ['tat', 'tatDays', tat]]),
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterCourierRate, label, existing, next);
  }
  return p.plan(MASTER_LOAD_TYPE.COURIER_RATES, rows.filter((r) => r.isActive && !used.has(r.id)).map((r) => `${partners.byId.get(r.courierPartnerId)?.code} ${r.pickupLocation} -> ${r.dropLocation} (${r.source})`));
};

const STAGES = Object.values(STATUS_STAGE) as string[];

const planStatusValues = async (db: DataSource, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const rows = await db.getRepository(MasterShipmentStatus).find();
  const keyOf = (stage: string, value: string) => `${stage}|${matchKey(value)}`;
  const byKey = new Map(rows.map((r) => [keyOf(r.stage, r.value), r]));
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const stage = matchKey(r.stage);
    const value = txt(r.value);
    const label = `${r.stage}: ${r.value}`;
    if (!STAGES.includes(stage)) { p.skip(label, `stage must be one of ${STAGES.join(', ')}`); continue; }
    if (!value) { p.skip(label, 'empty value'); continue; }
    const sort = num(r.sortOrder);
    if (sort === undefined) { p.skip(label, 'sortOrder is not a number'); continue; }
    if (!p.first(keyOf(stage, value))) continue;
    const existing = byKey.get(keyOf(stage, value)) ?? null;
    if (existing) used.add(existing.id);
    const next: Partial<MasterShipmentStatus> = {
      stage: stage as StatusStage,
      value: existing?.value ?? value,
      ...pick<MasterShipmentStatus>(header, [['sortOrder', 'sortOrder', sort ?? 0]]),
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterShipmentStatus, label, existing, next);
  }
  return p.plan(MASTER_LOAD_TYPE.STATUS_VALUES, rows.filter((r) => r.isActive && !used.has(r.id)).map((r) => `${r.stage}: ${r.value} (${r.source})`));
};

const planFinalStatus = async (db: DataSource, _header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const rows = await db.getRepository(MasterFinalStatusMap).find();
  const values = new Set((await db.getRepository(MasterShipmentStatus).find()).map((s) => `${s.stage}|${matchKey(s.value)}`));
  const keyOf = (a: string, b: string, c: string) => [a, b, c].map(matchKey).join('|');
  const byKey = new Map(rows.map((r) => [keyOf(r.statusPlanning, r.statusWarehouse, r.statusLogistics), r]));
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const [pl, wh, lg, fin] = [r.statusPlanning, r.statusWarehouse, r.statusLogistics, r.statusFinal].map(txt);
    const label = `${pl} + ${wh} + ${lg}`;
    if (!pl || !wh || !lg || !fin) { p.skip(label, 'all four statuses are needed'); continue; }
    if (!p.first(keyOf(pl, wh, lg))) continue;
    const unknown = ([[STATUS_STAGE.PLANNING, pl], [STATUS_STAGE.WAREHOUSE, wh], [STATUS_STAGE.LOGISTICS, lg]] as const)
      .filter(([s, v]) => !values.has(`${s}|${matchKey(v)}`)).map(([s, v]) => `${s} "${v}"`);
    const existing = byKey.get(keyOf(pl, wh, lg)) ?? null;
    if (existing) used.add(existing.id);
    const next: Partial<MasterFinalStatusMap> = {
      statusPlanning: existing?.statusPlanning ?? pl,
      statusWarehouse: existing?.statusWarehouse ?? wh,
      statusLogistics: existing?.statusLogistics ?? lg,
      statusFinal: fin,
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterFinalStatusMap, label, existing, next, unknown.length ? `not in status-values: ${unknown.join(', ')}` : undefined);
  }
  return p.plan(MASTER_LOAD_TYPE.STATUS, rows.filter((r) => r.isActive && !used.has(r.id)).map((r) => `${r.statusPlanning} + ${r.statusWarehouse} + ${r.statusLogistics} (${r.source})`));
};

const LISTS = Object.values(REMARK_LIST) as string[];

const planRemarks = async (db: DataSource, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  const rows = await db.getRepository(MasterAppointmentRemark).find();
  const keyOf = (l: string, remark: string) => `${l}|${matchKey(remark)}`;
  const byKey = new Map(rows.map((r) => [keyOf(r.list, r.remark), r]));
  const p = new Planner();
  const used = new Set<number>();
  for (const r of recs) {
    const l = matchKey(r.list) || REMARK_LIST.APPOINTMENT_CHANGE;
    const remark = txt(r.remark);
    const label = `${l}: ${r.remark}`;
    if (!LISTS.includes(l)) { p.skip(label, `list must be one of ${LISTS.join(', ')}`); continue; }
    if (!remark) { p.skip(label, 'empty remark'); continue; }
    const sort = num(r.sortOrder);
    if (sort === undefined) { p.skip(label, 'sortOrder is not a number'); continue; }
    if (!p.first(keyOf(l, remark))) continue;
    const existing = byKey.get(keyOf(l, remark)) ?? null;
    if (existing) used.add(existing.id);
    const next: Partial<MasterAppointmentRemark> = {
      list: l as RemarkList,
      remark: existing?.remark ?? remark,
      ...pick<MasterAppointmentRemark>(header, [['category', 'category', txt(r.category)], ['sortOrder', 'sortOrder', sort ?? 0]]),
      isActive: true,
      source: o.source,
    };
    p.upsert(MasterAppointmentRemark, label, existing, next);
  }
  return p.plan(MASTER_LOAD_TYPE.APPOINTMENT_REMARKS, rows.filter((r) => r.isActive && !used.has(r.id)).map((r) => `${r.list}: ${r.remark} (${r.source})`));
};

/** PEPIMS channel location master -> the four fields of existing details_channels rows (channel by name / slug / alias). */
const planChannelLocations = async (db: DataSource, header: string[], recs: Rec[]): Promise<LoadPlan> => {
  const channels = await db.getRepository(MasterChannel).find();
  const channelByName = new Map<string, MasterChannel>();
  for (const c of channels) for (const n of [c.displayName, c.slug, ...(c.dbAliases ?? [])]) if (!channelByName.has(matchKey(n))) channelByName.set(matchKey(n), c);
  const locations = await db.getRepository(DetailsChannel).find({ select: ['id', 'channelId', 'channelName', 'channelLocationCode', 'channelCategory', 'dropLocation', 'appointmentChannel', 'appointmentChannelType'] });
  const p = new Planner();
  const used = new Set<string>();
  for (const r of recs) {
    const label = `${r.channel} / ${r.channelLocation}`;
    const channel = channelByName.get(matchKey(r.channel));
    if (!channel) { p.skip(label, 'channel not in master_channels (name, slug or alias)'); continue; }
    if (!p.first(`${channel.id}|${matchKey(r.channelLocation)}`)) continue;
    const rows = locations.filter((l) => l.channelId === channel.id && matchKey(l.channelLocationCode) === matchKey(r.channelLocation));
    if (!rows.length) { p.skip(label, 'no details_channels row with this location code'); continue; }
    const next = pick<DetailsChannel>(header, [
      ['channelCategory', 'channelCategory', txt(r.channelCategory)],
      ['dropLocation', 'dropLocation', txt(r.dropLocation)],
      ['apptChannel', 'appointmentChannel', txt(r.apptChannel)],
      ['apptChannelType', 'appointmentChannelType', txt(r.apptChannelType)],
    ]);
    for (const row of rows) {
      used.add(row.id);
      p.upsert(DetailsChannel, `${label} (id ${row.id})`, row as DetailsChannel & { id: string }, next, rows.length > 1 ? `${rows.length} rows share this location code` : undefined);
    }
  }
  return p.plan(MASTER_LOAD_TYPE.CHANNEL, locations.filter((l) => !used.has(l.id)).map((l) => `${l.channelName} / ${l.channelLocationCode}`));
};

export const planMasterLoad = (db: DataSource, type: MasterLoadType, header: string[], recs: Rec[], o: LoadOptions): Promise<LoadPlan> => {
  switch (type) {
    case MASTER_LOAD_TYPE.FACILITY: return planFacilities(db, header, recs, o);
    case MASTER_LOAD_TYPE.COURIER_PARTNER: return planCourierPartners(db, header, recs, o);
    case MASTER_LOAD_TYPE.COURIER_RATES: return planCourierRates(db, header, recs, o);
    case MASTER_LOAD_TYPE.STATUS_VALUES: return planStatusValues(db, header, recs, o);
    case MASTER_LOAD_TYPE.STATUS: return planFinalStatus(db, header, recs, o);
    case MASTER_LOAD_TYPE.APPOINTMENT_REMARKS: return planRemarks(db, header, recs, o);
    case MASTER_LOAD_TYPE.CHANNEL: return planChannelLocations(db, header, recs);
  }
};
