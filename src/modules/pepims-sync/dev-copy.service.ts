import { QueryRunner } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { DEV_COPY, PO_IMPORTED_FROM, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES } from '../../constants';
import { textOf } from './mapping';

/*
 * Dev -> prod copy (2026-11-16, step 2b of the PEPIMS + dev -> prod migration; user: "the team processes in dev: move
 * everything"). Runs on the TARGET connection (the app's database = prod) and READS the dev database on the same server
 * (DEV_COPY.SOURCE_DB). Never deletes, never changes dev. One transaction for everything; a dry run = the same work,
 * rolled back at the end (exact counts, nothing kept).
 *   1. users of dev missing in prod (by email) + their roles / warehouses / page overrides; every user id re-pointed.
 *   2. masters edited on dev (channels, SKUs, channel SKUs, locations, warehouses, combos, margin requests, change log):
 *      upserted by id (prod's masters are a copy of dev's with the same ids; nothing deleted).
 *   (2026-11-17, user: "run it every night until I say; ONE WAY, dev -> prod, never prod -> dev") a re-run also brings
 *   what CHANGED on dev since: dev's own rows are upserted (an upload approved on dev = approved on prod), a dev-only PO
 *   takes dev's values again; a PO PEPIMS also has keeps PEPIMS's values (the PEPIMS sync owns them; dev's edits arrive
 *   as History rows).
 *   3. POs: dev PO = the prod PO with the same channel + PO number (imported from PEPIMS: PEPIMS wins, dev's Uniware
 *      status fills an empty one, a different sale order code is written to History); a dev-only PO is inserted (new
 *      uid) with its lines. D2C transfers stay on dev. Lines re-pointed by SKU (in order).
 *   4. the PO work done on dev, ids kept (prod's tables are empty there): uploads, issues + actions, approvals,
 *      verifications, price differences, re-opens, manual uploads, pulls, Uniware creates, Bulk Orders, feedback,
 *      notices, verify switches; History rows (new ids, only those not copied yet); Gmail / intake lists merged by their
 *      own keys; sale order counter = the higher of dev / prod per day (prod never repeats dev's codes).
 */

type Row = Record<string, unknown>;
export interface DevCopyReport {
  apply: boolean;
  source: string;
  target: string;
  /** table -> rows copied (or updated, for masters / counters). */
  tables: Record<string, number>;
  usersAdded: string[];
  posLinked: number;
  posAdded: number;
  posSkippedTransfers: number;
  /** dev-only POs copied earlier whose values changed on dev since. */
  posUpdated: number;
  linesAdded: number;
  saleCodeNotes: number;
  uniwareStatusFilled: number;
  /** table -> dev rows NOT written because prod has its own row with that key (another created time). */
  prodOwnKept: Record<string, number>;
}

/** One value as text, for "did it change" (dates, JSON, numbers read the same way from both databases). */
const same = (v: unknown): string => {
  if (v === null || v === undefined) return '\u0000';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (typeof v === 'object') return JSON.stringify(v);
  return textOf(v);
};
const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Columns both databases have for a table, which are JSON, and the primary key. */
const shape = async (qr: QueryRunner, src: string, table: string) => {
  const cols = (await qr.query(
    `SELECT t.COLUMN_NAME c, t.DATA_TYPE d, t.COLUMN_KEY k FROM information_schema.COLUMNS t JOIN information_schema.COLUMNS s ON s.TABLE_SCHEMA = ? AND s.TABLE_NAME = t.TABLE_NAME AND s.COLUMN_NAME = t.COLUMN_NAME
      WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = ? ORDER BY t.ORDINAL_POSITION`, [src, table])) as { c: string; d: string; k: string }[];
  return { cols: cols.map((x) => x.c), json: new Set(cols.filter((x) => x.d === 'json').map((x) => x.c)), pk: cols.filter((x) => x.k === 'PRI').map((x) => x.c) };
};

const insertRows = async (qr: QueryRunner, table: string, cols: string[], json: Set<string>, rows: Row[], upsert = false) => {
  for (const part of chunk(rows, 300)) {
    const values = part.map((r) => cols.map((c) => (json.has(c) && r[c] !== null && r[c] !== undefined && typeof r[c] !== 'string' ? JSON.stringify(r[c]) : r[c] ?? null)));
    const update = upsert ? ` ON DUPLICATE KEY UPDATE ${cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}` : '';
    await qr.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?${update}`, [values]);
  }
};

export const runDevCopy = async (o: { apply: boolean; log?: (s: string) => void }): Promise<DevCopyReport> => {
  const say = o.log ?? (() => undefined);
  const src = env.pepimsSync.devCopySourceDb;
  const report: DevCopyReport = {
    apply: o.apply, source: src, target: String(AppDataSource.options.database), tables: {}, usersAdded: [], posLinked: 0, posAdded: 0, posUpdated: 0,
    posSkippedTransfers: 0, linesAdded: 0, saleCodeNotes: 0, uniwareStatusFilled: 0, prodOwnKept: {},
  };
  if (report.target === src) throw new Error(`source and target are the same database (${src})`);
  const qr = AppDataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    const q = async <T = Row[]>(sql: string, p: unknown[] = []): Promise<T> => (await qr.query(sql, p)) as T;
    const fromDev = (table: string, where = '1 = 1') => q<Row[]>(`SELECT * FROM \`${src}\`.\`${table}\` WHERE ${where}`);
    const count = (t: string, n: number) => { report.tables[t] = (report.tables[t] ?? 0) + n; };

    // ---- 1. users ----
    const devUsers = await fromDev(TABLES.USERS);
    const prodUsers = await q<{ id: number; email: string }[]>(`SELECT id, email FROM ${TABLES.USERS}`);
    const userMap = new Map<number, number>();
    const addedDev = new Set<number>();
    const byEmail = new Map(prodUsers.map((u) => [u.email.toLowerCase(), Number(u.id)]));
    const us = await shape(qr, src, TABLES.USERS);
    for (const u of devUsers) {
      const hit = byEmail.get(String(u.email).toLowerCase());
      if (hit) { userMap.set(Number(u.id), hit); continue; }
      const cols = us.cols.filter((c) => c !== 'id' && c !== 'added_by');
      const res = (await qr.query(`INSERT INTO ${TABLES.USERS} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`, [cols.map((c) => u[c] ?? null)])) as { insertId: number };
      userMap.set(Number(u.id), Number(res.insertId));
      addedDev.add(Number(u.id));
      report.usersAdded.push(String(u.email));
    }
    const user = (v: unknown) => (v === null || v === undefined ? null : userMap.get(Number(v)) ?? null);

    // the last run (dev clock = prod clock: same server, UTC): a table with a reliable "changed at" column is read only
    // from then on (DEV_COPY.SINCE_COLUMN, with DEV_COPY.OVERLAP_MINUTES so nothing at the edge is missed); the first run
    // of this version reads everything
    const state = await q<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [DEV_COPY.STATE_KEY]);
    const prev = (state[0]?.value ?? {}) as { shipmentLogId?: number; dbAt?: string };
    const [clock] = await q<{ now: string; since: string | null }[]>(
      `SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') now, DATE_FORMAT(? - INTERVAL ${DEV_COPY.OVERLAP_MINUTES} MINUTE, '%Y-%m-%d %H:%i:%s') since`, [prev.dbAt ?? null]);
    const since = clock.since;

    // generic: dev rows written to prod only when missing there, or (upsert) when a value differs; users / POs / lines
    // re-pointed first. Prod's rows are read only for the keys read from dev (never a whole prod table).
    const poMap = new Map<string, string>();
    const lineMap = new Map<string, string>();
    const po = (v: unknown) => (v === null || v === undefined ? null : poMap.get(textOf(v)) ?? null);
    const copy = async (table: string, cfg: { users?: string[]; po?: string[]; line?: string[]; key?: string[]; dropId?: boolean; where?: string; upsert?: boolean; skip?: (r: Row) => boolean; noExistCheck?: boolean } = {}) => {
      const s = await shape(qr, src, table);
      const key = cfg.key ?? s.pk;
      const sinceCol = DEV_COPY.SINCE_COLUMN[table];
      const where = [cfg.where, since && sinceCol ? `\`${sinceCol}\` >= '${since}'` : null].filter(Boolean).join(' AND ') || '1 = 1';
      const rows = await fromDev(table, where);
      const mapped = rows.filter((r) => !(cfg.skip?.(r))).map((r) => {
        const m: Row = { ...r };
        for (const c of cfg.users ?? []) if (c in m) m[c] = user(m[c]);
        for (const c of cfg.po ?? []) if (c in m) m[c] = po(m[c]);
        for (const c of cfg.line ?? []) if (c in m) m[c] = m[c] === null ? null : lineMap.get(textOf(m[c])) ?? null;
        return m;
      });
      const cols = cfg.dropId ? s.cols.filter((c) => c !== 'id') : s.cols;
      const keyOf = (r: Row) => key.map((k) => textOf(r[k])).join('|');
      const there = new Map<string, Row>();
      if (!cfg.noExistCheck) {
        const sel = (cfg.upsert ? [...new Set([...key, ...cols])] : key).map((c) => `\`${c}\``).join(', ');
        for (const part of chunk(mapped, DEV_COPY.KEY_BATCH)) {
          const found = key.length === 1
            ? await q<Row[]>(`SELECT ${sel} FROM \`${table}\` WHERE \`${key[0]}\` IN (?)`, [part.map((r) => r[key[0]])])
            : await q<Row[]>(`SELECT ${sel} FROM \`${table}\` WHERE (${key.map((k) => `\`${k}\``).join(', ')}) IN (?)`, [part.map((r) => key.map((k) => r[k]))]);
          for (const f of found) there.set(keyOf(f), f);
        }
      }
      // a prod row with the same key but another created time is prod's OWN row (made on prod): never overwritten, reported
      const born = cols.find((c) => c === 'created_at' || c === 'createdAt');
      const write = mapped.filter((m) => {
        const p = there.get(keyOf(m));
        if (!p) return true;
        if (!cfg.upsert || cols.every((c) => same(p[c]) === same(m[c]))) return false;
        if (born && same(p[born]) !== same(m[born])) { report.prodOwnKept[table] = (report.prodOwnKept[table] ?? 0) + 1; return false; }
        return true;
      });
      if (write.length) await insertRows(qr, table, cols, s.json, write, cfg.upsert);
      count(table, write.length);
    };

    await copy(TABLES.USER_ROLES, { users: ['user_id'], key: ['user_id', 'role'], skip: (r) => !addedDev.has(Number(r.user_id)), dropId: true });
    await copy(TABLES.USER_FACILITIES, { users: ['user_id'], key: ['user_id', 'facility_id'], skip: (r) => !addedDev.has(Number(r.user_id)), dropId: true });
    await copy(TABLES.USER_PAGE_PERMISSIONS, { users: ['user_id'], key: ['user_id', 'page_slug'], skip: (r) => !addedDev.has(Number(r.user_id)), dropId: true });
    say(`[dev-copy] users: ${report.usersAdded.length} added, ${userMap.size} mapped`);

    // ---- 2. masters (upsert by id) ----
    for (const t of DEV_COPY.MASTER_TABLES) await copy(t, { upsert: true });
    await copy(TABLES.MARGIN_CHANGE_REQUESTS, { users: ['requested_by', 'l1_by', 'l2_by', 'rejected_by'], upsert: true });
    await copy(TABLES.MASTER_CHANGE_LOGS, { users: ['user_id'] });
    say('[dev-copy] masters done');

    // ---- 3. POs ----
    // every dev PO by a few columns only (to match it); full rows + lines only for POs that need them
    const devPos = await q<Row[]>(`SELECT uid, channel, poNumber, transferCode, orderNo1, uniwareStatus, uniwareDoneAt, lastSyncedAt FROM \`${src}\`.${TABLES.MASTER_PURCHASE_ORDERS}`);
    const prodKeys = new Map((await q<{ uid: string; channel: string; poNumber: string; orderNo1: string | null; uniwareStatus: string | null; importedFrom: string | null }[]>(
      `SELECT uid, channel, poNumber, orderNo1, uniwareStatus, importedFrom FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE transferCode IS NULL`))
      .map((p) => [`${p.channel.toLowerCase()}|${p.poNumber}`, p]));
    const pos = await shape(qr, src, TABLES.MASTER_PURCHASE_ORDERS);
    const lines = await shape(qr, src, TABLES.DETAILS_PURCHASE_ORDERS);
    const poCols = pos.cols.filter((c) => c !== 'uid');
    const poValue = (d: Row, c: string) => (pos.json.has(c) && d[c] !== null && typeof d[c] !== 'string' ? JSON.stringify(d[c]) : d[c] ?? null);
    const fullRows = async (db: string, table: string, col: string, ids: string[]) => {
      const out: Row[] = [];
      for (const part of chunk(ids, DEV_COPY.KEY_BATCH)) out.push(...await q<Row[]>(`SELECT * FROM \`${db}\`.\`${table}\` WHERE \`${col}\` IN (?) ORDER BY 1`, [part]));
      return out;
    };
    const target = report.target;
    const notes: Row[] = [];
    const devOnlyKnown: [string, string][] = [];
    const devOnlyNew: string[] = [];
    const fill: Row[] = [];
    for (const d of devPos) {
      if (d.transferCode !== null) { report.posSkippedTransfers++; continue; }
      const hit = prodKeys.get(`${String(d.channel).toLowerCase()}|${String(d.poNumber)}`);
      if (!hit) { devOnlyNew.push(String(d.uid)); continue; }
      poMap.set(String(d.uid), String(hit.uid));
      report.posLinked++;
      if (hit.importedFrom !== PO_IMPORTED_FROM.PEPIMS) devOnlyKnown.push([String(d.uid), String(hit.uid)]);
      if (!hit.uniwareStatus && d.uniwareStatus) fill.push({ uid: hit.uid, s: d.uniwareStatus, done: d.uniwareDoneAt ?? null, synced: d.lastSyncedAt ?? null });
      if (d.orderNo1 && hit.orderNo1 && d.orderNo1 !== hit.orderNo1) {
        notes.push({ shipment_uid: hit.uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: SHIPMENT_LOG_SOURCE.SCRIPT,
          remark: `${DEV_COPY.SALE_CODE_NOTE} ${textOf(d.orderNo1)}; the code used is PEPIMS's ${hit.orderNo1}${d.uniwareStatus === DEV_COPY.MARKED_NOT_IN_UNIWARE ? ' (dev marked it uploaded, but it was never in Uniware)' : ''}` });
        report.saleCodeNotes++;
      }
    }
    // dev's Uniware status where prod has none
    for (const f of fill) {
      await qr.query(`UPDATE ${TABLES.MASTER_PURCHASE_ORDERS} SET uniwareStatus = ?, uniwareDoneAt = ?, lastSyncedAt = ? WHERE uid = ?`, [f.s, f.done, f.synced, f.uid]);
      report.uniwareStatusFilled++;
    }
    // a dev-only PO copied earlier: dev's values again, only when one differs
    if (devOnlyKnown.length) {
      const devFull = new Map((await fullRows(src, TABLES.MASTER_PURCHASE_ORDERS, 'uid', devOnlyKnown.map(([d]) => d))).map((r) => [textOf(r.uid), r]));
      const prodFull = new Map((await fullRows(target, TABLES.MASTER_PURCHASE_ORDERS, 'uid', devOnlyKnown.map(([, p]) => p))).map((r) => [textOf(r.uid), r]));
      for (const [d, p] of devOnlyKnown) {
        const dr = devFull.get(d);
        const pr = prodFull.get(p);
        if (!dr || !pr || poCols.every((c) => same(dr[c]) === same(pr[c]))) continue;
        await qr.query(`UPDATE ${TABLES.MASTER_PURCHASE_ORDERS} SET ${poCols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE uid = ?`, [...poCols.map((c) => poValue(dr, c)), p]);
        report.posUpdated++;
      }
    }
    // only on dev: a new PO in prod (new uid) with its lines
    if (devOnlyNew.length) {
      const devFull = await fullRows(src, TABLES.MASTER_PURCHASE_ORDERS, 'uid', devOnlyNew);
      const devLines = await fullRows(src, TABLES.DETAILS_PURCHASE_ORDERS, 'shipmentOrderId', devOnlyNew);
      const lcols = lines.cols.filter((c) => c !== 'id');
      for (const d of devFull) {
        const res = (await qr.query(`INSERT INTO ${TABLES.MASTER_PURCHASE_ORDERS} (${poCols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`, [poCols.map((c) => poValue(d, c))])) as { insertId: number };
        const uid = String(res.insertId);
        poMap.set(String(d.uid), uid);
        report.posAdded++;
        for (const l of devLines.filter((x) => textOf(x.shipmentOrderId) === textOf(d.uid))) {
          const r = (await qr.query(`INSERT INTO ${TABLES.DETAILS_PURCHASE_ORDERS} (${lcols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`,
            [lcols.map((c) => (c === 'shipmentOrderId' ? uid : l[c] ?? null))])) as { insertId: number };
          lineMap.set(String(l.id), String(r.insertId));
          report.linesAdded++;
        }
      }
    }
    say(`[dev-copy] POs: ${report.posLinked} linked to PEPIMS's, ${report.posAdded} added, ${report.posUpdated} dev-only updated, ${report.posSkippedTransfers} D2C transfers left on dev`);

    // ---- 4. the PO work done on dev ----
    const lastLog = Number(prev.shipmentLogId ?? 0);
    const [maxLog] = await q<{ m: number | null }[]>(`SELECT MAX(id) m FROM \`${src}\`.${TABLES.SHIPMENT_LOGS}`);
    // line ids of the new History rows: dev line -> the prod line with the same SKU (n-th with the n-th), only for those POs
    const logPos = (await q<{ u: string }[]>(`SELECT DISTINCT shipment_uid u FROM \`${src}\`.${TABLES.SHIPMENT_LOGS} WHERE id > ? AND line_id IS NOT NULL`, [lastLog]))
      .map((r) => textOf(r.u)).filter((u) => poMap.has(u));
    if (logPos.length) {
      const dLines = await fullRows(src, TABLES.DETAILS_PURCHASE_ORDERS, 'shipmentOrderId', logPos);
      const pLines = await fullRows(target, TABLES.DETAILS_PURCHASE_ORDERS, 'shipmentOrderId', logPos.map((u) => poMap.get(u)!));
      for (const u of logPos) {
        const free = pLines.filter((l) => textOf(l.shipmentOrderId) === poMap.get(u));
        for (const l of dLines.filter((x) => textOf(x.shipmentOrderId) === u)) {
          if (lineMap.has(String(l.id))) continue;
          const at = free.findIndex((p) => textOf(p.skuCode).toLowerCase() === textOf(l.skuCode).toLowerCase());
          if (at >= 0) lineMap.set(String(l.id), String(free.splice(at, 1)[0].id));
        }
      }
    }
    await copy(TABLES.SHIPMENT_LOGS, {
      users: ['user_id'], po: ['shipment_uid'], line: ['line_id'], dropId: true, where: `id > ${lastLog}`, key: ['id'], noExistCheck: true,
      skip: (r) => !poMap.has(String(r.shipment_uid)),
    });
    // a re-run never writes the same note twice
    const noted = new Set((await q<{ k: string }[]>(`SELECT CONCAT(shipment_uid, '|', remark) k FROM ${TABLES.SHIPMENT_LOGS} WHERE remark LIKE ?`, [`${DEV_COPY.SALE_CODE_NOTE}%`])).map((r) => r.k));
    const newNotes = notes.filter((n) => !noted.has(`${textOf(n.shipment_uid)}|${textOf(n.remark)}`));
    if (newNotes.length) await insertRows(qr, TABLES.SHIPMENT_LOGS, ['shipment_uid', 'action', 'source', 'remark'], new Set(), newNotes);
    count(`${TABLES.SHIPMENT_LOGS} (sale code notes)`, newNotes.length);
    await copy(TABLES.PO_UPLOADS, { users: ['csv_downloaded_by', 'uniware_uploaded_by', 'uploaded_by'], po: ['po_uid'], upsert: true });
    await copy(TABLES.PO_ISSUES, { users: ['resolved_by'], upsert: true });
    await copy(TABLES.PO_ISSUE_ACTIONS, { users: ['action_by'], upsert: true });
    await copy(TABLES.PO_REVIEW_SUBMISSIONS, { users: ['submitted_by', 'decided_by'], po: ['po_uid'], upsert: true });
    await copy(TABLES.PO_VERIFICATIONS, { users: ['done_by'], po: ['po_uid'], upsert: true });
    await copy(TABLES.PO_PRICE_DIFFERENCES, { users: ['approved_by', 'reviewed_by', 'sent_by'], po: ['po_uid'], upsert: true });
    await copy(TABLES.PO_REOPENS, { users: ['rejected_by', 'reopened_by'], upsert: true });
    await copy(TABLES.MANUAL_UPLOADS, { users: ['uploaded_by', 'process_by'], upsert: true });
    await copy(TABLES.CHANNEL_PULL_ITEMS, { key: ['source_system', 'external_id'], dropId: true });
    await copy(TABLES.UNIWARE_CREATES, { users: ['requested_by'], po: ['po_uid'], upsert: true });
    // prod's own email intake / robot / switches keep their state: dev's rows only when prod has none (never updated)
    await copy(TABLES.GMAIL_MESSAGES, { key: ['gmail_id'] });
    await copy(TABLES.INTAKE_EMAILS, { key: ['message_key'], dropId: true });
    await copy(TABLES.PO_VERIFY_CHANNEL_SETTINGS, { users: ['updated_by'], key: ['channel'], dropId: true });
    for (const t of DEV_COPY.BULK_TABLES) {
      await copy(t, { users: ['created_by', 'decided_by', 'needed_by', 'ordered_by', 'payment_by', 'processed_by', 'uploaded_by', 'by_user_id', 'updated_by', 'hidden_by'], po: ['po_uid'], upsert: true });
    }
    for (const t of DEV_COPY.FEEDBACK_TABLES) {
      await copy(t, { users: ['updated_by', 'assigned_to', 'reporter_id', 'user_id', 'added_by', 'uploaded_by', 'removed_by', 'actor_id', 'from_user_id', 'to_user_id'], upsert: true });
    }
    // sale order counter: the higher serial per day, so prod never gives a code dev already gave
    // (only the days where dev is ahead: one grouped write, nothing on a quiet night)
    const ahead = await q<Row[]>(`SELECT d.counter_date, d.last_serial FROM \`${src}\`.${TABLES.SALE_ORDER_CODE_COUNTER} d
      LEFT JOIN ${TABLES.SALE_ORDER_CODE_COUNTER} p ON p.counter_date = d.counter_date WHERE p.counter_date IS NULL OR p.last_serial < d.last_serial`);
    if (ahead.length) {
      await qr.query(`INSERT INTO ${TABLES.SALE_ORDER_CODE_COUNTER} (counter_date, last_serial) VALUES ? ON DUPLICATE KEY UPDATE last_serial = GREATEST(last_serial, VALUES(last_serial))`,
        [ahead.map((c) => [c.counter_date, c.last_serial])]);
    }
    count(TABLES.SALE_ORDER_CODE_COUNTER, ahead.length);
    await qr.query(`INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [DEV_COPY.STATE_KEY, JSON.stringify({ shipmentLogId: Number(maxLog.m ?? 0), at: new Date().toISOString(), dbAt: clock.now })]);

    if (o.apply) await qr.commitTransaction();
    else await qr.rollbackTransaction();
  } catch (e) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw e;
  } finally {
    await qr.release();
  }
  return report;
};
