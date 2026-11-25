import { describe, expect, it } from 'vitest';
import { parseRoutesUpload, planRoutesUpload, RouteUploadRow, UploadMasters } from '../transfer-routes-upload';

const masters = (over: Partial<UploadMasters> = {}): UploadMasters => ({
  facilities: [
    { id: 1, code: 'MUM_WAREHOUSE2', aliases: [], allowInternalTransfer: true },
    { id: 2, code: 'GGN_WAREHOUSE', aliases: [], allowInternalTransfer: true },
    { id: 3, code: 'KOL_WAREHOUSE', aliases: [], allowInternalTransfer: false },
  ],
  channels: [{ id: 10, displayName: 'McaffeineB2C', slug: 'mcaffeineb2c', aliases: [] }],
  locations: [
    { id: '100', channelId: 10, channelName: 'McaffeineB2C', locationCode: 'Ahmedabad', receivingId: 2, receivingCode: 'GGN_WAREHOUSE', isActive: true },
    { id: '101', channelId: 10, channelName: 'McaffeineB2C', locationCode: 'Kolkata', receivingId: 3, receivingCode: 'KOL_WAREHOUSE', isActive: true },
    { id: '102', channelId: 10, channelName: 'McaffeineB2C', locationCode: 'Pune', receivingId: null, receivingCode: null, isActive: true },
  ],
  routes: [
    { id: 7, senderId: 1, locationId: '100', uniwareChannelCode: 'D2C_TRANSFER_MCAFF', customerCode: 'CUST_A', customerName: 'A', vendorCode: null, isActive: true },
  ],
  testFacilities: null,
  ...over,
});
const row = (over: Partial<RouteUploadRow> = {}): RouteUploadRow => ({
  row: 2, sender: 'MUM_WAREHOUSE2', channel: 'McaffeineB2C', location: 'Ahmedabad', uniwareChannel: 'D2C_TRANSFER_MCAFF',
  customerCode: '', customerName: '', vendorCode: '', active: '', ...over,
});

describe('transfer routes upload: plan', () => {
  it('same key: only filled cells that differ change; empty keeps', () => {
    const p = planRoutesUpload([row({ vendorCode: 'V1', customerCode: 'CUST_A' })], masters());
    expect(p.rows[0]).toMatchObject({ action: 'update', routeId: 7, changes: [{ field: 'vendorCode', old: null, value: 'V1' }] });
    expect(planRoutesUpload([row({ customerCode: 'CUST_A' })], masters()).rows[0].action).toBe('same');
  });

  it('the only route of a sender + location takes the new Uniware channel', () => {
    const p = planRoutesUpload([row({ uniwareChannel: 'D2C_TRANSFER_MCAFF_L' })], masters());
    expect(p.rows[0]).toMatchObject({ action: 'update', routeId: 7, changes: [{ field: 'uniwareChannelCode', old: 'D2C_TRANSFER_MCAFF', value: 'D2C_TRANSFER_MCAFF_L' }] });
  });

  it('two rows of one sender + location with new channels: both new (no guessing)', () => {
    const p = planRoutesUpload([row({ uniwareChannel: 'X1' }), row({ row: 3, uniwareChannel: 'X2' })], masters());
    expect(p.rows.map((r) => r.action)).toEqual(['new', 'new']);
  });

  it('new route: switches on a warehouse not allowed internal transfers', () => {
    const p = planRoutesUpload([row({ location: 'kolkata', vendorCode: 'V9' })], masters());
    expect(p.rows[0]).toMatchObject({ action: 'new', location: 'Kolkata', receiving: 'KOL_WAREHOUSE' });
    expect(p.enable).toEqual([{ id: 3, code: 'KOL_WAREHOUSE' }]);
  });

  it('a new route switched off does not switch warehouses on', () => {
    expect(planRoutesUpload([row({ location: 'Kolkata', active: 'No' })], masters()).enable).toEqual([]);
  });

  it('refuses: not a transfer location, unknown sender, sender = receiver, bad Active, duplicates', () => {
    const p = planRoutesUpload([
      row({ location: 'Pune' }),
      row({ row: 3, sender: 'NOPE' }),
      row({ row: 4, sender: 'GGN_WAREHOUSE' }),
      row({ row: 5, active: 'maybe' }),
      row({ row: 6, location: 'Kolkata', uniwareChannel: 'Z' }), row({ row: 7, location: 'Kolkata', uniwareChannel: 'z' }),
    ], masters());
    expect(p.rows.map((r) => r.action)).toEqual(['error', 'error', 'error', 'error', 'error', 'error']);
    expect(p.rows[0].errors[0]).toMatch(/not a transfer location/);
    expect(p.rows[4].errors[0]).toMatch(/rows 6, 7/);
  });

  it('test mode: only routes between test warehouses', () => {
    const p = planRoutesUpload([row()], masters({ testFacilities: ['TEST_FACILITY'] }));
    expect(p.rows[0].errors[0]).toMatch(/Test mode/);
  });

  it('Active No on an active route switches it off', () => {
    expect(planRoutesUpload([row({ active: 'no' })], masters()).rows[0].changes).toEqual([{ field: 'isActive', old: 'Yes', value: 'No' }]);
  });
});

describe('transfer routes upload: file', () => {
  const file = (text: string, name = 'r.csv') => ({ originalname: name, buffer: Buffer.from(text, 'utf8') });
  it('reads the columns by name (BOM, spacing and case ignored)', () => {
    const rows = parseRoutesUpload(file('﻿sender,CHANNEL,Location,Uniware channel,Vendor Code\nMUM_WAREHOUSE2,McaffeineB2C,Ahmedabad,D2C,V1\n'));
    expect(rows).toEqual([{ row: 2, sender: 'MUM_WAREHOUSE2', channel: 'McaffeineB2C', location: 'Ahmedabad', uniwareChannel: 'D2C', customerCode: '', customerName: '', vendorCode: 'V1', active: '' }]);
  });
  it('refuses a missing column, an xlsx and an empty file', () => {
    expect(() => parseRoutesUpload(file('Sender,Channel,Location\nA,B,C\n'))).toThrow(/Uniware Channel/);
    expect(() => parseRoutesUpload(file('x', 'r.xlsx'))).toThrow(/not a .csv/);
    expect(() => parseRoutesUpload(file('Sender,Channel,Location,Uniware Channel\n'))).toThrow(/no rows/);
  });
});
