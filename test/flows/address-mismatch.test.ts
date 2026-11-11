import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/constants';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { BB, bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * Address Mismatch (2026-11-06): the PO is billed to one of our warehouses (vendor_gstin) but its location is mapped to
 * another warehouse (details_channels.facility_code) -> review with ADDRESS_MISMATCH, which the reviewer may accept.
 * Our GSTINs: 27AAICP2804J1ZC = Mumbai (MUM_WAREHOUSE2), 06AAICP2804J1ZG = Gurgaon (GGN_WAREHOUSE).
 */
const MUM = '27AAICP2804J1ZC';
const GGN = '06AAICP2804J1ZG';

let m: Masters;
/** The seeded location now ships from `facility` (the warehouse codes as on dev). */
const mapLocationTo = async (facility: string) => {
  await rows('UPDATE master_facilities SET code = ? WHERE id = ?', [facility, m.facilityId]);
  await rows('UPDATE details_channels SET facility_code = ? WHERE id = ?', [facility, m.locationId]);
};
const issuesOf = async (vendorGstin: string, channel: string = CHANNELS.BIGBASKET) => {
  const reader = new MasterDataReader(await db());
  const v = await validatePo(bigBasketPo(m, { vendor_gstin: vendorGstin, channel_name: channel }), await reader.forChannel(CHANNELS.BIGBASKET), new Date('2026-10-27T06:00:00Z'));
  return v.issues;
};

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
});
afterAll(closeDb);

describe('Address Mismatch', () => {
  it('billed to Mumbai, location mapped to GGN: review with ADDRESS_MISMATCH (acceptable), saying both warehouses', async () => {
    await mapLocationTo('GGN_WAREHOUSE');
    const issues = await issuesOf(MUM);
    expect(issues).toEqual([expect.objectContaining({ type: 'ADDRESS_MISMATCH', field: 'billed_to', actual: MUM })]);
    expect(issues[0].message).toBe('Address Mismatch: the PO is billed to Mumbai warehouse (MH) (GSTIN 27AAICP2804J1ZC) but location WMS-TEST-FC is mapped to GGN_WAREHOUSE (Gurgaon warehouse (HR))');
  });

  it('the other way (billed to Gurgaon, mapped to Mumbai, code in another case) is flagged too', async () => {
    await mapLocationTo('MUM_Warehouse2');
    expect((await issuesOf(GGN)).map((i) => i.type)).toEqual(['ADDRESS_MISMATCH']);
  });

  it('no flag: same warehouse, no GSTIN on the PO, a GSTIN that is not ours, a warehouse we have no GSTIN for', async () => {
    await mapLocationTo('MUM_WAREHOUSE2');
    expect(await issuesOf(MUM)).toEqual([]);
    expect(await issuesOf(' 27aaicp2804j1zc ')).toEqual([]);
    expect(await issuesOf('')).toEqual([]);
    expect(await issuesOf('06AAACI1234A1Z5')).toEqual([]);
    await mapLocationTo('BLR_WAREHOUSE');
    expect(await issuesOf(GGN)).toEqual([]);
  });

  it('a GSTIN filled on the warehouse master wins over the built-in list', async () => {
    await mapLocationTo('MUM_WAREHOUSE2');
    await rows('UPDATE master_facilities SET bill_to_gstin = ? WHERE id = ?', [GGN, m.facilityId]);
    expect(await issuesOf(GGN)).toEqual([]);
    expect((await issuesOf(MUM)).map((i) => i.type)).toEqual(['ADDRESS_MISMATCH']);
  });

  it('Amazon, Flipkart and Myntra (B2C) are not checked', async () => {
    await mapLocationTo('GGN_WAREHOUSE');
    for (const channel of [CHANNELS.AMAZON, CHANNELS.FLIPKART, CHANNELS.MYNTRA]) {
      expect((await issuesOf(MUM, channel)).filter((i) => i.type === 'ADDRESS_MISMATCH')).toEqual([]);
    }
  });
});

describe('Address Mismatch in PO Review', () => {
  it('the chain stops the PO in review; the reviewer fixes it with a location of the billed warehouse, or accepts it with a remark', async () => {
    await mapLocationTo('GGN_WAREHOUSE');
    const reviewer = await loginAs('operations-executive');
    const issueOf = async (id: string) => (await rows<{ id: string; issue_type: string }>('SELECT id, issue_type FROM po_issues WHERE upload_id = ? AND status = ?', [id, 'open']));
    const submit = (id: string, body: Record<string, unknown>) => api().post(`/api/v1/po-review/${id}/submit`).set('Cookie', reviewer.cookie).send(body);

    // 1. fixed: another location of the same DC, shipping from Mumbai
    const mumId = await insert('master_facilities', { code: 'MUM_WAREHOUSE2', name: 'Mumbai', entity: 'PEP', state: 'Maharashtra', is_active: 1, source: 'manual', uniware_export: 0 });
    const mumLoc = await insert('details_channels', {
      channel_id: BB.id, channel_name: BB.name, channel_location_code: 'WMS-TEST-FC-MUM', uniware_customer_code: 'CUST_TEST_MUM', channel_code: 'BIGBASKET_TEST',
      facility_code: 'MUM_WAREHOUSE2', facility_id: mumId, consignee_pin_code: '400002', final_shipping_address: 'Test address 2, Mumbai', buyer_type: 'B2B',
      city: 'Mumbai', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
    const a = await runPo(bigBasketPo(m, { po_number: 'IRA90000011', vendor_gstin: MUM }));
    expect(a.status).toBe('needs_review');
    expect((await issueOf(a.id)).map((i) => i.issue_type)).toEqual(['ADDRESS_MISMATCH']);
    await submit(a.id, { location: { detailsChannelId: mumLoc }, remark: 'Mumbai DC' }).expect(200);
    expect((await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [a.id]))[0].status).toBe('pending_approval');

    // 2. accepted as it is (needs a remark)
    const b = await runPo(bigBasketPo(m, { po_number: 'IRA90000012', vendor_gstin: MUM }));
    const [issue] = await issueOf(b.id);
    const noRemark = await submit(b.id, { accept: [{ issueId: issue.id }] }).expect(422);
    expect(noRemark.body.error.code).toBe('ISSUE_REMARK_REQUIRED');
    await submit(b.id, { accept: [{ issueId: issue.id, remark: 'channel billed Mumbai by mistake, ship from GGN' }] }).expect(200);
    expect((await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [b.id]))[0].status).toBe('pending_approval');
  });
});
