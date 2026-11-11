import { describe, expect, it } from 'vitest';
import {
  buildRoutes, Channel, ChannelSheetRow, choosePrefix, ExistingRoute, Facility, facilitiesInRoutes, facilityMatcher, findChannel, matchFacility,
  multiChannelRoutes, planLocations, planRouteUpserts, poPrefixOf, prefixesByLocation, VendorSheetRow,
} from '../d2c-routes-load';

/* npm run d2c:routes-load, the pure part (2026-11-03): facility codes, PEPIMS prefixes, locations and routes. No DB. */

const FACILITIES: Facility[] = [
  { id: 1, code: 'MUM_WAREHOUSE2', aliases: [] },
  { id: 2, code: 'MUM_Warehouse2', aliases: [] },
  { id: 3, code: 'KOL_WAREHOUSE', aliases: [] },
  { id: 4, code: 'mCaff_Ahmedabad', aliases: ['mCaff_ Ahmedabad'] },
  { id: 5, code: 'mCaff_Kolkata3', aliases: [] },
  { id: 6, code: 'mCaff_Hyderabad2', aliases: [] },
  { id: 7, code: 'mCaff_Hyderabad3', aliases: [] },
  { id: 8, code: 'GGN_WAREHOUSE', aliases: [] },
  { id: 9, code: 'GGN_warehouse', aliases: [] },
];
const CHANNELS: Channel[] = [
  { id: 43, displayName: 'McaffeineB2C', slug: 'mcaffeine-b2c', aliases: ['McaffeineB2C', 'mcaffeine-b2c'] },
  { id: 47, displayName: 'KOL_WAREHOUSE', slug: 'kol-warehouse', aliases: ['KOL_WAREHOUSE', 'kol-warehouse'] },
];
const MAPPING = {
  McaffeineB2C: { Kolkata3: 'mCaff_Kolkata3', Hyderabad3: 'mCaff_Hyderabad3', Ahmedabad: 'mCaff_Ahmedabad' },
  KOL_WAREHOUSE: { Kolkata_MH: 'KOL_WAREHOUSE' },
};

describe('facility codes', () => {
  it('exact code first: upper / lower case are different facilities', () => {
    expect(matchFacility('MUM_WAREHOUSE2', FACILITIES)).toMatchObject({ id: 1, how: 'exact' });
    expect(matchFacility('MUM_Warehouse2', FACILITIES)).toMatchObject({ id: 2, how: 'exact' });
  });
  it('then an exact alias, then case-insensitive only when it names one facility', () => {
    expect(matchFacility('mCaff_ Ahmedabad', FACILITIES)).toMatchObject({ id: 4, code: 'mCaff_Ahmedabad', how: 'alias' });
    expect(matchFacility('kOL_WAREHOUSE', FACILITIES)).toMatchObject({ id: 3, how: 'case' });
    expect(matchFacility('Mcaff_kolkata3', FACILITIES)).toMatchObject({ id: 5, how: 'case' });
    expect(matchFacility(' KOL_WAREHOUSE ', FACILITIES)).toMatchObject({ id: 3, how: 'exact' });
  });
  it('ambiguous or unknown codes are not guessed', () => {
    expect(matchFacility('Mum_warehouse2', FACILITIES)).toMatchObject({ id: null, how: 'ambiguous', candidates: ['MUM_WAREHOUSE2', 'MUM_Warehouse2'] });
    expect(matchFacility('ggn_Warehouse', FACILITIES)).toMatchObject({ id: null, how: 'ambiguous' });
    expect(matchFacility('DS_NCR_PD_OKHLAHUB', FACILITIES)).toMatchObject({ id: null, how: 'unmatched' });
  });
  it('the matcher remembers where each code was seen', () => {
    const m = facilityMatcher(FACILITIES);
    m.match('kOL_WAREHOUSE', 'row 2');
    m.match('kOL_WAREHOUSE', 'row 5');
    expect(m.report()).toEqual([expect.objectContaining({ raw: 'kOL_WAREHOUSE', code: 'KOL_WAREHOUSE', how: 'case', where: 'row 2, row 5' })]);
  });
});

describe('PO prefix', () => {
  it('is the text before the first "|", only when it looks like a location code', () => {
    expect(poPrefixOf('HYP_Nagpur|22Oct2026|10')).toBe('HYP_Nagpur');
    expect(poPrefixOf('Okhla Hub-939|01Oct2026|Int3')).toBe('Okhla Hub-939');
    expect(poPrefixOf('SO33071')).toBeNull();
    expect(poPrefixOf('SO33071|x')).toBeNull();
    expect(poPrefixOf('|22Oct2026|1')).toBeNull();
    expect(poPrefixOf('123|22Oct2026|1')).toBeNull();
  });
  it('the most used one wins (ties alphabetical), the others are listed', () => {
    expect(choosePrefix(['A|1', 'B|1', 'B|2', 'SO1'])).toEqual({ prefix: 'B', count: 2, total: 4, others: ['A (1)'] });
    expect(choosePrefix(['B|1', 'A|1'])?.prefix).toBe('A');
    expect(choosePrefix(['SO33071'])).toBeNull();
  });
  it('per channel + location (case-insensitive), last N days from the newest PO date', () => {
    const p = prefixesByLocation([
      { channel: 'HYP_Website', location: 'Nagpur', poNumber: 'HYP_Nagpur|22Oct2026|10', poDate: '2026-10-22' },
      { channel: 'hyp_website', location: 'NAGPUR', poNumber: 'HYP_Nagpur|21Oct2026|3', poDate: '2026-10-21' },
      { channel: 'HYP_Website', location: 'Nagpur', poNumber: 'OLD_Nagpur|01Jan2026|1', poDate: '2026-01-01' },
    ], 90);
    expect(p.get('hypwebsite|nagpur')).toMatchObject({ prefix: 'HYP_Nagpur', count: 2, total: 2 });
  });
});

describe('transfer locations', () => {
  const m = facilityMatcher(FACILITIES).match;
  it('channel by normalised name / slug / alias', () => {
    expect(findChannel('Kol_warehouse', CHANNELS)?.id).toBe(47);
    expect(findChannel('mcaffeine b2c', CHANNELS)?.id).toBe(43);
    expect(findChannel('Nykaa', CHANNELS)).toBeNull();
  });
  it('new rows get the receiving facility and the PEPIMS prefix, else the facility code', () => {
    const prefixes = prefixesByLocation([{ channel: 'McaffeineB2C', location: 'Kolkata3', poNumber: 'mCaff_Kolkata3|1Oct2026|2', poDate: '2026-10-01' }], 90);
    const locs = planLocations(CHANNELS, m, [], prefixes, MAPPING);
    expect(locs.find((l) => l.locationCode === 'Kolkata3')).toMatchObject({ action: 'new', receivingId: 5, prefix: 'mCaff_Kolkata3', prefixSource: 'pepims' });
    expect(locs.find((l) => l.locationCode === 'Kolkata_MH')).toMatchObject({ action: 'new', channelName: 'KOL_WAREHOUSE', receivingId: 3, prefix: 'KOL_WAREHOUSE', prefixSource: 'facility code' });
  });
  it('a location without PEPIMS POs takes its twin\'s PEPIMS prefix (same channel + receiving facility)', () => {
    const twins = { McaffeineB2C: { Hyderabad: 'mCaff_Hyderabad2', Hyderabad2: 'mCaff_Hyderabad2', Hyderabad3: 'mCaff_Hyderabad3' } };
    const prefixes = prefixesByLocation([{ channel: 'McaffeineB2C', location: 'Hyderabad2', poNumber: 'Mcaff_Hyderabad2|1Oct2026|2', poDate: '2026-10-01' }], 90);
    const locs = planLocations(CHANNELS, m, [], prefixes, twins);
    expect(locs.find((l) => l.locationCode === 'Hyderabad')).toMatchObject({ prefix: 'Mcaff_Hyderabad2', prefixSource: 'pepims twin', prefixNote: 'from Hyderabad2 (1 POs)' });
    expect(locs.find((l) => l.locationCode === 'Hyderabad2')).toMatchObject({ prefix: 'Mcaff_Hyderabad2', prefixSource: 'pepims' });
    // a different receiving facility is not a twin
    expect(locs.find((l) => l.locationCode === 'Hyderabad3')).toMatchObject({ prefix: 'mCaff_Hyderabad3', prefixSource: 'facility code' });
  });

  it('an existing row of that channel + location is reused: only its empty fields are filled', () => {
    const locs = planLocations(CHANNELS, m, [
      { id: '600', channelId: 43, locationCode: 'kolkata3', transferFacilityId: null, transferPoPrefix: 'KEEP', isActive: true },
      { id: '601', channelId: 43, locationCode: 'Hyderabad3', transferFacilityId: 6, transferPoPrefix: null, isActive: false },
    ], new Map(), MAPPING);
    expect(locs.find((l) => l.existingId === '600')).toMatchObject({ action: 'reuse', locationCode: 'kolkata3', fills: [['transfer_facility_id', null, 5]], problem: null });
    const h = locs.find((l) => l.existingId === '601')!;
    expect(h.fills).toEqual([['transfer_po_prefix', null, 'mCaff_Hyderabad3']]);
    expect(h.problem).toContain('kept');
    expect(h.problem).toContain('switched off');
  });
});

describe('routes', () => {
  const row = (n: number, sender: string, channel: string, location: string, uniwareChannel: string, customerCode: string): ChannelSheetRow =>
    ({ row: n, sender, channel, location, uniwareChannel, customerCode, customerName: 'PEP TECHNOLOGIES PRIVATE LIMITED_WB' });
  const vendors: VendorSheetRow[] = [
    { row: 2, sender: 'MUM_Warehouse2', vendor: 'Mum_Warehouse2_', receiver: 'mCaff_Kolkata3' },
    { row: 3, sender: 'mCaff_Hyderabad2', vendor: 'Mcafff_Hyderabad2', receiver: 'mCaff_Hyderabad3' },
    { row: 4, sender: 'Mcaff_kolkata3', vendor: 'V1', receiver: 'kOL_WAREHOUSE' },
    { row: 5, sender: 'Mcaff_kolkata3', vendor: 'V2', receiver: 'KOL_WAREHOUSE' },
  ];
  const build = (rows: ChannelSheetRow[]) => {
    const m = facilityMatcher(FACILITIES).match;
    return buildRoutes(rows, vendors, planLocations(CHANNELS, m, [], new Map(), MAPPING), m);
  };

  it('no manual fixes: the sheet values are loaded as written; the same key twice with the same values is loaded once', () => {
    const r = build([
      row(61, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'MWH_INTERNAL_TRANSFER', 'KOL_WAREHOUSE_KOLKATA'),
      row(62, 'Mcaff_kolkata3', 'Kol_warehouse', 'Kolkata_MH', 'MWH_INTERNAL_TRANSFER', 'MCAFFEINEB2C_KOLKATA3'),
      row(168, 'mCaff_Hyderabad2', 'McaffeineB2C', 'Hyderabad3', 'D2C_TRANSFER_MCAFF_L', 'MCAFFEINEB2C_HYDERABAD3'),
      row(392, 'mCaff_Hyderabad2', 'McaffeineB2C', 'HYDERABAD3', 'D2C_TRANSFER_MCAFF_L', 'MCAFFEINEB2C_HYDERABAD3'),
    ]);
    expect(r.routes.map((x) => [x.senderCode, x.channelName, x.customerCode, x.uniwareChannelCode, x.rows])).toEqual([
      ['KOL_WAREHOUSE', 'McaffeineB2C', 'KOL_WAREHOUSE_KOLKATA', 'MWH_INTERNAL_TRANSFER', [61]],
      ['mCaff_Kolkata3', 'KOL_WAREHOUSE', 'MCAFFEINEB2C_KOLKATA3', 'MWH_INTERNAL_TRANSFER', [62]],
      ['mCaff_Hyderabad2', 'McaffeineB2C', 'MCAFFEINEB2C_HYDERABAD3', 'D2C_TRANSFER_MCAFF_L', [168, 392]],
    ]);
    // vendor of mCaff_Kolkata3 -> KOL_WAREHOUSE: two rows resolve to the same pair with two codes -> left empty, reported
    expect(r.routes[1].vendorCode).toBeNull();
    expect(r.issues.map((i) => i.kind)).toEqual(['vendor conflict (left empty)', 'duplicate row (same values, loaded once)']);
  });

  it('one sender + location with two Uniware channels = two routes (Motherhub)', () => {
    const r = build([
      row(30, 'MUM_WAREHOUSE2', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF_L', 'C1'),
      row(31, 'MUM_WAREHOUSE2', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_HYP_L', 'C1'),
    ]);
    expect(r.routes.map((x) => x.uniwareChannelCode)).toEqual(['D2C_TRANSFER_MCAFF_L', 'D2C_TRANSFER_HYP_L']);
    expect(r.issues).toEqual([]);
    expect(multiChannelRoutes(r.routes)).toEqual([{ senderCode: 'MUM_WAREHOUSE2', channelName: 'McaffeineB2C', locationCode: 'Kolkata3', channels: ['D2C_TRANSFER_MCAFF_L', 'D2C_TRANSFER_HYP_L'] }]);
  });

  it('vendor: exact facilities first, then the same codes ignoring case (reported), else missing', () => {
    const r = build([
      row(10, 'MUM_WAREHOUSE2', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF', 'MCAFFEINEB2C_KOLKATA3'),
      row(11, 'mCaff_ Ahmedabad', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF', 'MCAFFEINEB2C_KOLKATA3'),
    ]);
    expect(r.routes[0]).toMatchObject({ senderId: 1, vendorCode: 'Mum_Warehouse2_' });
    expect(r.routes[0].vendorNote).toMatch(/^CASE FALLBACK/);
    expect(r.routes[1]).toMatchObject({ senderId: 4, vendorCode: null, vendorNote: 'no vendor row for this sender / receiver' });
  });

  it('rows of one key with different values are reported and not loaded; unknown codes are skipped', () => {
    const r = build([
      row(20, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Ahmedabad', 'A', 'C1'),
      row(21, 'KOL_WAREHOUSE', 'McaffeineB2C', 'AHMEDABAD', 'a', 'C2'),
      row(22, 'Mum_warehouse2', 'McaffeineB2C', 'Kolkata3', 'A', 'C1'),
      row(23, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Pune', 'A', 'C1'),
      row(24, 'KOL_WAREHOUSE', 'Kol_warehouse', 'Kolkata_MH', 'A', 'C1'),
    ]);
    expect(r.routes).toEqual([]);
    expect(r.issues.map((i) => [i.kind, i.rows])).toEqual(expect.arrayContaining([
      ['CONFLICT (not loaded)', [20, 21]],
      ['sender not found', [22]],
      ['location not in the mapping', [23]],
      ['sender = receiver', [24]],
    ]));
  });

  it('every sender and receiver of a loaded route is listed for allow_internal_transfer', () => {
    const r = build([row(61, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'X', 'Y')]);
    expect([...facilitiesInRoutes(r.routes).entries()]).toEqual([
      [3, { code: 'KOL_WAREHOUSE', sends: 1, receives: 0 }],
      [5, { code: 'mCaff_Kolkata3', sends: 0, receives: 1 }],
    ]);
  });

  describe('upsert against the DB', () => {
    const plan = (rows: ChannelSheetRow[]) => {
      const m = facilityMatcher(FACILITIES).match;
      const locs = planLocations(CHANNELS, m, [
        { id: '600', channelId: 43, locationCode: 'Kolkata3', transferFacilityId: 5, transferPoPrefix: 'P', isActive: true },
      ], new Map(), MAPPING);
      return buildRoutes(rows, vendors, locs, m).routes;
    };
    const db = (id: number, senderId: number, ch: string | null, over: Partial<ExistingRoute> = {}): ExistingRoute => ({
      id, senderId, locationId: '600', uniwareChannelCode: ch, customerCode: 'C1', customerName: 'PEP TECHNOLOGIES PRIVATE LIMITED_WB', vendorCode: null, isActive: true, ...over,
    });

    it('same key: only changed fields are updated; an empty sheet cell keeps the DB value', () => {
      const routes = plan([row(10, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF', 'C2')]);
      const { work, notInSheet } = planRouteUpserts(routes, [db(7, 3, 'd2c_transfer_mcaff', { vendorCode: 'TYPED_IN_MASTERS' })]);
      expect(work[0]).toMatchObject({
        action: 'update', id: 7, matchedBy: 'key',
        changes: [{ field: 'uniwareChannelCode', old: 'd2c_transfer_mcaff', value: 'D2C_TRANSFER_MCAFF' }, { field: 'customerCode', old: 'C1', value: 'C2' }],
      });
      expect(work[0].kept).toEqual(['vendorCode: kept TYPED_IN_MASTERS (sheet empty)']);
      expect(notInSheet).toEqual([]);
    });
    it('the only route of a pair whose Uniware channel changed is updated, not added', () => {
      const routes = plan([row(10, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF_L', 'C1')]);
      const { work } = planRouteUpserts(routes, [db(7, 3, 'D2C_TRANSFER_MCAFF')]);
      expect(work[0]).toMatchObject({ action: 'update', id: 7, matchedBy: 'pair', changes: [{ field: 'uniwareChannelCode', old: 'D2C_TRANSFER_MCAFF', value: 'D2C_TRANSFER_MCAFF_L' }] });
    });
    it('a second channel of a pair is new; unchanged rows are same; DB rows not in the sheet are reported', () => {
      const routes = plan([
        row(10, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_MCAFF_L', 'C1'),
        row(11, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'D2C_TRANSFER_HYP_L', 'C1'),
      ]);
      const { work, notInSheet } = planRouteUpserts(routes, [db(7, 3, 'D2C_TRANSFER_MCAFF_L'), db(8, 1, 'X', { isActive: false })]);
      expect(work.map((w) => [w.action, w.id, w.r.uniwareChannelCode])).toEqual([['same', 7, 'D2C_TRANSFER_MCAFF_L'], ['new', null, 'D2C_TRANSFER_HYP_L']]);
      expect(notInSheet.map((o) => o.id)).toEqual([8]);
    });
    it('a new transfer location has no DB routes: every route is new', () => {
      const m = facilityMatcher(FACILITIES).match;
      const routes = buildRoutes([row(10, 'KOL_WAREHOUSE', 'McaffeineB2C', 'Kolkata3', 'A', 'C1')], vendors, planLocations(CHANNELS, m, [], new Map(), MAPPING), m).routes;
      expect(planRouteUpserts(routes, [db(7, 3, 'A')]).work[0].action).toBe('new');
    });
  });
});
