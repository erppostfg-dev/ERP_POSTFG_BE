import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../../config/env';
import { MASTER_CSV_COLUMNS, MASTER_LOAD_TYPE, MasterLoadType, PEPIMS_DATABASE, PEPIMS_TABLES, REMARK_LIST, STATUS_STAGE } from '../../constants';

/*
 * masters:load --pepims: reads PEPIMS's master tables (mcaff_inv) and returns them as the same rows a CSV gives, so
 * the loader treats both alike. READ-ONLY: its own connection (never the app's), every query inside
 * START TRANSACTION READ ONLY (MySQL refuses any write), rolled back and closed at the end.
 *   facility <- facility_masters · courier-partner <- courier_partner_masters · courier-rates <- courier_rate_masters
 *   status <- status_masters · status-values <- the distinct values of status_masters per stage (PEPIMS has no table
 *   for the dropdowns; order = first seen) · appointment-remarks <- appointment_remark_masters (list appointment_change)
 *   channel <- channel_location_masters
 */

export interface SourceRows {
  /** Where the rows came from, for the report. */
  from: string;
  header: string[];
  records: Record<string, string>[];
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const TABLE_OF: Partial<Record<MasterLoadType, string>> = {
  [MASTER_LOAD_TYPE.FACILITY]: PEPIMS_TABLES.FACILITY,
  [MASTER_LOAD_TYPE.COURIER_PARTNER]: PEPIMS_TABLES.COURIER_PARTNER,
  [MASTER_LOAD_TYPE.COURIER_RATES]: PEPIMS_TABLES.COURIER_RATES,
  [MASTER_LOAD_TYPE.STATUS]: PEPIMS_TABLES.STATUS,
  [MASTER_LOAD_TYPE.APPOINTMENT_REMARKS]: PEPIMS_TABLES.APPOINTMENT_REMARKS,
  [MASTER_LOAD_TYPE.CHANNEL]: PEPIMS_TABLES.CHANNEL_LOCATION,
};

/** Rows of a PEPIMS table, keeping only the columns the loader knows for `type`. */
const asRows = (type: MasterLoadType, table: string, rows: Record<string, unknown>[], extra: Record<string, string> = {}): SourceRows => {
  const known = [...MASTER_CSV_COLUMNS[type].required, ...MASTER_CSV_COLUMNS[type].optional];
  const header = [...known.filter((c) => rows.length === 0 || c in rows[0]), ...Object.keys(extra)];
  return {
    from: `${PEPIMS_DATABASE}.${table}`,
    header,
    records: rows.map((r) => ({ ...Object.fromEntries(header.filter((h) => !(h in extra)).map((h) => [h, str(r[h])])), ...extra })),
  };
};

export const readPepimsMasters = async (types: MasterLoadType[]): Promise<Map<MasterLoadType, SourceRows>> => {
  const ds = new DataSource({
    type: 'mysql',
    host: env.db.host,
    port: env.db.port,
    username: env.db.username,
    password: env.db.password,
    database: PEPIMS_DATABASE,
    synchronize: false,
    entities: [],
  });
  await ds.initialize();
  const qr = ds.createQueryRunner();
  const out = new Map<MasterLoadType, SourceRows>();
  try {
    await qr.query('START TRANSACTION READ ONLY');
    const all = async (table: string): Promise<Record<string, unknown>[]> => qr.query(`SELECT * FROM \`${table}\` ORDER BY id`);
    for (const type of types) {
      if (type === MASTER_LOAD_TYPE.STATUS_VALUES) {
        const rows = await all(PEPIMS_TABLES.STATUS);
        const seen = new Map<string, string[]>();
        for (const r of rows) {
          for (const [stage, col] of [[STATUS_STAGE.PLANNING, 'statusPlanning'], [STATUS_STAGE.WAREHOUSE, 'statusWarehouse'], [STATUS_STAGE.LOGISTICS, 'statusLogistics']] as const) {
            const v = str(r[col]);
            const list = seen.get(stage) ?? [];
            if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
            seen.set(stage, list);
          }
        }
        out.set(type, {
          from: `${PEPIMS_DATABASE}.${PEPIMS_TABLES.STATUS} (distinct values per stage)`,
          header: ['stage', 'value', 'sortOrder'],
          records: [...seen].flatMap(([stage, values]) => values.map((value, i) => ({ stage, value, sortOrder: String(i + 1) }))),
        });
        continue;
      }
      const table = TABLE_OF[type];
      if (!table) continue;
      const rows = await all(table);
      out.set(type, asRows(type, table, rows, type === MASTER_LOAD_TYPE.APPOINTMENT_REMARKS ? { list: REMARK_LIST.APPOINTMENT_CHANGE } : {}));
    }
  } finally {
    await qr.query('ROLLBACK').catch(() => undefined);
    await qr.release();
    await ds.destroy();
  }
  return out;
};
