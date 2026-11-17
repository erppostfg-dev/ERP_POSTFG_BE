import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  PEPIMS_LINE_FIELDS, PEPIMS_PO_FIELDS, PEPIMS_PO_TABLES, PEPIMS_SYNC_BATCH, PEPIMS_SYNC_STATE_KEY, PEPIMS_FIELD_KIND, PO_IMPORTED_FROM,
  SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES,
} from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PepimsSyncLineLink, PepimsSyncLink, ShipmentLog } from '../../entities';
import { channelChoice, ChannelChoice, mapLine, MappedPo, mapPo, Masters, partnerKeyOf, Row, statusKeyOf, textOf, toValues } from './mapping';

/*
 * PEPIMS -> POST_FG (2026-11-16, step 2a of the PEPIMS + dev -> prod migration; constants/pepims-sync.ts). One run =
 * the import the first time and the PEPIMS -> POST_FG half of the sync after that:
 *   - PEPIMS is READ only (own connection, START TRANSACTION READ ONLY); we write only to the app's own database.
 *   - a PEPIMS PO not linked yet: same channel + PO number already ours -> linked, PEPIMS values win (user); else
 *     inserted with its PEPIMS uid (another uid only when that one is taken), lines with their PEPIMS ids, importedFrom
 *     'pepims', History: "imported from PEPIMS" + PEPIMS's own log lines.
 *   - a linked PO: a field PEPIMS changed since the last sync is taken, unless ours changed it too and later (then ours
 *     stays and the report lists it); new PEPIMS lines are added; nothing is ever deleted.
 *   - a re-run reads only POs / lines changed since the last run (watermarks in app_state) and new PEPIMS log lines.
 * Dry run (default) = everything read and planned, nothing written; the report says what would happen.
 */

type Canon = Record<string, string | null>;
interface State { poUpdatedAt: string | null; lineUpdatedAt: string | null; logId: number }

export interface SyncReport {
  apply: boolean;
  source: string;
  target: string;
  /** PEPIMS POs read this run. */
  read: number;
  skipped: string[];
  inserted: number;
  /** Inserted under another uid (PEPIMS's was taken). */
  newUid: number;
  linked: number;
  updated: number;
  unchanged: number;
  fieldChanges: number;
  conflictsKeptOurs: { uid: string; field: string; pepims: string | null; ours: string | null }[];
  linesInserted: number;
  linesLinked: number;
  linesUpdated: number;
  /** Lines of ours with no PEPIMS line (on a PO linked by channel + PO number): kept. */
  oursWithoutPepimsLine: number;
  logsAdded: number;
  byGroup: Record<string, number>;
  byChannel: Record<string, number>;
  channelNotes: Record<string, number>;
  unmatched: { facility: Record<string, number>; transporter: Record<string, number>; location: Record<string, number>; status: Record<string, number> };
  junkDates: Record<string, number>;
  /** Watermarks saved for the next run (null in a dry run / limited run). */
  saved: State | null;
  /** Dry run on a database without migration PepimsMigration yet (links read as none). */
  noLinkTables: boolean;
}

const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const DATE_FIELDS = Object.entries(PEPIMS_PO_FIELDS).filter(([, k]) => k === PEPIMS_FIELD_KIND.DATE).map(([f]) => f);
const LINK_OF: Record<string, string> = {
  facility: 'facilityId', location: 'locationId', firstTransporter: 'firstTransporterId', secondTransporter: 'secondTransporterId', thirdTransporter: 'thirdTransporterId',
};

/** Our PO / line values in the canonical form (dates as text, numbers as text). */
const ourPoSelect = ['uid', 'channel', 'poNumber', 'updatedAt', ...Object.keys(PEPIMS_PO_FIELDS).map((f) => (DATE_FIELDS.includes(f) ? `DATE_FORMAT(\`${f}\`, '%Y-%m-%d') AS \`${f}\`` : `\`${f}\``))]
  .map((c) => (c.includes('`') ? c : `\`${c}\``)).join(', ');
const canonOurs = (r: Row, kinds: Readonly<Record<string, string>>): Canon =>
  Object.fromEntries(Object.keys(kinds).map((f) => [f, toCanon(kinds[f], r[f])]));
const toCanon = (kind: string, v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (kind === PEPIMS_FIELD_KIND.JSON) return JSON.stringify(typeof v === 'string' ? JSON.parse(v) as unknown : v);
  if (kind === PEPIMS_FIELD_KIND.INT) return String(Math.round(Number(v)));
  if (kind === PEPIMS_FIELD_KIND.DEC2) return Number(v).toFixed(2);
  if (kind === PEPIMS_FIELD_KIND.DEC3) return Number(v).toFixed(3);
  const s = textOf(v);
  return s === '' ? null : s;
};

const loadMasters = async (db: DataSource): Promise<Masters> => {
  const [channels, facilities, statuses, partners, locations] = await Promise.all([
    db.query<{ n: string }[]>(`SELECT display_name n FROM ${TABLES.MASTER_CHANNELS}`),
    db.query<{ code: string; id: number }[]>(`SELECT code, id FROM ${TABLES.MASTER_FACILITIES}`),
    db.query<{ stage: string; value: string }[]>(`SELECT stage, value FROM ${TABLES.MASTER_SHIPMENT_STATUSES} WHERE is_active = 1`),
    db.query<{ id: number; code: string; partner: string }[]>(`SELECT id, code, partner FROM ${TABLES.MASTER_COURIER_PARTNERS} WHERE is_active = 1`),
    db.query<{ id: string; ch: string; code: string | null; drop: string | null; city: string | null }[]>(
      `SELECT id, channel_name ch, channel_location_code code, drop_location \`drop\`, city FROM ${TABLES.DETAILS_CHANNELS}`),
  ]);
  const st = new Map<string, Map<string, string>>();
  for (const s of statuses) (st.get(s.stage) ?? st.set(s.stage, new Map()).get(s.stage)!).set(statusKeyOf(s.value), s.value);
  const loc = new Map<string, { id: string; code: string | null; drop: string | null; city: string | null }[]>();
  for (const l of locations) (loc.get(l.ch) ?? loc.set(l.ch, []).get(l.ch)!).push({ id: String(l.id), code: l.code, drop: l.drop, city: l.city });
  return {
    channels: new Set(channels.map((c) => c.n)),
    facilities: new Map(facilities.map((f) => [f.code, Number(f.id)])),
    statuses: st,
    partners: new Map(partners.map((p) => [partnerKeyOf(p.code), { id: Number(p.id), code: p.code }])),
    locations: loc,
  };
};

const readState = async (): Promise<State | null> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [PEPIMS_SYNC_STATE_KEY]);
  if (!row) return null;
  return (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as State;
};
const saveState = (s: State) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [PEPIMS_SYNC_STATE_KEY, JSON.stringify(s), new Date()],
);

/** PEPIMS log messages -> one History text. */
const logText = (messages: unknown): string => {
  const list = (typeof messages === 'string' ? JSON.parse(messages) : messages) as unknown;
  const items = Array.isArray(list) ? list : [list];
  return items.map((x) => (x && typeof x === 'object' && 'change' in x ? String((x as { change: unknown }).change) : JSON.stringify(x))).join('; ');
};

interface Plan {
  poInserts: Row[];
  lineInserts: Row[];
  links: { poUid: string; pepimsUid: number; syncedValues: Canon; pepimsUpdatedAt: string | null }[];
  lineLinks: { lineId: string | null; pepimsLineId: number; poUid: string; syncedValues: Canon; insertRow?: Row }[];
  poUpdates: { uid: string; set: Row }[];
  lineUpdates: { id: string; set: Row }[];
  history: Row[];
  /** POs inserted without their PEPIMS uid (taken): one by one, lines after. */
  movedPos: { row: Row; pepimsUid: number; lines: { row: Row; pepimsLineId: number; synced: Canon }[]; synced: Canon; pepimsUpdatedAt: string | null; historyRemark: string }[];
}

export const runPepimsSync = async (o: { apply: boolean; limit?: number; log?: (s: string) => void }): Promise<SyncReport> => {
  const say = o.log ?? (() => undefined);
  const report: SyncReport = {
    apply: o.apply, source: env.pepimsSync.sourceDb, target: String(AppDataSource.options.database), read: 0, skipped: [], inserted: 0, newUid: 0, linked: 0,
    updated: 0, unchanged: 0, fieldChanges: 0, conflictsKeptOurs: [], linesInserted: 0, linesLinked: 0, linesUpdated: 0, oursWithoutPepimsLine: 0,
    logsAdded: 0, byGroup: {}, byChannel: {}, channelNotes: {}, unmatched: { facility: {}, transporter: {}, location: {}, status: {} }, junkDates: {}, saved: null, noLinkTables: false,
  };
  const src = new DataSource({
    type: 'mysql', host: env.db.host, port: env.db.port, username: env.db.username, password: env.db.password,
    database: env.pepimsSync.sourceDb, synchronize: false, entities: [], dateStrings: true,
  });
  await src.initialize();
  const qr = src.createQueryRunner();
  const q = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await qr.query(sql, params)) as T;
  try {
    await qr.query('START TRANSACTION READ ONLY');
    const masters = await loadMasters(AppDataSource);
    const [has] = await AppDataSource.query<{ n: number }[]>('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [TABLES.PEPIMS_SYNC_LINKS]);
    report.noLinkTables = !Number(has.n);
    if (report.noLinkTables && o.apply) throw new Error(`${report.target} has no ${TABLES.PEPIMS_SYNC_LINKS}: run the migrations first (PepimsMigration). Nothing written.`);
    const state = report.noLinkTables ? null : await readState();
    const [top] = await q<{ po: string | null; line: string | null; log: number | null }[]>(
      `SELECT (SELECT MAX(updatedAt) FROM ${PEPIMS_PO_TABLES.PO}) po, (SELECT MAX(updatedAt) FROM ${PEPIMS_PO_TABLES.LINES}) line, (SELECT MAX(id) FROM ${PEPIMS_PO_TABLES.LOGS}) log`);
    const uidRows = await q<{ uid: number }[]>(state
      ? `SELECT uid FROM ${PEPIMS_PO_TABLES.PO} WHERE updatedAt >= ? UNION SELECT shipmentOrderId FROM ${PEPIMS_PO_TABLES.LINES} WHERE updatedAt >= ? UNION SELECT shipmentOrderId FROM ${PEPIMS_PO_TABLES.LOGS} WHERE id > ? ORDER BY 1`
      : `SELECT uid FROM ${PEPIMS_PO_TABLES.PO} ORDER BY uid`,
      state ? [state.poUpdatedAt ?? '1970-01-01', state.lineUpdatedAt ?? '1970-01-01', state.logId] : []);
    let uids = uidRows.map((r) => Number(r.uid)).filter((u) => Number.isFinite(u));
    if (o.limit) uids = uids.slice(0, o.limit);
    const pepUsers = new Map((await q<{ id: number; name: string | null; email: string | null }[]>(`SELECT id, name, email FROM ${PEPIMS_PO_TABLES.USERS}`)).map((u) => [Number(u.id), u]));
    const ourUsers = new Map((await AppDataSource.query<{ id: number; email: string }[]>(`SELECT id, email FROM ${TABLES.USERS}`)).map((u) => [u.email.toLowerCase(), Number(u.id)]));
    say(`[pepims-sync] ${report.source} -> ${report.target}: ${uids.length} PEPIMS POs to look at (${state ? 'changed since the last run' : 'first run: all'})`);

    for (const [i, batch] of chunk(uids, PEPIMS_SYNC_BATCH).entries()) {
      const pos = await q<Row[]>(`SELECT * FROM ${PEPIMS_PO_TABLES.PO} WHERE uid IN (?) ORDER BY uid`, [batch]);
      const lines = await q<Row[]>(`SELECT * FROM ${PEPIMS_PO_TABLES.LINES} WHERE shipmentOrderId IN (?) ORDER BY shipmentOrderId, id`, [batch]);
      const logs = await q<Row[]>(`SELECT id, messages, createdBy, shipmentOrderId, createdAt FROM ${PEPIMS_PO_TABLES.LOGS} WHERE shipmentOrderId IN (?) AND id > ? ORDER BY id`, [batch, state?.logId ?? 0]);
      const plan = await planBatch(pos, lines, logs, masters, report, pepUsers, ourUsers, report.noLinkTables);
      if (o.apply) await AppDataSource.transaction((m) => applyPlan(m, plan, report));
      say(`[pepims-sync] batch ${i + 1}: ${pos.length} POs (inserted ${report.inserted}, linked ${report.linked}, updated ${report.updated}, unchanged ${report.unchanged})`);
    }
    if (o.apply && !o.limit) {
      report.saved = { poUpdatedAt: top.po, lineUpdatedAt: top.line, logId: Number(top.log ?? 0) };
      await saveState(report.saved);
    }
  } finally {
    await qr.query('ROLLBACK').catch(() => undefined);
    await qr.release();
    await src.destroy();
  }
  return report;
};

const planBatch = async (
  pos: Row[], lines: Row[], logs: Row[], masters: Masters, report: SyncReport,
  pepUsers: Map<number, { name: string | null; email: string | null }>, ourUsers: Map<string, number>, noLinkTables = false,
): Promise<Plan> => {
  const plan: Plan = { poInserts: [], lineInserts: [], links: [], lineLinks: [], poUpdates: [], lineUpdates: [], history: [], movedPos: [] };
  report.read += pos.length;
  const pepUids = pos.map((p) => Number(p.uid));
  const links = new Map((pepUids.length && !noLinkTables ? await AppDataSource.getRepository(PepimsSyncLink).findBy({ pepimsUid: In(pepUids) }) : []).map((l) => [l.pepimsUid, l]));
  const choices = new Map<number, ChannelChoice | null>(pos.map((p) => [Number(p.uid), channelChoice(p.channel as string | null, masters)]));
  // ours by channel + PO number (for POs not linked yet) and by uid (linked)
  const unlinkedPoNumbers = pos.filter((p) => !links.has(Number(p.uid))).map((p) => String(p.poNumber));
  const byKey = new Map<string, Row>();
  if (unlinkedPoNumbers.length) {
    for (const r of await AppDataSource.query<Row[]>(`SELECT ${ourPoSelect} FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE poNumber IN (?)`, [unlinkedPoNumbers])) {
      byKey.set(`${String(r.channel).toLowerCase()}|${String(r.poNumber)}`, r);
    }
  }
  const linkedUids = [...links.values()].map((l) => l.poUid);
  const oursByUid = new Map((linkedUids.length ? await AppDataSource.query<Row[]>(`SELECT ${ourPoSelect} FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE uid IN (?)`, [linkedUids]) : []).map((r) => [String(r.uid), r]));
  const lineLinks = new Map((linkedUids.length ? await AppDataSource.getRepository(PepimsSyncLineLink).findBy({ poUid: In(linkedUids) }) : []).map((l) => [l.pepimsLineId, l]));
  const takenUids = new Set((pepUids.length ? await AppDataSource.query<{ uid: string }[]>(`SELECT uid FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE uid IN (?)`, [pepUids]) : []).map((r) => String(r.uid)));
  const pepLineIds = lines.map((l) => Number(l.id));
  const takenLineIds = new Set((pepLineIds.length ? await AppDataSource.query<{ id: string }[]>(`SELECT id FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE id IN (?)`, [pepLineIds]) : []).map((r) => String(r.id)));
  const linesOf = new Map<number, Row[]>();
  for (const l of lines) (linesOf.get(Number(l.shipmentOrderId)) ?? linesOf.set(Number(l.shipmentOrderId), []).get(Number(l.shipmentOrderId))!).push(l);
  const logsOf = new Map<number, Row[]>();
  for (const l of logs) (logsOf.get(Number(l.shipmentOrderId)) ?? logsOf.set(Number(l.shipmentOrderId), []).get(Number(l.shipmentOrderId))!).push(l);
  const now = new Date();
  const batchId = randomUUID();
  const history = (uid: string, action: string, remark: string, extra: Row = {}) =>
    plan.history.push({ shipmentUid: uid, userId: null, action, source: SHIPMENT_LOG_SOURCE.SCRIPT, batchId, remark, ...extra });
  const pepimsLogsFor = (uid: string, pepUid: number) => {
    for (const lg of logsOf.get(pepUid) ?? []) {
      const who = pepUsers.get(Number(lg.createdBy));
      const userId = who?.email ? ourUsers.get(who.email.toLowerCase()) ?? null : null;
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `PEPIMS: ${logText(lg.messages)}${who ? ` (by ${who.name ?? who.email ?? lg.createdBy as string})` : ''}`, { userId, createdAt: lg.createdAt });
      report.logsAdded++;
    }
  };
  const noteUnmatched = (mp: MappedPo) => {
    if (mp.notes.facility) bump(report.unmatched.facility, mp.notes.facility);
    for (const t of mp.notes.transporters) bump(report.unmatched.transporter, t);
    if (mp.notes.location) bump(report.unmatched.location, mp.notes.location);
    for (const s of mp.notes.statuses) bump(report.unmatched.status, s);
    for (const d of mp.notes.dates) bump(report.junkDates, d.field);
  };

  for (const p of pos) {
    const pepUid = Number(p.uid);
    const choice = choices.get(pepUid);
    if (!choice) { report.skipped.push(`${String(p.channel)} / ${String(p.poNumber)}`); continue; }
    const mp = mapPo(p, choice.channel, masters);
    noteUnmatched(mp);
    const pepLines = linesOf.get(pepUid) ?? [];
    const link = links.get(pepUid);
    const fieldsWithLinks = (set: Row, f: string) => {
      const lf = LINK_OF[f];
      if (lf) set[lf] = mp.links[lf as keyof MappedPo['links']];
    };

    if (link) {
      // linked: take what PEPIMS changed since the last sync (ours changed it too and later = ours stays)
      const ours = oursByUid.get(link.poUid);
      if (!ours) continue; // our row is gone (never deleted by us): nothing to compare with
      const cur = canonOurs(ours, PEPIMS_PO_FIELDS);
      const base = link.syncedValues ?? cur;
      const set: Row = {};
      const pepNewer = textOf(p.updatedAt) >= toDbText(ours.updatedAt);
      for (const f of Object.keys(PEPIMS_PO_FIELDS)) {
        const pep = mp.fields[f];
        const b = f in base ? (base[f] as string | null) : cur[f];
        if (pep === b || pep === cur[f]) continue;
        if (cur[f] !== b && !pepNewer) { report.conflictsKeptOurs.push({ uid: link.poUid, field: f, pepims: pep, ours: cur[f] }); continue; }
        set[f] = toValues({ [f]: pep }, PEPIMS_PO_FIELDS)[f];
        fieldsWithLinks(set, f);
        history(link.poUid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `sync from PEPIMS${cur[f] !== b ? ' (newer than ours)' : ''}`, { fieldName: f, oldValue: cur[f], newValue: pep });
        report.fieldChanges++;
      }
      if (Object.keys(set).length) { plan.poUpdates.push({ uid: link.poUid, set: { ...set, updatedAt: now } }); report.updated++; } else report.unchanged++;
      plan.links.push({ poUid: link.poUid, pepimsUid: pepUid, syncedValues: mp.fields, pepimsUpdatedAt: (p.updatedAt as string | null) ?? null });
      await planLinkedLines(plan, report, link.poUid, pepLines, lineLinks, takenLineIds, String(p.poNumber), now, history);
      pepimsLogsFor(link.poUid, pepUid);
      continue;
    }

    const existing = byKey.get(`${choice.channel.toLowerCase()}|${String(p.poNumber)}`);
    if (existing) {
      // ours already (same channel + PO number): link it, PEPIMS values win (user)
      const uid = String(existing.uid);
      const cur = canonOurs(existing, PEPIMS_PO_FIELDS);
      const set: Row = {};
      for (const f of Object.keys(PEPIMS_PO_FIELDS)) {
        if (mp.fields[f] === cur[f]) continue;
        set[f] = toValues({ [f]: mp.fields[f] }, PEPIMS_PO_FIELDS)[f];
        fieldsWithLinks(set, f);
        history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `from PEPIMS (linked to PEPIMS uid ${pepUid})`, { fieldName: f, oldValue: cur[f], newValue: mp.fields[f] });
        report.fieldChanges++;
      }
      plan.poUpdates.push({ uid, set: { ...set, updatedAt: now } });
      plan.links.push({ poUid: uid, pepimsUid: pepUid, syncedValues: mp.fields, pepimsUpdatedAt: (p.updatedAt as string | null) ?? null });
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `linked to PEPIMS uid ${pepUid}`);
      report.linked++;
      await planMatchedLines(plan, report, uid, pepLines, takenLineIds, String(p.poNumber), now, history);
      pepimsLogsFor(uid, pepUid);
      continue;
    }

    // new: insert with the PEPIMS uid (another one only when that is taken)
    const row: Row = {
      ...toValues(mp.fields, PEPIMS_PO_FIELDS), ...mp.links, channel: choice.channel, poNumber: String(p.poNumber), poGroup: choice.poGroup,
      partyName: choice.partyName, importedFrom: PO_IMPORTED_FROM.PEPIMS, createdAt: p.createdAt ?? now, updatedAt: p.updatedAt ?? now,
    };
    const remark = [`imported from PEPIMS (uid ${pepUid})`, choice.note, ...mp.notes.dates.map((d) => `${d.field} "${d.value}" in PEPIMS: left empty`)].filter(Boolean).join('; ');
    bump(report.byGroup, choice.poGroup);
    bump(report.byChannel, choice.channel);
    if (choice.note) bump(report.channelNotes, choice.note);
    report.inserted++;
    const lineRows = pepLines.map((l) => ({ pepimsLineId: Number(l.id), synced: mapLine(l), row: { ...toValues(mapLine(l), PEPIMS_LINE_FIELDS), createdAt: l.createdAt ?? now, updatedAt: l.updatedAt ?? now } }));
    if (takenUids.has(String(pepUid))) {
      report.newUid++;
      plan.movedPos.push({ row, pepimsUid: pepUid, lines: lineRows, synced: mp.fields, pepimsUpdatedAt: (p.updatedAt as string | null) ?? null, historyRemark: remark });
      report.linesInserted += lineRows.length;
      continue;
    }
    const uid = String(pepUid);
    plan.poInserts.push({ uid, ...row });
    plan.links.push({ poUid: uid, pepimsUid: pepUid, syncedValues: mp.fields, pepimsUpdatedAt: (p.updatedAt as string | null) ?? null });
    history(uid, SHIPMENT_LOG_ACTION.CREATED, remark);
    for (const l of lineRows) {
      const free = !takenLineIds.has(String(l.pepimsLineId));
      const insertRow = { ...l.row, ...(free ? { id: String(l.pepimsLineId) } : {}), shipmentOrderId: uid };
      plan.lineLinks.push({ lineId: free ? String(l.pepimsLineId) : null, pepimsLineId: l.pepimsLineId, poUid: uid, syncedValues: l.synced, insertRow });
      report.linesInserted++;
    }
    pepimsLogsFor(uid, pepUid);
  }
  return plan;
};

const toDbText = (v: unknown): string => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : textOf(v));

type HistoryFn = (uid: string, action: string, remark: string, extra?: Row) => void;

/** Lines of a linked PO: 3-way per field, new PEPIMS lines added. */
const planLinkedLines = async (
  plan: Plan, report: SyncReport, uid: string, pepLines: Row[], lineLinks: Map<number, PepimsSyncLineLink>, takenLineIds: Set<string>, poNumber: string, now: Date, history: HistoryFn,
) => {
  const linkedIds = pepLines.map((l) => lineLinks.get(Number(l.id))?.lineId).filter((x): x is string => !!x);
  const ours = new Map((linkedIds.length ? await AppDataSource.query<Row[]>(
    `SELECT id, ${Object.keys(PEPIMS_LINE_FIELDS).map((f) => `\`${f}\``).join(', ')} FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE id IN (?)`, [linkedIds]) : []).map((r) => [String(r.id), r]));
  for (const l of pepLines) {
    const pep = mapLine(l);
    const ll = lineLinks.get(Number(l.id));
    if (!ll) {
      const free = !takenLineIds.has(String(l.id));
      plan.lineLinks.push({ lineId: free ? String(l.id) : null, pepimsLineId: Number(l.id), poUid: uid, syncedValues: pep,
        insertRow: { ...toValues(pep, PEPIMS_LINE_FIELDS), ...(free ? { id: String(l.id) } : {}), shipmentOrderId: uid, poNumber, createdAt: now, updatedAt: now } });
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `line added in PEPIMS: ${pep.skuCode ?? ''} x ${pep.qty ?? ''}`);
      report.linesInserted++;
      continue;
    }
    const row = ours.get(ll.lineId);
    if (!row) continue;
    const cur = canonOurs(row, PEPIMS_LINE_FIELDS);
    const base = ll.syncedValues ?? cur;
    const set: Row = {};
    for (const f of Object.keys(PEPIMS_LINE_FIELDS)) {
      const b = f in base ? (base[f] as string | null) : cur[f];
      if (pep[f] === b || pep[f] === cur[f]) continue;
      if (cur[f] !== b) continue; // ours changed it too: ours stays (lines carry no time of their own)
      set[f] = toValues({ [f]: pep[f] }, PEPIMS_LINE_FIELDS)[f];
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `sync from PEPIMS (line ${pep.skuCode ?? ll.lineId})`, { fieldName: f, lineId: ll.lineId, oldValue: cur[f], newValue: pep[f] });
    }
    if (Object.keys(set).length) { plan.lineUpdates.push({ id: ll.lineId, set: { ...set, updatedAt: now } }); report.linesUpdated++; }
    plan.lineLinks.push({ lineId: ll.lineId, pepimsLineId: Number(l.id), poUid: uid, syncedValues: pep });
  }
};

/** Lines of a PO linked now by channel + PO number: matched by SKU (in order), PEPIMS values win; extra PEPIMS lines added. */
const planMatchedLines = async (plan: Plan, report: SyncReport, uid: string, pepLines: Row[], takenLineIds: Set<string>, poNumber: string, now: Date, history: HistoryFn) => {
  const ours = await AppDataSource.query<Row[]>(
    `SELECT id, ${Object.keys(PEPIMS_LINE_FIELDS).map((f) => `\`${f}\``).join(', ')} FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId = ? ORDER BY id`, [uid]);
  const free = [...ours];
  for (const l of pepLines) {
    const pep = mapLine(l);
    const at = free.findIndex((o) => textOf(o.skuCode).toLowerCase() === (pep.skuCode ?? '').toLowerCase());
    if (at < 0) {
      const idFree = !takenLineIds.has(String(l.id));
      plan.lineLinks.push({ lineId: idFree ? String(l.id) : null, pepimsLineId: Number(l.id), poUid: uid, syncedValues: pep,
        insertRow: { ...toValues(pep, PEPIMS_LINE_FIELDS), ...(idFree ? { id: String(l.id) } : {}), shipmentOrderId: uid, poNumber, createdAt: now, updatedAt: now } });
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `line only in PEPIMS added: ${pep.skuCode ?? ''} x ${pep.qty ?? ''}`);
      report.linesInserted++;
      continue;
    }
    const [o] = free.splice(at, 1);
    const cur = canonOurs(o, PEPIMS_LINE_FIELDS);
    const set: Row = {};
    for (const f of Object.keys(PEPIMS_LINE_FIELDS)) {
      if (pep[f] === cur[f]) continue;
      set[f] = toValues({ [f]: pep[f] }, PEPIMS_LINE_FIELDS)[f];
      history(uid, SHIPMENT_LOG_ACTION.FIELD_CHANGED, `from PEPIMS (line ${pep.skuCode ?? o.id as string})`, { fieldName: f, lineId: String(o.id), oldValue: cur[f], newValue: pep[f] });
    }
    if (Object.keys(set).length) { plan.lineUpdates.push({ id: String(o.id), set: { ...set, updatedAt: now } }); report.linesUpdated++; }
    plan.lineLinks.push({ lineId: String(o.id), pepimsLineId: Number(l.id), poUid: uid, syncedValues: pep });
    report.linesLinked++;
  }
  report.oursWithoutPepimsLine += free.length;
};

const applyPlan = async (m: EntityManager, plan: Plan, report: SyncReport) => {
  const pos = m.getRepository(MasterPurchaseOrder);
  const details = m.getRepository(DetailsPurchaseOrder);
  const linkRepo = m.getRepository(PepimsSyncLink);
  const lineLinkRepo = m.getRepository(PepimsSyncLineLink);
  for (const part of chunk(plan.poInserts, 200)) await pos.insert(part);
  for (const mp of plan.movedPos) {
    const res = await pos.insert(mp.row);
    const uid = String(res.identifiers[0].uid);
    plan.links.push({ poUid: uid, pepimsUid: mp.pepimsUid, syncedValues: mp.synced, pepimsUpdatedAt: mp.pepimsUpdatedAt });
    plan.history.push({ shipmentUid: uid, userId: null, action: SHIPMENT_LOG_ACTION.CREATED, source: SHIPMENT_LOG_SOURCE.SCRIPT, remark: `${mp.historyRemark}; PEPIMS uid taken here: saved as ${uid}` });
    for (const l of mp.lines) plan.lineLinks.push({ lineId: null, pepimsLineId: l.pepimsLineId, poUid: uid, syncedValues: l.synced, insertRow: { ...l.row, shipmentOrderId: uid } });
  }
  // lines: with their PEPIMS id in bulk, the rest one by one (their new id goes into the link)
  const withId = plan.lineLinks.filter((l) => l.insertRow && l.lineId);
  for (const part of chunk(withId, 500)) await details.insert(part.map((l) => l.insertRow!));
  for (const l of plan.lineLinks.filter((x) => x.insertRow && !x.lineId)) {
    const res = await details.insert(l.insertRow as QueryDeepPartialEntity<DetailsPurchaseOrder>);
    l.lineId = String(res.identifiers[0].id);
  }
  for (const u of plan.poUpdates) if (Object.keys(u.set).length > 1) await pos.update({ uid: u.uid }, u.set);
  for (const u of plan.lineUpdates) await details.update({ id: u.id }, u.set);
  for (const part of chunk(plan.links, 500)) {
    await linkRepo.upsert(part.map((l) => ({ poUid: l.poUid, pepimsUid: l.pepimsUid, syncedValues: l.syncedValues, pepimsUpdatedAt: l.pepimsUpdatedAt ? new Date(`${l.pepimsUpdatedAt.replace(' ', 'T')}Z`) : null, syncedAt: new Date() })) as QueryDeepPartialEntity<PepimsSyncLink>[], ['pepimsUid']);
  }
  for (const part of chunk(plan.lineLinks, 500)) {
    await lineLinkRepo.upsert(part.map((l) => ({ lineId: l.lineId!, pepimsLineId: l.pepimsLineId, poUid: l.poUid, syncedValues: l.syncedValues, syncedAt: new Date() })) as QueryDeepPartialEntity<PepimsSyncLineLink>[], ['pepimsLineId']);
  }
  for (const part of chunk(plan.history, 500)) await m.getRepository(ShipmentLog).insert(part);
  void report;
};
