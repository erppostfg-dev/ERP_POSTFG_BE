import os from 'os';
import { describe, expect, it } from 'vitest';
import { Context } from '../context';
import { Frame } from '../frame';
import { CHANNEL_MAPPING_MISSING, fillSheet35, findNewSkus, NEW_SKU_REASON, SkuReviewSettings } from '../sku-fill';

/* Missing Sheet35 values and new SKUs of a build (user, 2026-11-02). Uniware is not asked here (no login). */

const ctx = (): Context => new Context({ inputDir: os.tmpdir(), templateXlsx: '', outputDir: os.tmpdir(), asOf: '2026-11-02' }, () => undefined);
const settings = (over: Partial<SkuReviewSettings> = {}): SkuReviewSettings => ({
  pause: true, reviewed: [], uniware: null, cacheDir: os.tmpdir(),
  catalog: { known: { name: 'Known Lotion', mrp: 400 }, nomrp: { name: 'No MRP', mrp: null } },
  ...over,
});
const s35 = (rows: [string, string, string | number, string | number, string, number][]): Frame => Frame.from({
  'Split2 SKU': rows.map((r) => r[0]), 'SKU Name': rows.map((r) => r[1]), MRP: rows.map((r) => r[2]), 'COGS (With TAX)': rows.map((r) => r[3]),
  'Consider?': rows.map((r) => r[4]), 'Final Units': rows.map((r) => r[5]),
}, rows.length);

describe('fillSheet35', () => {
  it('blanks only: MRP / name from the product master, COGS = 20% of MRP; typed values stay', async () => {
    const df = s35([
      ['KNOWN', '', '', '', 'Yes', 10],
      ['TYPED', 'Typed', 300, 45, 'Yes', 5],
      ['MRPONLY', 'Has MRP', 250, '', 'Yes', 2],
      ['IGNORED', '', '', '', 'No', 9],
      ['ZERO', '', '', '', 'Yes', 0],
    ]);
    const { frame, fills } = await fillSheet35(ctx(), df, settings());
    expect(frame.get('MRP')).toEqual([400, 300, 250, '', '']);
    expect(frame.get('COGS (With TAX)')).toEqual([80, 45, 50, '', '']);
    expect(frame.get('SKU Name')).toEqual(['Known Lotion', 'Typed', 'Has MRP', '', '']);
    expect(fills).toEqual([
      { sku: 'KNOWN', name: 'Known Lotion', mrp: 400, cogs: 80, from: 'name:product master; mrp:product master; cogs:20% of MRP' },
      { sku: 'MRPONLY', cogs: 50, from: 'cogs:20% of MRP' },
    ]);
  });

  it('a SKU with no MRP anywhere keeps a blank COGS and is warned about', async () => {
    const c = ctx();
    const { frame } = await fillSheet35(c, s35([['NOMRP', '', '', '', 'Yes', 3]]), settings());
    expect(frame.get('COGS (With TAX)')).toEqual(['']);
    expect(c.warnings.join(' ')).toContain('still have no MRP');
  });
});

describe('findNewSkus', () => {
  const setFrames = (c: Context): void => {
    c.set('df_gap_sheet35', Frame.from({ 'Split2 SKU': ['NEW1', 'OLD1', 'NOUNITS'], 'Channel type': ['B2C', 'D2C', 'B2C'], 'Consider?': ['Yes', 'Yes', 'Yes'], 'Final Units': [12, 4, 0] }, 3));
    c.set('df_final_sku_not_mapped', Frame.from({ 'SKU Code': ['NEW1', 'known', 'NEVERSEEN'], 'SKU Name': ['', 'Known Lotion', 'Mystery'], 'Consider?': ['Yes', 'Yes', 'Yes'], 'Final Units': [12, 50, 7] }, 3));
    c.set('df_missing_items', Frame.from({
      'Missing Type': [CHANNEL_MAPPING_MISSING, CHANNEL_MAPPING_MISSING, 'Final Location Not Found (used Fulfilment Centre)'],
      'Channel SKU Code': ['FSN123', 'FSN123', 'X'], 'SKU Code': ['SELLER1', 'SELLER1', 'Y'], 'SKU Name': ['Gel', 'Gel', ''], 'Channel Name': ['Flipkart', 'Flipkart', 'Amazon'],
      'Channel type': ['B2C', 'B2C', 'B2C'], 'Total Units': [5, 3, 9],
    }, 3));
  };

  it('the three kinds, answered SKUs left out, most units first', () => {
    const c = ctx();
    setFrames(c);
    const list = findNewSkus(c, s35([['NEW1', 'New One', 199, 39.8, 'Yes', 12]]), settings({ reviewed: ['old1'] }));
    expect(list.map((n) => [n.kind, n.kind === 'code' ? `${n.channel} ${n.code}` : n.sku, n.units])).toEqual([
      ['sku', 'NEW1', 12],
      ['code', 'Flipkart FSN123', 8],
      ['sku', 'NEVERSEEN', 7],
    ]);
    expect(list[0]).toMatchObject({ name: 'New One', mrp: 199, cogs: 39.8, reasons: [NEW_SKU_REASON.NO_SHEET35, NEW_SKU_REASON.UNKNOWN] });
    expect(list[1]).toMatchObject({ sku: 'SELLER1', reasons: [NEW_SKU_REASON.NO_MAPPING] });
    expect(list[2]).toMatchObject({ name: 'Mystery', reasons: [NEW_SKU_REASON.UNKNOWN] });
  });

  it('confirmed combos, _S codes with no base mapping and locations with no Final Location are asked too', () => {
    const c = ctx();
    setFrames(c);
    c.set('df_gap_sheet35', Frame.empty(['Split2 SKU', 'Final Units']));
    c.set('df_final_sku_not_mapped', Frame.empty(['SKU Code', 'SKU Name', 'Consider?', 'Final Units']));
    c.set('df_final_sku_code_missing', Frame.from({
      'SKU Code': ['CMB9_S', 'CMB8_S'], 'SKU Name': ['Pack', 'Old'], 'Final SKU Code': ['CMB9', 'CMB8'], 'Consider?': ['Yes', 'No'], 'Final Units': [6, 4],
    }, 2));
    c.set('df_missing_items', Frame.from({
      'Missing Type': ['Myntra WH Location Not Found (used WH Id)', 'Final Location Not Found (used Fulfilment Centre)', 'Final Location Not Found (used Fulfilment Centre)'],
      'Channel SKU Code': ['a', 'b', 'c'], 'SKU Code': ['A', 'B', 'C'], 'SKU Name': ['', '', ''], 'Channel Name': ['Myntra', 'Myntra', 'Amazon'],
      'Fulfilment Centre': ['9999', '9999', 'XYZ1'], 'Channel type': ['B2C', 'B2C', 'B2C'], 'Total Units': [10, 10, 3],
    }, 3));
    const list = findNewSkus(c, s35([]), settings(), [
      { sku: 'CMB1', name: 'Combo', channelTypes: 'B2C', units: 20, foundBy: 'uniware', uniwareType: 'BUNDLE', components: [{ sku: 'P1', qty: 2 }] },
      { sku: 'CMB2', name: 'By code', channelTypes: 'B2C', units: 50, foundBy: 'code-only', uniwareType: 'unknown', components: [] },
    ]);
    expect(list.map((n) => [n.kind, n.kind === 'location' ? `${n.channel} ${n.code}` : n.sku, n.units])).toEqual([
      ['combo', 'CMB1', 20],
      ['location', 'Myntra 9999', 10], // listed under both missing types: counted once
      ['final-sku', 'CMB9_S', 6],
      ['location', 'Amazon XYZ1', 3],
    ]);
    expect(list[0].components).toEqual([{ sku: 'P1', qty: 2 }]);
    expect(list[2].base?.sku).toBe('CMB9');
  });
});
