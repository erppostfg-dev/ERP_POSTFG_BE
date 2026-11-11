import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { forgetMasters } from '../masters/masters.cache';
import { ERROR_CODES, MASTER_CHANGE_SOURCE, TABLES } from '../../constants';
import { appError } from '../../utils/AppError';
import { assertMastersWritable, Change, ensureSkus, logChanges, mastersInDb, Who } from './masters-db';
import { importMasterUpload } from './masters-upload';
import { NewSku, newSkuKey, SkuFill, SkuReviewSettings } from './sku-fill';
import { addToSplit1, mapVariants } from './split1.service';
import { UniwareConfig } from './sources/uniware';

/*
 * The server side of a build's issues and filled Sheet35 values (user, 2026-11-02; the build side is sku-fill.ts):
 *   - what a build is given: the SKUs answered before and our product master (names, MRPs);
 *   - the filled values saved to master_skus (blanks only, marked intransit_autofilled), for SKUs it already has;
 *   - the answers: a SKU gets intransit_reviewed_at (Don't consider = intransit_consider 0, its Sheet35 values kept
 *     otherwise), a marketplace code a Channel SKU Mapping row to the seller's SKU (consider 0 = not counted), a combo
 *     its Split1 rows or its base, a _S code its base, a location its city; an ignored one nothing (asked again).
 * Only where the masters are in the database and only on the live server (assertMastersWritable).
 */

const SHEET35 = 'Sheet35(2)';
const lc = (s: string): string => s.trim().toLowerCase();

/** Builds ask (and save) only on the live server with the masters in the database. */
export const reviewsHere = (): boolean => mastersInDb() && !env.intransit.test;

/** What a build needs to fill and find new SKUs. */
export const reviewSettings = async (uniware: UniwareConfig | null, cacheDir: string): Promise<SkuReviewSettings> => {
  const rows = (await AppDataSource.query(
    `SELECT pep_code, product_name, mrp, intransit_reviewed_at IS NOT NULL AS reviewed FROM ${TABLES.MASTER_SKUS}`)) as { pep_code: string; product_name: string | null; mrp: string | null; reviewed: number }[];
  const catalog: SkuReviewSettings['catalog'] = {};
  for (const r of rows) catalog[lc(r.pep_code)] = { name: r.product_name, mrp: r.mrp === null ? null : Number(r.mrp) };
  return { pause: reviewsHere(), reviewed: rows.filter((r) => Number(r.reviewed)).map((r) => lc(r.pep_code)), catalog, uniware, cacheDir };
};

/** Save a build's filled values to the SKUs master_skus has (blanks only); returns how many SKUs changed. */
export const saveSkuFills = async (fills: SkuFill[], who: Who): Promise<number> => {
  if (!fills.length || !reviewsHere()) return 0;
  const out = await AppDataSource.transaction(async (m) => {
    let changed = 0;
    for (let i = 0; i < fills.length; i += 500) {
      const part = fills.slice(i, i + 500);
      const cur = (await m.query(
        `SELECT pep_code, intransit_name, intransit_mrp, intransit_cogs FROM ${TABLES.MASTER_SKUS} WHERE pep_code IN (${part.map(() => '?').join(', ')})`,
        part.map((f) => f.sku))) as { pep_code: string; intransit_name: string | null; intransit_mrp: string | null; intransit_cogs: string | null }[];
      const byKey = new Map(cur.map((r) => [lc(r.pep_code), r]));
      const changes: Change[] = [];
      for (const f of part) {
        const r = byKey.get(lc(f.sku));
        if (!r) continue; // not in the product master: saved when the user answers for it
        const set: Record<string, unknown> = {};
        if (f.name !== undefined && r.intransit_name === null) set.intransit_name = f.name;
        if (f.mrp !== undefined && r.intransit_mrp === null) set.intransit_mrp = f.mrp;
        if (f.cogs !== undefined && r.intransit_cogs === null) set.intransit_cogs = f.cogs;
        if (!Object.keys(set).length) continue;
        await m.query(`UPDATE ${TABLES.MASTER_SKUS} SET ${Object.keys(set).map((c) => `${c} = ?`).join(', ')}, intransit_autofilled = ? WHERE pep_code = ?`,
          [...Object.values(set), f.from.slice(0, 100), r.pep_code]);
        for (const [c, v] of Object.entries(set)) changes.push({ master: SHEET35, table: TABLES.MASTER_SKUS, rowKey: r.pep_code, field: c, oldValue: null, newValue: v });
        changed++;
      }
      await logChanges(m, changes, who, MASTER_CHANGE_SOURCE.UNIWARE_FILL);
    }
    return changed;
  });
  void forgetMasters(); // the shared cached masters (PEP SKU list etc.) are dropped after the commit (2026-11-11, POST_FG Bulk Orders / PO panels)
  return out;
};

/** What a person chose for one issue of a build (POST /runs/:id/issues). */
export type IssueAction = 'consider' | 'not-consider' | 'ignore' | 'add-split1' | 'map' | 'set-location';
export interface IssueAnswer {
  kind: NewSku['kind'];
  sku?: string;
  channel?: string;
  code?: string;
  action: IssueAction;
  /** set-location: the Final Location (city) of the fulfilment centre / warehouse. */
  location?: string;
}

/** The actions each kind of issue takes (ignore = this build only: asked again at the next one). */
const ACTIONS: Record<NewSku['kind'], IssueAction[]> = {
  sku: ['consider', 'not-consider', 'ignore'],
  code: ['consider', 'not-consider', 'ignore'],
  combo: ['add-split1', 'map', 'ignore'],
  'final-sku': ['map', 'ignore'],
  location: ['set-location', 'ignore'],
};

const label = (n: Pick<NewSku, 'kind' | 'sku' | 'channel' | 'code'>): string => (n.kind === 'code' || n.kind === 'location' ? `${n.channel} ${n.code}` : n.sku);

/**
 * Apply the answers for a build's issues (every one of `items` answered once): Consider / Don't consider saved to the
 * SKU masters, combos added to Split1 or mapped to their base, _S codes mapped, locations set (through the Location
 * Master / MyntraWHIDs upload, so the same checks and change log apply); ignored ones are left as they are.
 */
export const applyIssueAnswers = async (items: NewSku[], answers: IssueAnswer[], who: Who): Promise<{ fixed: number; ignored: number }> => {
  assertMastersWritable();
  if (!mastersInDb()) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, 'the masters are files on this server, not in the database');
  const byKey = new Map(items.map((n) => [newSkuKey(n), n]));
  const chosen = new Map<string, IssueAnswer>();
  for (const a of answers ?? []) {
    const key = newSkuKey({ kind: a.kind, sku: a.sku ?? '', channel: a.channel, code: a.code });
    const n = byKey.get(key);
    if (!n) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${label({ kind: a.kind, sku: a.sku ?? '', channel: a.channel, code: a.code })} was not asked`);
    if (!ACTIONS[n.kind].includes(a.action)) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${label(n)}: "${a.action}" is not an answer for it`);
    if (a.action === 'add-split1' && !n.components?.length) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${label(n)}: Uniware gave no parts to add`);
    if (a.action === 'map' && !n.base?.sku) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${label(n)}: no base to map it to`);
    if (a.action === 'set-location' && !a.location?.trim()) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${label(n)}: pick its location`);
    chosen.set(key, a);
  }
  const open = [...byKey.keys()].filter((k) => !chosen.has(k));
  if (open.length) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, `${open.length} of ${byKey.size} not answered`);
  const of = (n: NewSku) => chosen.get(newSkuKey(n)) as IssueAnswer;
  const pick = (action: IssueAction) => items.filter((n) => of(n).action === action);

  const decided = items.filter((n) => (n.kind === 'sku' || n.kind === 'code') && of(n).action !== 'ignore');
  if (decided.length) await saveSkuDecisions(decided, new Map(decided.map((n) => [newSkuKey(n), of(n).action === 'consider'])), who);
  const split1 = pick('add-split1');
  if (split1.length) await addToSplit1(split1.map((n) => ({ combo: n.sku, components: n.components ?? [] })), who);
  const maps = pick('map');
  if (maps.length) {
    await mapVariants(maps.map((n) => ({ variant: n.sku, base: n.base?.sku ?? '', ...(n.base?.components.length ? { components: n.base.components } : {}) })), who);
  }
  const locs = pick('set-location');
  // a Myntra warehouse id belongs in MyntraWHIDs, any other code in Location Master
  const myntraId = (n: NewSku) => (n.channel ?? '').toLowerCase() === 'myntra' && /^\d+$/.test(n.code ?? '');
  const wh = locs.filter(myntraId);
  const lm = locs.filter((n) => !myntraId(n));
  const csv = (rows: string[][]) => new TextEncoder().encode(rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));
  if (lm.length) await importMasterUpload('Location Master.csv', csv([['Channel', 'Fulfillment Centre-ID', 'Final Location'], ...lm.map((n) => [n.channel ?? '', n.code ?? '', (of(n).location ?? '').trim()])]), who);
  if (wh.length) await importMasterUpload('MyntraWHIDs.csv', csv([['WH Id', 'WH location'], ...wh.map((n) => [n.code ?? '', (of(n).location ?? '').trim()])]), who);
  const ignored = pick('ignore').length;
  return { fixed: items.length - ignored, ignored };
};

/** Consider (true) / Don't consider (false) for SKUs and marketplace codes, by newSkuKey. */
const saveSkuDecisions = async (items: NewSku[], answered: Map<string, boolean>, who: Who): Promise<void> => {
  await AppDataSource.transaction(async (m) => {
    const skuItems = items.filter((n) => n.kind === 'sku');
    const { map } = await ensureSkus(m, skuItems.map((n) => n.sku), who, SHEET35, MASTER_CHANGE_SOURCE.SKU_REVIEW, false, true);
    const changes: Change[] = [];
    for (const n of skuItems) {
      const consider = answered.get(newSkuKey(n)) as boolean;
      const pep = map.get(lc(n.sku)) ?? n.sku;
      const cur = ((await m.query(`SELECT intransit_name, intransit_mrp, intransit_cogs FROM ${TABLES.MASTER_SKUS} WHERE pep_code = ?`, [pep])) as Record<string, unknown>[])[0] ?? {};
      const set: Record<string, unknown> = { intransit_reviewed_at: new Date() };
      if (!consider) set.intransit_consider = 0;
      else {
        // its Sheet35 values as the build filled them (blanks only)
        if (cur.intransit_name === null && n.name) set.intransit_name = n.name.slice(0, 500);
        if (cur.intransit_mrp === null && n.mrp !== null) set.intransit_mrp = n.mrp;
        if (cur.intransit_cogs === null && n.cogs !== null) set.intransit_cogs = n.cogs;
        if ('intransit_mrp' in set || 'intransit_cogs' in set) set.intransit_autofilled = 'answered at a build: MRP / COGS as filled';
      }
      await m.query(`UPDATE ${TABLES.MASTER_SKUS} SET ${Object.keys(set).map((c) => `${c} = ?`).join(', ')} WHERE pep_code = ?`, [...Object.values(set), pep]);
      changes.push({ master: SHEET35, table: TABLES.MASTER_SKUS, rowKey: pep, field: 'consider (new SKU)', oldValue: null, newValue: consider ? 'Consider' : "Don't consider" });
    }
    for (const n of items.filter((x) => x.kind === 'code')) {
      const consider = answered.get(newSkuKey(n)) as boolean;
      await m.query(
        `INSERT INTO ${TABLES.INTRANSIT_CHANNEL_SKU_MAP} (sku_code, channel, channel_sku_code, source, review_note, is_active, consider) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE consider = VALUES(consider), is_active = 1`,
        [n.sku, n.channel ?? null, n.code, MASTER_CHANGE_SOURCE.SKU_REVIEW, `answered at a build by ${who.name ?? 'someone'}`.slice(0, 255), consider ? 1 : 0]);
      changes.push({ master: 'Channel SKU Mapping', table: TABLES.INTRANSIT_CHANNEL_SKU_MAP, rowKey: `${n.channel} ${n.code}`, field: 'sku_code', oldValue: null, newValue: `${n.sku}${consider ? '' : " (Don't consider)"}` });
    }
    await logChanges(m, changes, who, MASTER_CHANGE_SOURCE.SKU_REVIEW);
  });
  void forgetMasters(); // the shared cached masters (PEP SKU list etc.) are dropped after the commit (2026-11-11, POST_FG Bulk Orders / PO panels)
};
