import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/constants';
import type { DetailsChannel } from '../../src/entities';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import { pickOneLocation } from '../../src/modules/po-validation/location-tiebreak';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { closeDb, db, insert, resetDb } from '../helpers/db';
import { BB, bigBasketPo, seedMasters } from '../helpers/fixtures';

/*
 * Several locations share a pincode (user 2026-11-02): the PO's own facility name, GSTIN or address picks exactly one,
 * else review. Pairs and PO values below = the 18 open LOCATION_NOT_MAPPED issues on dev (2 Nov), read from processed.json.
 */
const loc = (id: number, code: string, gstin: string, address: string) =>
  ({ id, channelLocationCode: code, consigneeGstNumber: gstin, finalShippingAddress: address }) as unknown as DetailsChannel;
const po = (fac: string, gstin: string, address: string) =>
  ({ delivery_facility_code: fac, delivery_gstin: gstin, 'shipping address': address }) as unknown as ProcessedPo;
const pick = (rows: DetailsChannel[], p: ProcessedPo) => {
  const one = pickOneLocation(rows, p);
  return one ? [one.row.channelLocationCode, one.by] : null;
};

const B4 = loc(189, 'Bengaluru B4', '29AAICP2804J1Z8', 'Sumadhura Logistics Park,11, Chinthamani -Hoskote Road, Doddenahalli,Village, Nandagudi,Hobli, Hoskote, 562114');
const B5 = loc(197, 'Bengaluru B5', '29AAFCG9846E1Z7', 'Survey Nos. 42/1, 42/3, Block C, Sumadhura Logistics Park, Doddenahalli Village, Nandagudi 562114');
const INDORE = loc(72, 'Indore', '23AAFCG9846E2ZI', '16/3/E, Warehouse no. 16/3/A, situated at Plot no.16, Empire Logipark, 453771');
const INDORE_I2 = loc(238, 'Indore I2', '23AAFCG9846E2ZI', 'Plot/Warehouse No 15/2, at Empire Logipark, Village Baroda Arjun, Tehsil Sanwer, District Indore, Madhya Pradesh-453771');
const M9 = loc(75, 'Mumbai M9', '27AADCH7038R1ZX', 'Ratan Logistics Hub Building No. RB1, Amane, Bhiwandi, Thane - 421302, Maharashtra.');
const M12 = loc(228, 'MUMBAI M12_BPCL', '27AAFCG9846E1ZB', 'sy. no. 84/10/1, 84/10/2, 84/13 ofPagaon Village ,Bhiwandi Tahashil, Maharashtra-421302');
const R1 = loc(70, 'Ranchi R1', '20AAFCG9846E1ZP', 'Plot no 678 and khata no 63 near jora mandir NH 33 Ranchi Tata highway sidrol namkum post khijari ranchi 834010 Jharkhand');
const R2 = loc(233, 'Ranchi R2', '20AAFCG9846E1ZP', 'Khasra No. 1630, 1636, Harbul, Jareya, Namkum, Ranchi, Jharkhand-834010');
const DELHI_BIJ = loc(82, 'Delhi Bijwasan', '07AAFCK9097H1Z0', 'Khasra No-283/1, Carterpuri Road Near CISF Camp, Bijwasan, New Delhi, Delhi, Delhi, India - 110061');
const KEMEXEL = loc(169, 'New Kemexel Bijwasan', '07AAFCK9097H2ZZ', 'Khasra No-283/1, Carterpuri Road Near CISF Camp, Bijwasan, New Delhi, Delhi, Delhi, India - 110061');
const THANE2 = loc(6, 'Thane 2 (Kukse)', '27AANCA0090J1ZK', 'IFC- Kukse Bhiwandi Avanue E-Commerce Limited Building No. B, Sai Krishna Co Village Mouje Borivali,Tarfe Sonale, Kharbav, Thane,, Maharashtra 421302');
const MOUJE = loc(196, 'Mouje Borivali', '27AANCA0090J1ZK', 'Ground Floor, AE00, Building No. B, Sai Krishna Complex, Avenue E-commerce Ltd, Village, Mouje Borivali, Tarfe Sonale, Bhiwandi, Survey No. 44/5/1, 44/5/2, 49/3/A, Kharbav, Thane, Maharashtra, 421302');

describe('pickOneLocation: the PO names one of several locations', () => {
  it('by the location code\'s words in the facility text (Blinkit)', () => {
    expect(pick([B4, B5], po('BCPL - Bengaluru B5 Feeder Warehouse', '', ''))).toEqual(['Bengaluru B5', 'name']);
    expect(pick([INDORE, INDORE_I2], po('BCPL - Indore I2 Feeder', '', ''))).toEqual(['Indore I2', 'name']);
    // "BCPL" on the PO, "BPCL" in the master: M12 still decides
    expect(pick([M9, M12], po('BCPL - Mumbai M12 - Feeder', '', ''))).toEqual(['MUMBAI M12_BPCL', 'name']);
    expect(pick([R1, R2], po('BCPL - Ranchi R1 Feeder Warehouse', '', ''))).toEqual(['Ranchi R1', 'name']);
    expect(pick([R1, R2], po('BLINK COMMERCE PRIVATE LIMITED - Ranchi R2 - Feeder', '', ''))).toEqual(['Ranchi R2', 'name']);
  });

  it('a name word both share is not enough ("BCPL - Indore Feeder" fits Indore and Indore I2 alike)', () => {
    expect(pick([INDORE, INDORE_I2], po('BCPL - Indore Feeder', '', ''))).toBeNull();
    // most words found, but each of them is also another location's: no word of its own -> not picked
    const xy = loc(1, 'Taloja Panvel', '', '');
    const xz = loc(2, 'Taloja FC', '', '');
    const yz = loc(3, 'Panvel FC', '', '');
    expect(pick([xy, xz, yz], po('Avenue Taloja Panvel', '', ''))).toBeNull();
  });

  it('by the GSTIN when the name does not decide (Firstcry New Kemexel 07AAFCK9097H2ZZ)', () => {
    expect(pick([DELHI_BIJ, KEMEXEL], po('', '07AAFCK9097H2ZZ', KEMEXEL.finalShippingAddress ?? ''))).toEqual(['New Kemexel Bijwasan', 'gstin']);
  });

  it('by the address when name and GSTIN do not decide (Blinkit #201: no facility text, R1 / R2 share the GSTIN)', () => {
    const p = po('', '20AAFCG9846E1ZP', 'BLINK COMMERCE PRIVATE LIMITED Khasra No. 1630, 1636, Harbul, Jareya, Namkum, Ranchi, Jharkhand-834010');
    expect(pick([R1, R2], p)).toEqual(['Ranchi R2', 'address']);
  });

  it('a real tie stays a tie: Avenue Thane 2 (Kukse) / Mouje Borivali = same GSTIN, same building; a too short address', () => {
    const avenue = po('', '27AANCA0090J1ZK', 'Building No. B, Sai Krishna Co Village Mouje Borivali,Tarfe Sonale, Kharbav, Thane,, Maharashtra 421302');
    expect(pick([THANE2, MOUJE], avenue)).toBeNull();
    expect(pick([R1, R2], po('', '20AAFCG9846E1ZP', 'BLINK COMMERCE PRIVATE LIMITED'))).toBeNull();
  });
});

describe('the PO check uses it (validatePo)', () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  const seedTwo = async () => {
    const m = await seedMasters();
    // a second BigBasket location with the same pincode 400001 (the seeded one is "WMS-TEST-FC")
    await insert('details_channels', {
      channel_id: BB.id, channel_name: BB.name, channel_location_code: 'WMS-TEST-FC2', uniware_customer_code: 'CUST_TEST_2', channel_code: 'BIGBASKET_TEST',
      facility_code: m.facilityCode, facility_id: m.facilityId, consignee_gst_number: '27AAACI1234A1Z5', consignee_pin_code: '400001',
      final_shipping_address: 'Other building, Andheri, Mumbai 400001', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
    return m;
  };
  const validate = async (p: ProcessedPo) => validatePo(p, await new MasterDataReader(await db()).forChannel(CHANNELS.BIGBASKET), new Date('2026-10-27T06:00:00Z'));

  it('facility text that is not exactly a code, shared pincode: the location named in the text is taken, the PO passes', async () => {
    const m = await seedTwo();
    const v = await validate(bigBasketPo(m, { delivery_facility_code: 'BB - WMS TEST FC2 - Feeder' }));
    expect(v.issues).toEqual([]);
    expect(v.location).toMatchObject({ locationCode: 'WMS-TEST-FC2', customerCode: 'CUST_TEST_2', matchedBy: 'pincode' });
  });

  it('nothing tells them apart: review with both codes listed, as before', async () => {
    const m = await seedTwo();
    const v = await validate(bigBasketPo(m, { delivery_facility_code: 'BB - Feeder', 'shipping address': '' }));
    expect(v.issues.map((i) => i.type)).toEqual(['LOCATION_NOT_MAPPED']);
    expect(v.issues[0].message).toContain('WMS-TEST-FC, WMS-TEST-FC2');
  });
});
