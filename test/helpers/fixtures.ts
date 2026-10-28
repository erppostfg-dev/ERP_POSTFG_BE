import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import type { ProcessedLine, ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import { insert } from './db';

/*
 * Small, readable master data for tests (2026-10-28). BigBasket keeps its real master id (CHANNEL_MASTER_IDS), so the
 * PO checks (MasterDataReader) find it exactly as in production. One of each: channel, warehouse, PEP SKU, channel
 * SKU, delivery location. Values are made up but valid (GSTIN, pincode, EAN formats).
 */
export const BB = { id: CHANNEL_MASTER_IDS[CHANNELS.BIGBASKET], name: 'BigBasket', slug: 'bigbasket' };

export interface Masters {
  channelId: number;
  facilityId: number;
  facilityCode: string;
  pepSkuId: number;
  pepCode: string;
  channelSkuId: number;
  channelCode: string;
  locationId: number;
  locationCode: string;
}

export const seedMasters = async (): Promise<Masters> => {
  await insert('master_channels', { id: BB.id, slug: BB.slug, display_name: BB.name, db_aliases: [BB.name, BB.slug, 'big basket'], has_processor: 1, is_active: 1, channel_type: 'B2B', expiry_days_min: 60, expiry_days_max: 90 });
  const facilityCode = 'TEST_WH1';
  const facilityId = await insert('master_facilities', { code: facilityCode, name: 'Test warehouse', entity: 'PEP', state: 'Maharashtra', is_active: 1, source: 'manual', uniware_export: 0 });
  const pepCode = 'MCAFF_TEST_001';
  const pepSkuId = await insert('master_skus', {
    pep_code: pepCode, product_name: 'Test Coffee Body Scrub 100g', brand_name: 'mCaffeine', product_type: 'SIMPLE', mrp: 499, gst_tax_type: '18',
    ean_code: '8906000000017', hsn_code: '33049990', length_mm: 100, width_mm: 50, height_mm: 50, weight_g: 120, shelf_life: 730, is_active: 1,
    created_at: new Date(), updated_at: new Date(),
  });
  const channelCode = 'BB-TEST-ITEM-1';
  const channelSkuId = await insert('master_channel_skus', {
    pep_code: pepCode, pep_sku_id: pepSkuId, channel_id: BB.id, channel_name: BB.name, channel_code: channelCode, product_name: 'Test Coffee Body Scrub 100g',
    brand_name: 'mCaffeine', mrp: 499, margin: 0.3, rate_after_margin: 349.3, ean_code: '8906000000017', is_active: 1,
  });
  const locationCode = 'WMS-TEST-FC';
  const locationId = await insert('details_channels', {
    channel_id: BB.id, channel_name: BB.name, channel_location_code: locationCode, uniware_customer_code: 'CUST_TEST_1', channel_code: 'BIGBASKET_TEST',
    facility_code: facilityCode, facility_id: facilityId, consignee_name: 'Test DC', consignee_state: 'Maharashtra', consignee_gst_number: '27AAACI1234A1Z5',
    consignee_pin_code: '400001', final_shipping_address: 'Test address, Mumbai', final_billing_address: 'Test address, Mumbai', buyer_type: 'B2B',
    city: 'Mumbai', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  return { channelId: BB.id, facilityId, facilityCode, pepSkuId, pepCode, channelSkuId, channelCode, locationId, locationCode };
};

const line = (m: Masters, overrides: Partial<ProcessedLine> = {}): ProcessedLine => ({
  line_no: 1, pep_sku_code: '', listing_sku_code: '', channel_sku_code: m.channelCode, ean: '', description: 'Test scrub', qty: 10, free_qty: '',
  pep_mrp: '', channel_mrp: 499, landing_rate: 349.3, unit_cost: '', line_total: 3493, margin: '', hsn: '33049990', gst: 18, unmapped: {},
  ...overrides,
});

/** A clean BigBasket PO for the seeded masters: passes every check while the masters are as seeded. */
export const bigBasketPo = (m: Masters, overrides: Partial<ProcessedPo> = {}): ProcessedPo => ({
  channel_name: CHANNELS.BIGBASKET, input_type: 'sheet', ref_file_urls: [], po_number: 'IRA_TEST_1', po_date: '2026-10-26',
  type_delivery_facility: '', delivery_facility_code: m.locationCode, delivery_pincode: '400001', total_line_items: 1, total_qty: 10,
  po_value: 3493, expected_date: '2026-11-05', appointment_date: '', expiry_date: '2026-12-31', delivery_gstin: '27AAACI1234A1Z5', vendor_gstin: '',
  cart_discount: 0, net_amount: 3493, po_type: '', revised: false, revision_of: '', line_items: [line(m)], unmapped: {},
  ...overrides,
} as ProcessedPo);
