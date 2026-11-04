import { describe, expect, it } from 'vitest';
import { D2C_STAGE, D2C_TAB } from '../../../constants';
import { createdRemark, editToken, EditableState, groupOfRemark, safeCell, sourceTag, statusTextsOf, tabsOf } from '../stage';
import { parseUpload, templateCsv, uploadKey } from '../upload.service';

/*
 * Pure rules: tab membership from facts (plan 1.3), status texts (1.5), the draft edit token (2.2), export escaping,
 * the upload file reader.
 */

describe('tab membership', () => {
  const base = { stage: D2C_STAGE.DRAFT, soState: null, openBalance: 10, invoices: [] };
  it('a draft is in Draft and Overview', () => {
    expect(tabsOf(base)).toEqual([D2C_TAB.DRAFT, D2C_TAB.OVERVIEW]);
    expect(tabsOf({ ...base, soState: 'failed' })).toEqual([D2C_TAB.DRAFT, D2C_TAB.OVERVIEW]);
  });

  it('an SO with an open balance is in Sale orders; not when cancelled or fully dispatched', () => {
    expect(tabsOf({ ...base, stage: D2C_STAGE.SALE_ORDER, soState: 'created' })).toEqual([D2C_TAB.SALE_ORDERS, D2C_TAB.OVERVIEW]);
    expect(tabsOf({ ...base, stage: D2C_STAGE.CANCELLED, soState: 'created' })).toEqual([D2C_TAB.OVERVIEW]);
    expect(tabsOf({ ...base, stage: D2C_STAGE.DISPATCHED, soState: 'created', openBalance: 0 })).toEqual([D2C_TAB.OVERVIEW]);
  });

  it('partly dispatched: Sale orders for the balance AND Create inward PO for the dispatched invoice', () => {
    const t = tabsOf({ stage: D2C_STAGE.PARTLY_DISPATCHED, soState: 'created', openBalance: 30, invoices: [{ dispatched: true, inwardPoState: null }] });
    expect(t).toEqual([D2C_TAB.SALE_ORDERS, D2C_TAB.CREATE_INWARD_PO, D2C_TAB.OVERVIEW]);
  });

  it('a failed inward PO goes back to Create inward PO; requested / created / unknown are in Inward POs until closed', () => {
    const inv = (inwardPoState: string | null) => ({ stage: D2C_STAGE.INWARD_PO_CREATED, soState: 'created', openBalance: 0, invoices: [{ dispatched: true, inwardPoState }] });
    expect(tabsOf(inv('failed'))).toEqual([D2C_TAB.CREATE_INWARD_PO, D2C_TAB.OVERVIEW]);
    for (const s of ['requested', 'created', 'unknown']) expect(tabsOf(inv(s))).toEqual([D2C_TAB.INWARD_POS, D2C_TAB.OVERVIEW]);
    expect(tabsOf({ ...inv('created'), stage: D2C_STAGE.CLOSED })).toEqual([D2C_TAB.OVERVIEW]);
    // an invoice not dispatched yet is in no inward-PO tab
    expect(tabsOf({ ...inv(null), invoices: [{ dispatched: false, inwardPoState: null }] })).toEqual([D2C_TAB.OVERVIEW]);
  });
});

describe('status texts', () => {
  it('as PEPIMS writes a transfer', () => {
    expect(statusTextsOf(D2C_STAGE.DRAFT)).toEqual({ statusPlanning: 'Confirmed', statusWarehouse: null, statusLogistics: null });
    expect(statusTextsOf(D2C_STAGE.CANCELLED)).toEqual({ statusPlanning: 'Cancelled', statusWarehouse: null, statusLogistics: null });
    expect(statusTextsOf(D2C_STAGE.PARTLY_DISPATCHED)).toEqual({ statusPlanning: 'Confirmed', statusWarehouse: 'Dispatched', statusLogistics: 'Internal Transfer' });
  });
});

describe('edit token', () => {
  const state: EditableState = {
    facilityId: 1, channel: 'McaffeineB2C', locationId: '10', poDate: '2026-11-05', priority: 'P2', type: 'Regular', expiry: '2026-11-20', remarks: null,
    lines: [{ id: '5', skuCode: 'A', qty: 10, updatedQty: 10 }, { id: '6', skuCode: 'B', qty: 3, updatedQty: 3 }],
  };
  it('is a stable sha256, whatever the line order', () => {
    expect(editToken(state)).toMatch(/^[0-9a-f]{64}$/);
    expect(editToken({ ...state, lines: [...state.lines].reverse() })).toBe(editToken(state));
    expect(editToken({ ...state, locationId: 10 as unknown as string })).toBe(editToken(state));
  });
  it('changes with any editable field or line', () => {
    const t = editToken(state);
    const variants: Partial<EditableState>[] = [
      { facilityId: 2 }, { channel: 'HYP_Website' }, { locationId: '11' }, { poDate: '2026-11-06' }, { priority: 'P1' }, { type: 'Internal' },
      { expiry: '2026-11-21' }, { remarks: 'x' }, { lines: [state.lines[0]] }, { lines: [state.lines[0], { ...state.lines[1], qty: 4 }] },
      { lines: [state.lines[0], { ...state.lines[1], updatedQty: 0 }] },
    ];
    for (const v of variants) expect(editToken({ ...state, ...v })).not.toBe(t);
  });
});

describe('small helpers', () => {
  it('export cells that start a formula get a quote; numbers stay numbers', () => {
    expect(safeCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(safeCell('+91')).toBe("'+91");
    expect(safeCell('-x')).toBe("'-x");
    expect(safeCell('@me')).toBe("'@me");
    expect(safeCell('Okhla Hub-939|05Nov2026|1')).toBe('Okhla Hub-939|05Nov2026|1');
    expect(safeCell(-5)).toBe(-5);
    expect(safeCell(null)).toBe('');
  });
  it('source tags', () => {
    expect([sourceTag('screen'), sourceTag('bulk_csv'), sourceTag('tool_api'), sourceTag('uniware'), sourceTag('system'), sourceTag('script')])
      .toEqual(['TOOL', 'TOOL', 'TOOL · API', 'UNIWARE', 'SYSTEM', 'SCRIPT']);
  });
  it('the group rides on the created remark', () => {
    expect(createdRemark('IT-2627-11-001', null)).toBe('IT-2627-11-001');
    expect(groupOfRemark(createdRemark('IT-2627-11-001', 'BOGO | 1'))).toBe('BOGO | 1');
    expect(groupOfRemark('IT-2627-11-001')).toBeNull();
  });
});

describe('upload file', () => {
  const file = (text: string, name = 'transfers.csv') => ({ originalname: name, buffer: Buffer.from(text, 'utf8') });
  const HEAD = 'Channel,Location,PO Date,PO Number,Sr/ No,SKU Name,SKU Code,Channel SKU Code,Qty,GMV,PO Value,Dispatch Location,Priority,Group,Type,PO Expiry Date';

  it('the template is the PEPIMS columns + ours', () => {
    expect(templateCsv()).toBe('Channel,Location,PO Date,PO Number,Sr No,SKU Name,SKU Code,Channel SKU Code,Qty,GMV,PO Value,Dispatch Location,Priority,Group,Type,PO Expiry Date,Uniware Channel\r\n');
  });

  it('reads rows by header name (any case / punctuation, BOM, extra columns), row = file line', () => {
    const rows = parseUpload(file(`${String.fromCharCode(0xfeff)}${HEAD},Extra\r\nMcaffeineB2C,Kolkata3,05-11-2026,IGNORED,1,"Scrub, 100g",MCAFF_A,X,10,1,1,MUM_WAREHOUSE2,P1,G1,Internal,2026-11-30,zz\r\n`));
    expect(rows).toEqual([{
      row: 2, channel: 'McaffeineB2C', location: 'Kolkata3', poDate: '05-11-2026', sender: 'MUM_WAREHOUSE2', priority: 'P1', group: 'G1', type: 'Internal',
      expiry: '2026-11-30', skuCode: 'MCAFF_A', skuName: 'Scrub, 100g', qty: '10', uniwareChannel: '',
    }]);
    const lower = parseUpload(file('channel,LOCATION,po date,sku code,QTY,dispatch location\nMcaffeineB2C,Kolkata3,2026-11-05,A,1,W\n'));
    expect(lower[0]).toMatchObject({ priority: '', group: '', type: '', expiry: '', skuName: '' });
    // the optional Uniware Channel column (a route with 2+ Uniware channels, 2026-11-03)
    expect(parseUpload(file('Channel,Location,PO Date,SKU Code,Qty,Dispatch Location,uniware channel\nM,K,2026-11-05,A,1,W,D2C_TRANSFER_HYP_L\n'))[0].uniwareChannel).toBe('D2C_TRANSFER_HYP_L');
  });

  it('refuses a non-CSV, missing required columns, no rows, too many rows', () => {
    expect(() => parseUpload(file(HEAD, 'transfers.xlsx'))).toThrow('is not a .csv file');
    expect(() => parseUpload(undefined)).toThrow('send the .csv file');
    expect(() => parseUpload(file('Channel,Location,PO Date,SKU Code,Qty\nA,B,C,D,1\n'))).toThrow('missing column(s): Dispatch Location');
    expect(() => parseUpload(file(`${HEAD}\n`))).toThrow('the file has no rows');
    const many = `${HEAD}\n${Array.from({ length: 5001 }, () => 'McaffeineB2C,K,2026-11-05,,,,A,,1,,,W,,,,').join('\n')}\n`;
    expect(() => parseUpload(file(many))).toThrow('5001 rows: at most 5000 per file');
  });

  it('S3 key of the file', () => {
    expect(uploadKey('b1', 'My file (1).csv', new Date('2026-11-03T10:00:00Z'))).toBe('d2c-transfers/uploads/2026/11/b1-My_file_1_.csv');
  });
});
