import { Context, fmtInt } from '../context';
import { stripped } from '../frame';

/*
 * Entity (user, 2026-10-29): the company a SKU belongs to - "Kreative" when its SKU code has "HYP" in it (any case,
 * anywhere: HYPMUBX001F050, HYPN...), else "Pep". A column right after Split2 SKU on Sheet35(2) and Final Sheet35(2).
 * Not on Full_Shipment_Enhanced: it has one row per PO, no SKU (user: leave it). Runs last, once the sheets are final.
 */

export const ENTITY = { COLUMN: 'Entity', KREATIVE: 'Kreative', PEP: 'Pep' } as const;
const KREATIVE_RE = /hyp/i;

export const entityOf = (sku: string): string => (KREATIVE_RE.test(sku) ? ENTITY.KREATIVE : ENTITY.PEP);

/** [frame, its SKU column, sheet label]. */
const SHEETS: [string, string, string][] = [
  ['df_sheet35', 'Split2 SKU', 'Sheet35(2)'],
  ['df_final_sheet35', 'Split2 SKU', 'Final Sheet35(2)'],
];

export const run = async (ctx: Context): Promise<void> => {
  for (const [frame, skuCol, label] of SHEETS) {
    const df = ctx.get(frame);
    if (!df.has(skuCol)) {
      ctx.warn(`${label}: no '${skuCol}' column, so no Entity column`);
      continue;
    }
    const entity = stripped(df.get(skuCol)).map(entityOf);
    ctx.set(frame, df.insert(df.columns.indexOf(skuCol) + 1, ENTITY.COLUMN, entity));
    const kreative = entity.filter((e) => e === ENTITY.KREATIVE).length;
    ctx.log(`  ${label}: Entity ${ENTITY.KREATIVE} ${fmtInt(kreative)} | ${ENTITY.PEP} ${fmtInt(entity.length - kreative)} rows`);
  }
};
