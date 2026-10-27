/*
 * Fills the brand of saved POs that have none (user, 2026-10-26). master_skus keeps "0" for "no brand" (all combos), and
 * before the fix in validate-po the channel SKU row's brand was never used, so a PO starting with a combo got no brand.
 *   line  (details_purchase_orders.brandName, empty or "0"): master_skus brand, else the channel SKU row of the PO's
 *         channel, else any channel's row for that SKU (no SKU has two brands across channels, checked 2026-10-26).
 *   PO    (master_purchase_orders.brandName, empty or "0"): the first line that has a brand (after the line fill).
 * Every change is logged in shipment_logs (field_changed, source script), one batch per PO. DRY RUN by default; --apply
 * writes in one transaction. Only empty brands are touched, so it is safe to run again.
 *
 *   npm run po:brand-fill [-- --apply]
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { BRAND_NAMES, NO_BRAND, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE } from '../constants';
import { DetailsPurchaseOrder, MasterChannelSku, MasterPurchaseOrder, MasterSku, ShipmentLog } from '../entities';

const APPLY = process.argv.includes('--apply');
const REMARK = 'Brand filled: master_skus "0" -> channel SKU brand (po:brand-fill)';

const empty = (b: string | null | undefined) => NO_BRAND.includes((b ?? '').trim());
const name = (b: string) => BRAND_NAMES[b.trim().toLowerCase()] ?? b.trim();

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    const db = AppDataSource;
    const lines = await db.getRepository(DetailsPurchaseOrder)
      .createQueryBuilder('d')
      .where("(d.brandName IS NULL OR TRIM(d.brandName) IN ('', '0'))")
      .getMany();
    const headers = await db.getRepository(MasterPurchaseOrder)
      .createQueryBuilder('m')
      .where("(m.brandName IS NULL OR TRIM(m.brandName) IN ('', '0'))")
      .getMany();
    const poUids = [...new Set([...lines.map((l) => String(l.shipmentOrderId)), ...headers.map((h) => String(h.uid))])];
    if (!poUids.length) return console.log('Nothing to fill.');

    const pos = new Map((await db.getRepository(MasterPurchaseOrder).findBy({ uid: In(poUids) })).map((p) => [String(p.uid), p]));
    const allLines = await db.getRepository(DetailsPurchaseOrder).findBy({ shipmentOrderId: In(poUids) });
    const codes = [...new Set(allLines.map((l) => l.skuCode).filter((c): c is string => !!c))];
    const skuBrand = new Map((codes.length ? await db.getRepository(MasterSku).findBy({ pepCode: In(codes) }) : []).map((s) => [s.pepCode, s.brandName]));
    const channelRows = codes.length ? await db.getRepository(MasterChannelSku).findBy({ pepCode: In(codes) }) : [];

    const brandOf = (sku: string | null, channel: string | null): string | null => {
      if (!sku) return null;
      const own = skuBrand.get(sku);
      if (!empty(own)) return name(own!);
      const rows = channelRows.filter((r) => r.pepCode === sku && !empty(r.brandName));
      const same = rows.find((r) => (r.channelName ?? '').toLowerCase() === (channel ?? '').toLowerCase());
      return same ? name(same.brandName!) : rows.length ? name(rows[0].brandName!) : null;
    };

    type Change = { po: string; lineId: string | null; field: string; from: string | null; to: string; what: string };
    const changes: Change[] = [];
    for (const uid of poUids) {
      const po = pos.get(uid)!;
      const mine = allLines.filter((l) => String(l.shipmentOrderId) === uid).sort((a, b) => Number(a.srNo) - Number(b.srNo));
      const after = new Map<string, string | null>();
      for (const l of mine) {
        let b = empty(l.brandName) ? null : l.brandName;
        if (!b) {
          const found = brandOf(l.skuCode, po.channel);
          if (found) changes.push({ po: uid, lineId: String(l.id), field: 'brandName', from: l.brandName, to: found, what: `line ${l.srNo} ${l.skuCode}` });
          b = found;
        }
        after.set(String(l.id), b);
      }
      if (empty(po.brandName)) {
        const first = mine.map((l) => after.get(String(l.id))).find((b) => !!b);
        if (first) changes.push({ po: uid, lineId: null, field: 'brandName', from: po.brandName, to: first, what: 'PO brand' });
      }
    }

    const byPo = new Map<string, Change[]>();
    for (const c of changes) byPo.set(c.po, [...(byPo.get(c.po) ?? []), c]);
    console.log(`\n${byPo.size} PO(s), ${changes.length} change(s):`);
    for (const [uid, list] of byPo) {
      const po = pos.get(uid)!;
      console.log(`\n  PO ${po.poNumber} (${po.channel}, uid ${uid})`);
      for (const c of list) console.log(`    ${c.what}: ${JSON.stringify(c.from)} -> ${c.to}`);
    }
    const left = poUids.filter((u) => !changes.some((c) => c.po === u && c.lineId === null) && empty(pos.get(u)!.brandName));
    for (const u of left) console.log(`\n  still no PO brand: ${pos.get(u)!.poNumber} (no line brand anywhere)`);

    if (!APPLY) return console.log('\nDry run only. Add --apply to write.');
    await db.transaction(async (m) => {
      for (const [uid, list] of byPo) {
        const batchId = randomUUID();
        for (const c of list) {
          if (c.lineId) await m.getRepository(DetailsPurchaseOrder).update({ id: c.lineId }, { brandName: c.to });
          else await m.getRepository(MasterPurchaseOrder).update({ uid }, { brandName: c.to });
          await m.getRepository(ShipmentLog).insert({
            shipmentUid: uid, userId: null, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: SHIPMENT_LOG_SOURCE.SCRIPT,
            fieldName: c.field, lineId: c.lineId, batchId, oldValue: c.from, newValue: c.to, remark: REMARK,
          });
        }
      }
    });
    console.log('\nDone.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
