import { describe, expect, it } from 'vitest';
import { defaultFacilityStock, FACILITY_GROUPS, STOCK_BUCKETS, STOCK_FORMULAS } from '../../../constants';
import { Context } from '../context';

const settings = { inputDir: '', templateXlsx: '', outputDir: '', asOf: '2026-10-22' };

describe('facility stock settings (Masters > Warehouses, 2026-11-02)', () => {
  it('every facility the report counts has a feed and formula by default', () => {
    for (const [group, , codes] of FACILITY_GROUPS) for (const code of codes) expect(defaultFacilityStock(group, code), code).not.toBeNull();
  });

  it('the defaults are the formulas the report used before', () => {
    const parts = (group: string, code: string) => STOCK_FORMULAS[defaultFacilityStock(group, code)!.formula].parts;
    expect(parts('D2C', 'HYP_SRGGN')).toEqual({ putaway: true, openPurchase: true, stockInTransfer: false, openSale: true });
    // the two D2C facilities that also count Stock In Transfer (any spelling)
    expect(parts('D2C', 'mcaff_mumbai2').stockInTransfer).toBe(true);
    expect(parts('D2C', 'mCaff_Gurgaon3').stockInTransfer).toBe(true);
    expect(parts('DarkStore', 'DS_NCR_PD_MOTHERHUB')).toEqual({ putaway: true, openPurchase: true, stockInTransfer: true, openSale: true });
    for (const g of ['GGNMWH', 'MUMMWH', 'KOLMWH']) expect(parts(g, 'X')).toEqual({ putaway: true, openPurchase: true, stockInTransfer: true, openSale: false });
    expect(parts('Return', 'Return_GGN')).toEqual({ putaway: false, openPurchase: false, stockInTransfer: false, openSale: false });
    // returned stock never counts in transit
    expect(defaultFacilityStock('Return', 'Return_GGN')?.feed).toBe('soh');
    expect(STOCK_BUCKETS.filter((b) => b.feed === 'soh').map((b) => b.group)).toEqual(['Return']);
    expect(defaultFacilityStock('NoSuchBucket', 'X')).toBeNull();
  });

  it('a stored setting wins over the bucket default, by lower-case code', () => {
    const ctx = new Context({ ...settings, facilityStock: { hyp_srggn: { feed: 'soh', formula: 'INV' } } });
    expect(ctx.stockOf('D2C', 'HYP_SRGGN')).toEqual({ feed: 'soh', formula: 'INV' });
    expect(ctx.stockOf('D2C', 'HYP_SRKOL')).toEqual({ feed: 'both', formula: 'INV_PP_OP_MINUS_OS' });
    expect(new Context(settings).stockOf('D2C', 'mCaff_Mumbai2')?.formula).toBe('INV_PP_OP_SIT_MINUS_OS');
  });
});
