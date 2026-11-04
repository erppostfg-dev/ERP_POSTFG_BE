import { describe, expect, it } from 'vitest';
import { D2C_DEFAULT_SETTINGS } from '../../../constants';
import { D2cMasters, findFacility, openKey, pickRoute, pricesOf, RawRow, RouteM, validateRows } from '../validate';

/*
 * The shared transfer checks (validate.ts) against a small in-memory masters snapshot: every rule of plan 5.0 / the
 * PRD table, the defaults, grouping, merging and the location resolution of plan 2.5.
 */

const masters = (over: Partial<D2cMasters> = {}): D2cMasters => ({
  settings: { ...D2C_DEFAULT_SETTINGS },
  today: '2026-11-03',
  facilities: [
    { id: 1, code: 'MUM_WAREHOUSE2', name: 'Mumbai main', isActive: true, allowTransfer: true, aliases: [] },
    { id: 6, code: 'MUM_Warehouse2', name: 'Mumbai child', isActive: true, allowTransfer: true, aliases: [] },
    { id: 2, code: 'mCaff_Kolkata3', name: 'Kolkata 3', isActive: true, allowTransfer: true, aliases: ['Mcaff_kolkata3_old'] },
    { id: 3, code: 'mCaff_Hyderabad2', name: 'Hyderabad 2', isActive: true, allowTransfer: true, aliases: [] },
    { id: 4, code: 'OLD_WH', name: 'old', isActive: false, allowTransfer: true, aliases: [] },
    { id: 5, code: 'NA_WH', name: 'not allowed', isActive: true, allowTransfer: false, aliases: [] },
  ],
  locations: [
    { id: '10', channel: 'McaffeineB2C', code: 'Kolkata3', facilityId: 2, prefix: 'mCaff_Kolkata3', isActive: true, channelCategory: 'D2C' },
    { id: '11', channel: 'McaffeineB2C', code: 'Hyderabad', facilityId: 3, prefix: 'Mcaff_Hyd', isActive: true, channelCategory: 'D2C' },
    { id: '12', channel: 'McaffeineB2C', code: 'Hyderabad2', facilityId: 3, prefix: 'Mcaff_Hyd2', isActive: true, channelCategory: 'D2C' },
    { id: '13', channel: 'HYP_Website', code: 'Kolkata', facilityId: 2, prefix: null, isActive: true, channelCategory: 'D2C' },
    { id: '14', channel: 'McaffeineB2C', code: 'Closed', facilityId: 2, prefix: 'X', isActive: false, channelCategory: 'D2C' },
    { id: '15', channel: 'McaffeineB2C', code: 'Mumbai', facilityId: 1, prefix: 'Mcaff_Mum', isActive: true, channelCategory: 'D2C' },
    { id: '16', channel: 'McaffeineB2C', code: 'NoRecv', facilityId: 5, prefix: 'Mcaff_Na', isActive: true, channelCategory: 'D2C' },
  ],
  routes: [
    { id: 1, senderId: 1, locationId: '10', isActive: true, uniwareChannelCode: 'D2C_TRANSFER_MCAFF', customerCode: 'MCAFF_KOL3', vendorCode: 'V_MUM' },
    { id: 2, senderId: 1, locationId: '11', isActive: true, uniwareChannelCode: 'D2C_TRANSFER_MCAFF', customerCode: 'MCAFF_HYD', vendorCode: null },
    { id: 3, senderId: 1, locationId: '12', isActive: true, uniwareChannelCode: 'D2C_TRANSFER_MCAFF', customerCode: 'MCAFF_HYD2', vendorCode: 'V' },
    { id: 4, senderId: 6, locationId: '10', isActive: false, uniwareChannelCode: 'X', customerCode: 'X', vendorCode: 'X' },
    { id: 5, senderId: 1, locationId: '15', isActive: true, uniwareChannelCode: 'X', customerCode: 'X', vendorCode: 'X' },
    { id: 6, senderId: 1, locationId: '16', isActive: true, uniwareChannelCode: 'X', customerCode: 'X', vendorCode: 'X' },
    { id: 7, senderId: 1, locationId: '13', isActive: true, uniwareChannelCode: 'X', customerCode: 'X', vendorCode: 'X' },
  ],
  skus: new Map([
    ['mcaff_a', { code: 'MCAFF_A', name: 'Coffee Body Scrub 100g', mrp: 499, isActive: true, productType: 'Main Unit', brand: 'mCaffeine' }],
    ['mcaff_b', { code: 'MCAFF_B', name: 'Coffee Face Wash', mrp: 349, isActive: true, productType: null, brand: 'HYPHEN' }],
    ['combo_1', { code: 'COMBO_1', name: 'Kit', mrp: 999, isActive: true, productType: 'Combo', brand: 'mCaffeine' }],
    ['inactive_1', { code: 'INACTIVE_1', name: 'Old', mrp: 100, isActive: false, productType: null, brand: null }],
    ['nullactive', { code: 'NULLACTIVE', name: 'Unknown', mrp: 100, isActive: null, productType: null, brand: null }],
    ['nomrp_1', { code: 'NOMRP_1', name: 'No MRP', mrp: null, isActive: true, productType: null, brand: null }],
  ]),
  open: new Map(),
  ...over,
});

const row = (over: Partial<RawRow> = {}, n = 2): RawRow => ({
  row: n, channel: 'McaffeineB2C', location: 'Kolkata3', poDate: '2026-11-05', sender: 'MUM_WAREHOUSE2', priority: '', group: '', type: '',
  expiry: '', skuCode: 'MCAFF_A', skuName: '', qty: '10', ...over,
});

const errorsOf = (rows: RawRow[], m = masters()) => validateRows(rows, m).rows.flatMap((r) => r.errors.map((e) => e.message));
const warningsOf = (rows: RawRow[], m = masters()) => validateRows(rows, m).rows.flatMap((r) => r.warnings.map((e) => e.message));

describe('validateRows: a clean transfer', () => {
  it('two SKUs of the same lane, date, priority, type make one transfer with defaults and prices', () => {
    const out = validateRows([row(), row({ skuCode: 'mcaff_b', qty: '3' }, 3)], masters());
    expect(out.errorCount).toBe(0);
    expect(out.canImport).toBe(true);
    expect(out.transfers).toHaveLength(1);
    const t = out.transfers[0];
    expect(t).toMatchObject({
      senderId: 1, senderCode: 'MUM_WAREHOUSE2', channel: 'McaffeineB2C', locationId: '10', location: 'Kolkata3', receivingId: 2,
      receivingCode: 'mCaff_Kolkata3', prefix: 'mCaff_Kolkata3', poDate: '2026-11-05', priority: 'P2', type: 'Regular', expiry: '2026-11-20',
      totalUnits: 13, rows: [2, 3], valid: true, route: { id: 1, customerCode: 'MCAFF_KOL3', vendorCode: 'V_MUM' },
    });
    expect(t.lines).toEqual([
      { skuCode: 'MCAFF_A', skuName: 'Coffee Body Scrub 100g', brand: 'MCaffeine', qty: 10, mrp: 499, gmv: 4990, poValue: 748.5, rows: [2] },
      { skuCode: 'MCAFF_B', skuName: 'Coffee Face Wash', brand: 'Hyphen', qty: 3, mrp: 349, gmv: 1047, poValue: 157.05, rows: [3] },
    ]);
  });

  it('GMV = MRP x qty, PO value = 15% of MRP x qty', () => {
    expect(pricesOf(499, 10)).toEqual({ gmv: 4990, poValue: 748.5 });
    expect(pricesOf(333, 7)).toEqual({ gmv: 2331, poValue: 349.65 });
  });

  it('accepts DD-MM-YYYY, lower-case priority / type / channel, and an explicit expiry', () => {
    const out = validateRows([row({ poDate: '05-11-2026', priority: 'p1', type: 'internal', channel: 'mcaffeineb2c', expiry: '30-11-2026' })], masters());
    expect(out.errorCount).toBe(0);
    expect(out.transfers[0]).toMatchObject({ poDate: '2026-11-05', priority: 'P1', type: 'Internal', channel: 'McaffeineB2C', expiry: '2026-11-30' });
  });

  it('uses settings.defaultExpiryDays', () => {
    const m = masters();
    m.settings.defaultExpiryDays = 7;
    expect(validateRows([row()], m).transfers[0].expiry).toBe('2026-11-12');
  });
});

describe('validateRows: errors', () => {
  it.each([
    [{ channel: 'Amazon' }, 'Amazon is not a transfer channel'],
    [{ channel: '' }, 'Channel is required'],
    [{ sender: 'NOPE' }, 'Dispatch facility NOPE not found'],
    [{ sender: '' }, 'Dispatch Location is required'],
    [{ sender: 'OLD_WH' }, 'Dispatch facility OLD_WH is inactive'],
    [{ sender: 'NA_WH' }, 'not allowed for internal transfers'],
    [{ location: 'Nowhere' }, 'Nowhere is not a transfer location of McaffeineB2C'],
    [{ location: 'Closed' }, 'is inactive'],
    [{ location: 'Mumbai' }, 'Dispatch and receiving facility are the same'],
    [{ location: 'NoRecv' }, 'Receiving facility NA_WH is not allowed'],
    [{ sender: 'MUM_Warehouse2' }, 'is switched off'],
    [{ sender: 'mCaff_Hyderabad2' }, 'No transfer route mCaff_Hyderabad2 -> McaffeineB2C / Kolkata3'],
    [{ poDate: '' }, 'PO Date is required'],
    [{ poDate: '2026-02-30' }, 'PO Date 2026-02-30 is not a date'],
    [{ poDate: '11/05/2026' }, 'is not a date'],
    [{ priority: 'P4' }, 'Priority P4 must be P1, P2 or P3'],
    [{ type: 'Gift' }, 'Type Gift must be one of Regular, Internal, Freebee'],
    [{ expiry: '2026-11-01' }, 'is before the PO date'],
    [{ expiry: 'soon' }, 'PO Expiry Date soon is not a date'],
    [{ skuCode: '' }, 'SKU Code is required'],
    [{ skuCode: 'UNKNOWN' }, 'SKU UNKNOWN is not in the SKU master'],
    [{ skuCode: 'INACTIVE_1' }, 'SKU INACTIVE_1 is inactive'],
    [{ skuCode: 'NULLACTIVE' }, 'SKU NULLACTIVE is inactive'],
    [{ skuCode: 'COMBO_1' }, 'is a combo: transfer its components'],
    [{ skuCode: 'NOMRP_1' }, 'has no MRP'],
    [{ qty: '' }, 'Qty is required'],
    [{ qty: '0' }, 'must be a whole number above 0'],
    [{ qty: '-2' }, 'must be a whole number above 0'],
    [{ qty: '2.5' }, 'must be a whole number above 0'],
    [{ qty: 'ten' }, 'must be a whole number above 0'],
    [{ qty: '20000000' }, 'is above'],
  ])('%o -> %s', (over, message) => {
    const errors = errorsOf([row(over)]);
    expect(errors.join(' | ')).toContain(message);
    expect(validateRows([row(over as Partial<RawRow>)], masters()).canImport).toBe(false);
  });

  it('a location without a PO prefix is refused (the reference ID needs it)', () => {
    expect(errorsOf([row({ channel: 'HYP_Website', location: 'Kolkata' })]).join(' ')).toContain('has no PO number prefix');
  });

  it('rows of one Group must agree on the header; one bad row blocks the whole import', () => {
    const out = validateRows([row({ group: 'G1' }), row({ group: 'g1', priority: 'P1', skuCode: 'MCAFF_B' }, 3), row({ location: 'Hyderabad2' }, 4)], masters());
    expect(out.rows[1].errors.map((e) => e.message)).toEqual(['Group G1: Priority differs from row 2']);
    expect(out.transfers).toHaveLength(2);
    expect(out.transfers[0].valid).toBe(false);
    expect(out.transfers[1].valid).toBe(true);
    expect(out.canImport).toBe(false);
  });
});

describe('validateRows: warnings and merging', () => {
  it('a SKU twice in a transfer is merged (qty summed) with a warning', () => {
    const out = validateRows([row(), row({ qty: '5' }, 3)], masters());
    expect(out.transfers[0].lines).toHaveLength(1);
    expect(out.transfers[0].lines[0]).toMatchObject({ qty: 15, gmv: 7485, rows: [2, 3] });
    expect(out.rows[1].warnings[0].message).toBe('SKU MCAFF_A is already on row 2 of this transfer: quantities added');
    expect(out.canImport).toBe(true);
  });

  it('a different SKU name only warns; the master name is used', () => {
    const out = validateRows([row({ skuName: 'coffee  body scrub 100G' }), row({ skuName: 'Some other name', skuCode: 'MCAFF_B' }, 3)], masters());
    expect(out.rows[0].warnings).toEqual([]);
    expect(out.rows[1].warnings[0].message).toContain('SKU name differs');
    expect(out.transfers[0].lines[1].skuName).toBe('Coffee Face Wash');
  });

  it('a route without a vendor code warns (inward PO blocked), not an error', () => {
    const out = validateRows([row({ location: 'Hyderabad' })], masters());
    expect(out.errorCount).toBe(0);
    expect(out.rows[0].warnings.map((w) => w.message)).toEqual(['Route MUM_WAREHOUSE2 -> McaffeineB2C / Hyderabad has no vendor code: the inward PO is blocked until it is filled']);
  });

  it('the same lane + SKU in an open transfer not dispatched yet warns', () => {
    const m = masters({ open: new Map([[openKey(1, 2, 'MCAFF_A'), ['IT-2627-11-001']]]) });
    expect(warningsOf([row()], m)).toEqual(['SKU MCAFF_A is already in open transfer IT-2627-11-001 on this lane (not dispatched yet)']);
    expect(warningsOf([row({ skuCode: 'MCAFF_B' })], m)).toEqual([]);
  });
});

describe('grouping', () => {
  it('without a Group: rows split by sender, location, channel, date, priority, type, expiry (in order of appearance)', () => {
    const out = validateRows([
      row(), row({ priority: 'P1' }, 3), row({ skuCode: 'MCAFF_B' }, 4), row({ type: 'Freebee' }, 5), row({ poDate: '2026-11-06' }, 6),
      row({ expiry: '2026-12-01' }, 7), row({ location: 'Hyderabad2' }, 8),
    ], masters());
    expect(out.transfers.map((t) => t.rows)).toEqual([[2, 4], [3], [5], [6], [7], [8]]);
  });

  it('a Group joins rows into one transfer, case-insensitively, separate from ungrouped rows', () => {
    const out = validateRows([row({ group: 'A' }), row({}, 3), row({ group: 'a', skuCode: 'MCAFF_B' }, 4)], masters());
    expect(out.transfers.map((t) => [t.group, t.rows])).toEqual([['A', [2, 4]], [null, [3]]]);
  });
});

describe('location resolution (plan 2.5)', () => {
  it('by short name, else by receiving facility code or alias', () => {
    for (const location of ['Kolkata3', 'kolkata3', 'mCaff_Kolkata3', 'Mcaff_kolkata3_old']) {
      expect(validateRows([row({ location })], masters()).transfers[0].locationId).toBe('10');
    }
  });

  it('a facility code with two locations: the one with an active route, else an error naming both', () => {
    expect(errorsOf([row({ location: 'mCaff_Hyderabad2' })]).join(' ')).toContain('matches several McaffeineB2C locations (Hyderabad, Hyderabad2)');
    const m = masters();
    m.routes = m.routes.filter((r) => r.locationId !== '11');
    expect(validateRows([row({ location: 'mCaff_Hyderabad2' })], m).transfers[0].locationId).toBe('12');
  });

  it('the form passes ids instead of names', () => {
    const out = validateRows([row({ sender: '', senderId: 1, location: '', locationId: '12' })], masters());
    expect(out.errorCount).toBe(0);
    expect(out.transfers[0]).toMatchObject({ senderId: 1, locationId: '12', prefix: 'Mcaff_Hyd2' });
    expect(errorsOf([row({ locationId: '13' })]).join(' ')).toContain('Location id 13 is not a transfer location of McaffeineB2C');
  });

  it('facility codes are case-sensitive: an exact code wins, a case-insensitive one only when unique', () => {
    const f = masters().facilities;
    expect(findFacility(f, 'MUM_Warehouse2').facility?.id).toBe(6);
    expect(findFacility(f, 'mum_warehouse2').ambiguous).toEqual(['MUM_WAREHOUSE2', 'MUM_Warehouse2']);
    expect(findFacility(f, 'MCAFF_KOLKATA3').facility?.id).toBe(2);
  });
});

describe('a route with 2+ Uniware channels (2026-11-03, "Updated route sheet")', () => {
  const r = (id: number, ch: string | null, isActive = true): RouteM =>
    ({ id, senderId: 1, locationId: '10', isActive, uniwareChannelCode: ch, customerCode: 'C', vendorCode: 'V' });
  const two = [r(21, 'D2C_TRANSFER_MCAFF_L'), r(22, 'D2C_TRANSFER_HYP_L')];
  const lane = 'MUM_WAREHOUSE2 -> McaffeineB2C / Kolkata3';

  it('pickRoute: one active route needs no choice; a wrong one is refused', () => {
    expect(pickRoute([r(1, 'A'), r(2, 'B', false)], {}, lane)).toMatchObject({ route: { id: 1 }, error: null, channels: ['A'] });
    expect(pickRoute([r(1, 'A')], { uniwareChannel: ' a ' }, lane).route?.id).toBe(1);
    expect(pickRoute([r(1, 'A')], { uniwareChannel: 'B' }, lane)).toMatchObject({ route: null, field: 'uniwareChannel' });
  });
  it('pickRoute: 2+ active channels need the route id or the Uniware channel (no case)', () => {
    expect(pickRoute(two, {}, lane)).toMatchObject({
      route: null, field: 'uniwareChannel', error: `Route ${lane} has 2 Uniware channels (D2C_TRANSFER_MCAFF_L, D2C_TRANSFER_HYP_L): fill Uniware Channel`,
    });
    expect(pickRoute(two, { uniwareChannel: 'd2c_transfer_hyp_l' }, lane).route?.id).toBe(22);
    expect(pickRoute(two, { routeId: 21 }, lane).route?.id).toBe(21);
    expect(pickRoute(two, { routeId: 99 }, lane).error).toContain('route id 99 is not one of the Uniware channels');
    expect(pickRoute(two, { uniwareChannel: 'MWH_TRANSFER' }, lane).error).toContain('Uniware Channel MWH_TRANSFER is not one of');
  });
  it('pickRoute: a switched-off channel does not count; none / all off = location error', () => {
    expect(pickRoute([r(21, 'A'), r(22, 'B', false)], {}, lane).route?.id).toBe(21);
    expect(pickRoute([], {}, lane)).toMatchObject({ field: 'location', error: `No transfer route ${lane}: add it in Masters` });
    expect(pickRoute([r(21, 'A', false)], {}, lane)).toMatchObject({ field: 'location', error: `Transfer route ${lane} is switched off` });
  });

  const m2 = () => masters({ routes: [...masters().routes.filter((x) => x.id !== 1), { ...two[0], id: 1 }, two[1]] });
  it('validateRows: the upload row must fill Uniware Channel; the chosen route is kept on the transfer', () => {
    expect(errorsOf([row()], m2())).toEqual([`Route ${lane} has 2 Uniware channels (D2C_TRANSFER_MCAFF_L, D2C_TRANSFER_HYP_L): fill Uniware Channel`]);
    const out = validateRows([row({ uniwareChannel: 'D2C_TRANSFER_HYP_L' })], m2());
    expect(out.errorCount).toBe(0);
    expect(out.transfers[0]).toMatchObject({ route: { id: 22, uniwareChannelCode: 'D2C_TRANSFER_HYP_L' }, routeChannels: ['D2C_TRANSFER_MCAFF_L', 'D2C_TRANSFER_HYP_L'] });
    expect(validateRows([row({ routeId: 1 })], m2()).transfers[0].route?.id).toBe(1);
  });
  it('validateRows: rows of one lane with two channels make two transfers; a Group must agree on it', () => {
    const out = validateRows([row({ uniwareChannel: 'D2C_TRANSFER_HYP_L' }), row({ uniwareChannel: 'D2C_TRANSFER_MCAFF_L' }, 3)], m2());
    expect(out.transfers.map((t) => t.route?.id)).toEqual([22, 1]);
    const g = validateRows([row({ group: 'G', uniwareChannel: 'D2C_TRANSFER_HYP_L' }), row({ group: 'G', uniwareChannel: 'D2C_TRANSFER_MCAFF_L' }, 3)], m2());
    expect(g.rows[1].errors.map((e) => e.message)).toEqual(['Group G: Uniware Channel differs from row 2']);
  });
});

describe('validateRows: test facilities and local test mode', () => {
  const withTest = (over: Partial<D2cMasters> = {}) => {
    const m = masters();
    return masters({
      facilities: [...m.facilities, { id: 20, code: 'TEST_FACILITY', name: 'Test', isActive: true, allowTransfer: true, aliases: [] }],
      locations: [...m.locations, { id: '20', channel: 'McaffeineB2C', code: 'TEST', facilityId: 20, prefix: 'TEST_FACILITY', isActive: true, channelCategory: 'D2C' }],
      routes: [
        ...m.routes,
        { id: 20, senderId: 20, locationId: '20', isActive: true, uniwareChannelCode: 'mCaff_Test', customerCode: 'Test_Channel', vendorCode: 'Test_Vendor' },
        { id: 21, senderId: 20, locationId: '10', isActive: true, uniwareChannelCode: 'mCaff_Test', customerCode: 'Test_Channel', vendorCode: 'Test_Vendor' },
        { id: 22, senderId: 1, locationId: '20', isActive: true, uniwareChannelCode: 'X', customerCode: 'X', vendorCode: 'X' },
      ],
      ...over,
    });
  };
  const testRow = (over: Partial<RawRow> = {}) => row({ sender: 'TEST_FACILITY', location: 'TEST', uniwareChannel: '', ...over });

  it('sender = receiving is allowed for a test facility only', () => {
    expect(errorsOf([testRow()], withTest())).toEqual([]);
    expect(errorsOf([row({ location: 'Mumbai' })], withTest())).toContain('Dispatch and receiving facility are the same (MUM_WAREHOUSE2)');
  });
  it('local test mode: test lane ok; a real sender or receiving facility is refused', () => {
    const m = withTest({ testOnly: true });
    expect(errorsOf([testRow()], m)).toEqual([]);
    const real = errorsOf([row()], m);
    expect(real.some((e) => e.startsWith('local test mode: only transfers between test facilities') && e.includes('MUM_WAREHOUSE2, mCaff_Kolkata3'))).toBe(true);
    expect(errorsOf([testRow({ location: 'Kolkata3' })], m).some((e) => e.includes('mCaff_Kolkata3 is a real facility'))).toBe(true);
    expect(errorsOf([row({ location: 'TEST' })], m).some((e) => e.includes('MUM_WAREHOUSE2 is a real facility'))).toBe(true);
    expect(validateRows([row()], m).canImport).toBe(false);
  });
  it('off: real lanes keep working', () => {
    expect(errorsOf([row()], withTest({ testOnly: false }))).toEqual([]);
  });
});
