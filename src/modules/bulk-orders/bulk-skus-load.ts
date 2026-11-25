import { AppDataSource } from '../../config/data-source';
import { BULK_ORDERS, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE } from '../../constants';
import { MasterSku } from '../../entities';
import { forgetMasters } from '../masters/masters.cache';
import { logMasterChanges, type MasterLogEntry } from '../masters/master-log';

/*
 * The Bulk Orders SKU list loader (2026-11-24; npm run bulk:skus). The file IS the list: its SKUs get bulk_orderable = 1,
 * every other SKU 0 (user: only these, don't show any others). A listed SKU with no brand in the master (empty / "0")
 * gets the file's brand (the portal shows SKUs per brand); a listed SKU whose master brand differs is reported, never
 * overwritten. Codes not in the master are reported and skipped. One transaction + one Masters History row per change.
 */

export interface BulkSkuRow { pepCode: string; brand: string }
export interface BulkSkuPlan {
  listed: number; on: string[]; off: string[]; brandFill: { pepCode: string; brand: string }[];
  brandDiffers: { pepCode: string; master: string; file: string }[]; notInMaster: string[]; duplicates: string[]; inactiveListed: string[];
}

type Sku = Pick<MasterSku, 'id' | 'pepCode' | 'brandName' | 'isActive' | 'bulkOrderable'>;
const noBrand = (b: string | null) => BULK_ORDERS.NO_BRAND.includes((b ?? '').trim());
const SELECT = { id: true, pepCode: true, brandName: true, isActive: true, bulkOrderable: true } as const;

/** What the load would change (pure: the file's rows + the master now). */
export const planBulkSkus = (rows: BulkSkuRow[], master: Sku[]): BulkSkuPlan => {
  const byCode = new Map(master.map((s) => [s.pepCode.trim().toUpperCase(), s]));
  const want = new Map<string, BulkSkuRow>();
  const p: BulkSkuPlan = { listed: 0, on: [], off: [], brandFill: [], brandDiffers: [], notInMaster: [], duplicates: [], inactiveListed: [] };
  for (const r of rows) {
    const k = r.pepCode.trim().toUpperCase();
    if (!k) continue;
    if (want.has(k)) p.duplicates.push(r.pepCode);
    else if (!byCode.has(k)) p.notInMaster.push(r.pepCode);
    else want.set(k, r);
  }
  p.listed = want.size;
  for (const s of master) {
    const r = want.get(s.pepCode.trim().toUpperCase());
    if (!r) {
      if (s.bulkOrderable) p.off.push(s.pepCode);
      continue;
    }
    if (!s.bulkOrderable) p.on.push(s.pepCode);
    if (s.isActive === false) p.inactiveListed.push(s.pepCode);
    const file = r.brand.trim();
    if (file && noBrand(s.brandName)) p.brandFill.push({ pepCode: s.pepCode, brand: file });
    else if (file && (s.brandName ?? '').trim().toLowerCase() !== file.toLowerCase()) p.brandDiffers.push({ pepCode: s.pepCode, master: (s.brandName ?? '').trim(), file });
  }
  return p;
};

/** Dry run (apply false) or the load in one transaction; returns what it would do / did. */
export const loadBulkSkus = async (rows: BulkSkuRow[], apply: boolean, by: { id: number | null }): Promise<BulkSkuPlan> => {
  if (!apply) return planBulkSkus(rows, await AppDataSource.getRepository(MasterSku).find({ select: SELECT }));
  const done = await AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(MasterSku);
    const master = await repo.find({ select: SELECT, lock: { mode: 'pessimistic_write' } });
    const p = planBulkSkus(rows, master);
    const byCode = new Map(master.map((s) => [s.pepCode, s]));
    const log: MasterLogEntry[] = [];
    const now = new Date();
    for (const [codes, val] of [[p.on, true], [p.off, false]] as const) {
      for (let i = 0; i < codes.length; i += 500) {
        await repo.createQueryBuilder().update().set({ bulkOrderable: val, updatedAt: now }).where('pep_code IN (:...part)', { part: codes.slice(i, i + 500) }).execute();
      }
      for (const c of codes) log.push({ type: MASTER_LOG_TYPE.PEP_SKU, recordId: byCode.get(c)!.id, rowKey: c, action: MASTER_LOG_ACTION.FIELD_CHANGED, field: 'bulkOrderable', oldValue: !val, newValue: val });
    }
    // one UPDATE per brand (500 ids a time): per SKU it was 538 UPDATEs of ~0.5-2 s each on the shared RDS (dev 2026-11-24)
    const byBrand = new Map<string, string[]>();
    for (const f of p.brandFill) {
      const s = byCode.get(f.pepCode)!;
      byBrand.set(f.brand, [...(byBrand.get(f.brand) ?? []), String(s.id)]);
      log.push({ type: MASTER_LOG_TYPE.PEP_SKU, recordId: s.id, rowKey: f.pepCode, action: MASTER_LOG_ACTION.FIELD_CHANGED, field: 'brand', oldValue: s.brandName, newValue: f.brand });
    }
    for (const [brand, ids] of byBrand) {
      for (let i = 0; i < ids.length; i += 500) {
        await repo.createQueryBuilder().update().set({ brandName: brand, updatedAt: now }).where('id IN (:...part)', { part: ids.slice(i, i + 500) }).execute();
      }
    }
    for (let i = 0; i < log.length; i += 1000) await logMasterChanges(m, log.slice(i, i + 1000), by, MASTER_LOG_SOURCE.SCRIPT, 'Bulk Orders SKU list (npm run bulk:skus)');
    return p;
  });
  await forgetMasters();
  return done;
};
