import { QueryRunner } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { DEV_COPY, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES } from '../../constants';
import { textOf } from './mapping';

/*
 * Dev -> prod copy (2026-11-16, step 2b of the PEPIMS + dev -> prod migration; user: "the team processes in dev: move
 * everything"). Runs on the TARGET connection (the app's database = prod) and READS the dev database on the same server
 * (DEV_COPY.SOURCE_DB). Never deletes, never changes dev. One transaction for everything; a dry run = the same work,
 * rolled back at the end (exact counts, nothing kept).
 *   1. users of dev missing in prod (by email) + their roles / warehouses / page overrides; every user id re-pointed.
 *   2. masters edited on dev (channels, SKUs, channel SKUs, locations, warehouses, combos, margin requests, change log):
 *      upserted by id (prod's masters are a copy of dev's with the same ids; nothing deleted).
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
  linesAdded: number;
  saleCodeNotes: number;
  uniwareStatusFilled: number;
}

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
    apply: o.apply, source: src, target: String(AppDataSource.options.database), tables: {}, usersAdded: [], posLinked: 0, posAdded: 0,
    posSkippedTransfers: 0, linesAdded: 0, saleCodeNotes: 0, uniwareStatusFilled: 0,
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

    // generic: rows of dev not in prod yet (by primary key or a unique key), users / POs / lines re-pointed
    const poMap = new Map<string, string>();
    const lineMap = new Map<string, string>();
    const po = (v: unknown) => (v === null || v === undefined ? null : poMap.get(textOf(v)) ?? null);
    const copy = async (table: string, cfg: { users?: string[]; po?: string[]; line?: string[]; key?: string[]; dropId?: boolean; where?: string; upsert?: boolean; skip?: (r: Row) => boolean; noExistCheck?: boolean } = {}) => {
      const s = await shape(qr, src, table);
      const key = cfg.key ?? s.pk;
      const rows = await fromDev(table, cfg.where);
      // rows with new ids (History) are not compared by id: the caller's `where` (a watermark) decides
      const existing = cfg.noExistCheck ? new Set<string>() : new Set((await q<Row[]>(`SELECT ${key.map((k) => `\`${k}\``).join(', ')} FROM \`${table}\``)).map((r) => key.map((k) => textOf(r[k])).join('|')));
      // users / POs / lines re-pointed FIRST, so "already in prod" is checked on prod's values (a key can hold a user id)
      const mapped = rows.filter((r) => !(cfg.skip?.(r))).map((r) => {
        const m: Row = { ...r };
        for (const c of cfg.users ?? []) if (c in m) m[c] = user(m[c]);
        for (const c of cfg.po ?? []) if (c in m) m[c] = po(m[c]);
        for (const c of cfg.line ?? []) if (c in m) m[c] = m[c] === null ? null : lineMap.get(textOf(m[c])) ?? null;
        return m;
      }).filter((m) => cfg.upsert || !existing.has(key.map((k) => textOf(m[k])).join('|')));
      const cols = cfg.dropId ? s.cols.filter((c) => c !== 'id') : s.cols;
      if (mapped.length) await insertRows(qr, table, cols, s.json, mapped, cfg.upsert);
      count(table, mapped.length);
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
    const devPos = await fromDev(TABLES.MASTER_PURCHASE_ORDERS);
    const prodKeys = new Map((await q<{ uid: string; channel: string; poNumber: string; orderNo1: string | null; uniwareStatus: string | null }[]>(
      `SELECT uid, channel, poNumber, orderNo1, uniwareStatus FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE transferCode IS NULL`))
      .map((p) => [`${p.channel.toLowerCase()}|${p.poNumber}`, p]));
    const pos = await shape(qr, src, TABLES.MASTER_PURCHASE_ORDERS);
    const lines = await shape(qr, src, TABLES.DETAILS_PURCHASE_ORDERS);
    const devLines = await fromDev(TABLES.DETAILS_PURCHASE_ORDERS);
    const linesOf = new Map<string, Row[]>();
    for (const l of devLines) (linesOf.get(String(l.shipmentOrderId)) ?? linesOf.set(String(l.shipmentOrderId), []).get(String(l.shipmentOrderId))!).push(l);
    const notes: Row[] = [];
    for (const d of devPos) {
      if (d.transferCode !== null) { report.posSkippedTransfers++; continue; }
      const hit = prodKeys.get(`${String(d.channel).toLowerCase()}|${String(d.poNumber)}`);
      if (hit) {
        poMap.set(String(d.uid), String(hit.uid));
        report.posLinked++;
        if (!hit.uniwareStatus && d.uniwareStatus) {
          await qr.query(`UPDATE ${TABLES.MASTER_PURCHASE_ORDERS} SET uniwareStatus = ?, uniwareDoneAt = ?, lastSyncedAt = ? WHERE uid = ?`, [d.uniwareStatus, d.uniwareDoneAt ?? null, d.lastSyncedAt ?? null, hit.uid]);
          report.uniwareStatusFilled++;
        }
        if (d.orderNo1 && hit.orderNo1 && d.orderNo1 !== hit.orderNo1) {
          notes.push({ shipment_uid: hit.uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: SHIPMENT_LOG_SOURCE.SCRIPT,
            remark: `${DEV_COPY.SALE_CODE_NOTE} ${textOf(d.orderNo1)}; the code used is PEPIMS's ${hit.orderNo1}${d.uniwareStatus === DEV_COPY.MARKED_NOT_IN_UNIWARE ? ' (dev marked it uploaded, but it was never in Uniware)' : ''}` });
          report.saleCodeNotes++;
        }
        // line ids: dev line -> the prod line with the same SKU (n-th with the n-th)
        const prodLines = await q<{ id: string; skuCode: string | null }[]>(`SELECT id, skuCode FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId = ? ORDER BY id`, [hit.uid]);
        const free = [...prodLines];
        for (const l of linesOf.get(String(d.uid)) ?? []) {
          const at = free.findIndex((p) => (p.skuCode ?? '').toLowerCase() === textOf(l.skuCode).toLowerCase());
          if (at >= 0) lineMap.set(String(l.id), String(free.splice(at, 1)[0].id));
        }
        continue;
      }
      // only on dev: a new PO in prod (new uid) with its lines
      const cols = pos.cols.filter((c) => c !== 'uid');
      const res = (await qr.query(`INSERT INTO ${TABLES.MASTER_PURCHASE_ORDERS} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`,
        [cols.map((c) => (pos.json.has(c) && d[c] !== null && typeof d[c] !== 'string' ? JSON.stringify(d[c]) : d[c] ?? null))])) as { insertId: number };
      const uid = String(res.insertId);
      poMap.set(String(d.uid), uid);
      report.posAdded++;
      const lcols = lines.cols.filter((c) => c !== 'id');
      for (const l of linesOf.get(String(d.uid)) ?? []) {
        const r = (await qr.query(`INSERT INTO ${TABLES.DETAILS_PURCHASE_ORDERS} (${lcols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`,
          [lcols.map((c) => (c === 'shipmentOrderId' ? uid : l[c] ?? null))])) as { insertId: number };
        lineMap.set(String(l.id), String(r.insertId));
        report.linesAdded++;
      }
    }
    count(TABLES.MASTER_PURCHASE_ORDERS, report.posAdded);
    say(`[dev-copy] POs: ${report.posLinked} linked to PEPIMS's, ${report.posAdded} added, ${report.posSkippedTransfers} D2C transfers left on dev`);

    // ---- 4. the PO work done on dev ----
    const state = await q<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [DEV_COPY.STATE_KEY]);
    const lastLog = Number(((state[0]?.value ?? {}) as { shipmentLogId?: number }).shipmentLogId ?? 0);
    const [maxLog] = await q<{ m: number | null }[]>(`SELECT MAX(id) m FROM \`${src}\`.${TABLES.SHIPMENT_LOGS}`);
    await copy(TABLES.SHIPMENT_LOGS, {
      users: ['user_id'], po: ['shipment_uid'], line: ['line_id'], dropId: true, where: `id > ${lastLog}`, key: ['id'], noExistCheck: true,
      skip: (r) => !poMap.has(String(r.shipment_uid)),
    });
    // a re-run never writes the same note twice
    const noted = new Set((await q<{ k: string }[]>(`SELECT CONCAT(shipment_uid, '|', remark) k FROM ${TABLES.SHIPMENT_LOGS} WHERE remark LIKE ?`, [`${DEV_COPY.SALE_CODE_NOTE}%`])).map((r) => r.k));
    const newNotes = notes.filter((n) => !noted.has(`${textOf(n.shipment_uid)}|${textOf(n.remark)}`));
    if (newNotes.length) await insertRows(qr, TABLES.SHIPMENT_LOGS, ['shipment_uid', 'action', 'source', 'remark'], new Set(), newNotes);
    count(`${TABLES.SHIPMENT_LOGS} (sale code notes)`, newNotes.length);
    await copy(TABLES.PO_UPLOADS, { users: ['csv_downloaded_by', 'uniware_uploaded_by', 'uploaded_by'], po: ['po_uid'] });
    await copy(TABLES.PO_ISSUES, { users: ['resolved_by'] });
    await copy(TABLES.PO_ISSUE_ACTIONS, { users: ['action_by'] });
    await copy(TABLES.PO_REVIEW_SUBMISSIONS, { users: ['submitted_by', 'decided_by'], po: ['po_uid'] });
    await copy(TABLES.PO_VERIFICATIONS, { users: ['done_by'], po: ['po_uid'] });
    await copy(TABLES.PO_PRICE_DIFFERENCES, { users: ['approved_by', 'reviewed_by', 'sent_by'], po: ['po_uid'] });
    await copy(TABLES.PO_REOPENS, { users: ['rejected_by', 'reopened_by'] });
    await copy(TABLES.MANUAL_UPLOADS, { users: ['uploaded_by', 'process_by'] });
    await copy(TABLES.CHANNEL_PULL_ITEMS, { key: ['source_system', 'external_id'], dropId: true });
    await copy(TABLES.UNIWARE_CREATES, { users: ['requested_by'], po: ['po_uid'] });
    await copy(TABLES.GMAIL_MESSAGES, { key: ['gmail_id'] });
    await copy(TABLES.INTAKE_EMAILS, { key: ['message_key'], dropId: true });
    await copy(TABLES.PO_VERIFY_CHANNEL_SETTINGS, { users: ['updated_by'], key: ['channel'], dropId: true });
    for (const t of DEV_COPY.BULK_TABLES) {
      await copy(t, { users: ['created_by', 'decided_by', 'needed_by', 'ordered_by', 'payment_by', 'processed_by', 'uploaded_by', 'by_user_id', 'updated_by', 'hidden_by'], po: ['po_uid'] });
    }
    for (const t of DEV_COPY.FEEDBACK_TABLES) {
      await copy(t, { users: ['updated_by', 'assigned_to', 'reporter_id', 'user_id', 'added_by', 'uploaded_by', 'removed_by', 'actor_id', 'from_user_id', 'to_user_id'] });
    }
    // sale order counter: the higher serial per day, so prod never gives a code dev already gave
    const counters = await fromDev(TABLES.SALE_ORDER_CODE_COUNTER);
    for (const c of counters) {
      await qr.query(`INSERT INTO ${TABLES.SALE_ORDER_CODE_COUNTER} (counter_date, last_serial) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_serial = GREATEST(last_serial, VALUES(last_serial))`, [c.counter_date, c.last_serial]);
    }
    count(TABLES.SALE_ORDER_CODE_COUNTER, counters.length);
    await qr.query(`INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [DEV_COPY.STATE_KEY, JSON.stringify({ shipmentLogId: Number(maxLog.m ?? 0), at: new Date().toISOString() })]);

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
