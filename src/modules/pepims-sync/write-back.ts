import { DataSource } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { PEPIMS_FIELD_KIND, PEPIMS_LINE_FIELDS, PEPIMS_PO_FIELDS, PEPIMS_PO_TABLES, PO_IMPORTED_FROM, TABLES } from '../../constants';
import { canon, mapLine, Row, textOf } from './mapping';

/*
 * POST_FG -> PEPIMS (2026-11-16, step 2c; user: "keep both in sync for a few days, the newest change wins" + "writes to
 * PEPIMS: until I say"). ONLY with PEPIMS_SYNC_WRITE_BACK=true (off by default; the laptop never). Runs after the
 * PEPIMS -> POST_FG pass of the same sync, so PEPIMS's own changes were already taken:
 *   - a linked PO whose field changed on our side since the last sync, and not in PEPIMS: PEPIMS gets our value (+ one
 *     PEPIMS log row "<field> changed from A to B (POST_FG)"), the link remembers it;
 *   - a PO made in POST_FG (not imported, not a D2C transfer) that PEPIMS does not have (PO number unique there): added to
 *     PEPIMS with its lines, and linked.
 * Never deletes anything in PEPIMS. Dates go as YYYY-MM-DD text, numbers as numbers (PEPIMS's own column types).
 */

export interface WriteBackReport { fieldsWritten: number; posUpdated: number; posAdded: number; linesAdded: number; skippedNoChannel: number }

const kinds = PEPIMS_PO_FIELDS;
const pepValue = (kind: string, c: string | null): unknown => {
  if (c === null) return null;
  if (kind === PEPIMS_FIELD_KIND.JSON) return c; // JSON text into a json column
  if (kind === PEPIMS_FIELD_KIND.INT || kind === PEPIMS_FIELD_KIND.DEC2 || kind === PEPIMS_FIELD_KIND.DEC3) return Number(c);
  return c;
};
/** Our PO columns as the sync compares them (dates as text), from table alias `a`. */
const ourSelect = (a: string): string => [
  ...['uid', 'channel', 'poNumber', 'partyName', 'createdAt'].map((c) => `${a}.\`${c}\``),
  ...Object.keys(kinds).map((f) => (kinds[f] === PEPIMS_FIELD_KIND.DATE ? `DATE_FORMAT(${a}.\`${f}\`, '%Y-%m-%d') AS \`${f}\`` : `${a}.\`${f}\``)),
].join(', ');
const ourCanon = (r: Row): Record<string, string | null> => Object.fromEntries(Object.keys(kinds).map((f) => [f, canon(kinds[f], r[f])]));

export const writeBackToPepims = async (): Promise<WriteBackReport> => {
  const report: WriteBackReport = { fieldsWritten: 0, posUpdated: 0, posAdded: 0, linesAdded: 0, skippedNoChannel: 0 };
  if (!env.pepimsSync.writeBack) return report;
  const pep = new DataSource({
    type: 'mysql', host: env.db.host, port: env.db.port, username: env.db.username, password: env.db.password,
    database: env.pepimsSync.sourceDb, synchronize: false, entities: [], dateStrings: true,
  });
  await pep.initialize();
  try {
    // 1. linked POs changed on our side since their last sync
    const changed = await AppDataSource.query<Row[]>(
      `SELECT l.pepims_uid, l.po_uid, l.synced_values, ${ourSelect('p')}
         FROM ${TABLES.PEPIMS_SYNC_LINKS} l JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = l.po_uid WHERE p.updatedAt > l.synced_at`);
    for (const r of changed) {
      const base = (typeof r.synced_values === 'string' ? JSON.parse(r.synced_values) : r.synced_values ?? {}) as Record<string, string | null>;
      const cur = ourCanon(r);
      const [p] = await pep.query<Row[]>(`SELECT * FROM ${PEPIMS_PO_TABLES.PO} WHERE uid = ?`, [r.pepims_uid]);
      if (!p) continue;
      const set: Record<string, unknown> = {};
      const changes: string[] = [];
      for (const f of Object.keys(kinds)) {
        const b = f in base ? base[f] : cur[f];
        const now = canon(kinds[f], p[f]);
        if (cur[f] === b || cur[f] === now) continue; // not changed on our side / already equal
        if (now !== b) continue; // PEPIMS changed it too: the PEPIMS -> POST_FG pass decided already
        set[f] = pepValue(kinds[f], cur[f]);
        changes.push(`${f} changed from ${b ?? 'empty'} to ${cur[f] ?? 'empty'} (POST_FG)`);
      }
      const synced = { ...base, ...Object.fromEntries(Object.keys(set).map((f) => [f, cur[f]])) };
      if (Object.keys(set).length) {
        await pep.transaction(async (m) => {
          await m.query(`UPDATE ${PEPIMS_PO_TABLES.PO} SET ${Object.keys(set).map((f) => `\`${f}\` = ?`).join(', ')}, updatedAt = NOW() WHERE uid = ?`, [...Object.values(set), r.pepims_uid]);
          await m.query(`INSERT INTO ${PEPIMS_PO_TABLES.LOGS} (messages, createdBy, shipmentOrderId, createdAt, updatedAt) VALUES (CAST(? AS JSON), NULL, ?, NOW(), NOW())`,
            [JSON.stringify(changes.map((change) => ({ change }))), r.pepims_uid]);
        });
        report.fieldsWritten += changes.length;
        report.posUpdated++;
      }
      await AppDataSource.query(`UPDATE ${TABLES.PEPIMS_SYNC_LINKS} SET synced_values = CAST(? AS JSON), synced_at = ? WHERE pepims_uid = ?`, [JSON.stringify(synced), new Date(), r.pepims_uid]);
    }

    // 2. POs made in POST_FG that PEPIMS does not have yet
    const ours = await AppDataSource.query<Row[]>(
      `SELECT ${ourSelect('p')} FROM ${TABLES.MASTER_PURCHASE_ORDERS} p WHERE p.transferCode IS NULL AND (p.importedFrom IS NULL OR p.importedFrom <> ?)
         AND NOT EXISTS (SELECT 1 FROM ${TABLES.PEPIMS_SYNC_LINKS} l WHERE l.po_uid = p.uid)`, [PO_IMPORTED_FROM.PEPIMS]);
    for (const r of ours) {
      const [there] = await pep.query<Row[]>(`SELECT uid FROM ${PEPIMS_PO_TABLES.PO} WHERE poNumber = ?`, [r.poNumber]);
      if (there) continue; // PEPIMS has it: the PEPIMS -> POST_FG pass links it (channel + PO number)
      const cur = ourCanon(r);
      // PEPIMS keeps the buyer's own name as its "channel" (Bulk / Others buckets are ours only)
      const channel = r.partyName ? textOf(r.partyName) : textOf(r.channel);
      if (!channel) { report.skippedNoChannel++; continue; }
      const lines = await AppDataSource.query<Row[]>(`SELECT * FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId = ? ORDER BY id`, [r.uid]);
      await pep.transaction(async (m) => {
        const fields = Object.keys(kinds).filter((f) => cur[f] !== null);
        const res = await m.query<{ insertId: number }>(
          `INSERT INTO ${PEPIMS_PO_TABLES.PO} (channel, poNumber, ${fields.map((f) => `\`${f}\``).join(', ')}, createdAt, updatedAt) VALUES (?, ?, ${fields.map(() => '?').join(', ')}, NOW(), NOW())`,
          [channel, r.poNumber, ...fields.map((f) => pepValue(kinds[f], cur[f]))]);
        const pepUid = Number(res.insertId);
        const lineLinks: { lineId: string; pepimsLineId: number; synced: Record<string, string | null> }[] = [];
        for (const l of lines) {
          const lc = mapLine(l);
          const lf = Object.keys(PEPIMS_LINE_FIELDS).filter((f) => lc[f] !== null);
          const lr = await m.query<{ insertId: number }>(`INSERT INTO ${PEPIMS_PO_TABLES.LINES} (shipmentOrderId, ${lf.map((f) => `\`${f}\``).join(', ')}, createdAt, updatedAt) VALUES (?, ${lf.map(() => '?').join(', ')}, NOW(), NOW())`,
            [pepUid, ...lf.map((f) => pepValue(PEPIMS_LINE_FIELDS[f], lc[f]))]);
          lineLinks.push({ lineId: textOf(l.id), pepimsLineId: Number(lr.insertId), synced: lc });
          report.linesAdded++;
        }
        await AppDataSource.query(`INSERT INTO ${TABLES.PEPIMS_SYNC_LINKS} (po_uid, pepims_uid, synced_values, synced_at) VALUES (?, ?, CAST(? AS JSON), ?)`, [r.uid, pepUid, JSON.stringify(cur), new Date()]);
        for (const ll of lineLinks) {
          await AppDataSource.query(`INSERT INTO ${TABLES.PEPIMS_SYNC_LINE_LINKS} (line_id, pepims_line_id, po_uid, synced_values, synced_at) VALUES (?, ?, ?, CAST(? AS JSON), ?)`,
            [ll.lineId, ll.pepimsLineId, r.uid, JSON.stringify(ll.synced), new Date()]);
        }
      });
      report.posAdded++;
    }
  } finally {
    await pep.destroy();
  }
  return report;
};
