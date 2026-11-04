import { insert } from './db';
import type { Masters } from './fixtures';

/*
 * Myntra STR test data (2026-11-03): an STR CSV with the portal's real header, and Myntra in the masters (master_channels
 * id 5, our test PEP SKU under one Myntra SKU Code at rate 44.85 = margin 0.85, Gurgaon with the sheet's Uniware channel).
 */

export const MY = { id: 5, name: 'Myntra' };
export const MY_SKU = 'MCFNFCWH86498566';

const HEAD = 'GTIN,GTINS,Style Id,SKU Code,Quantity,Vendor Article No,Vendor Article Name,Size,Gender,Brand Name,Article Type Name,HSN Code,Source WH,Destination WH,MRP,List Price,Landed Price,IGST Rate,IGST Amount';
export const strCsv = (dest = 'Bilaspur Warehouse - Gurgaon', qty = 10, mrp = 299) =>
  `${HEAD}\n08906129573567,"[""08906129573567""]",26828554,${MY_SKU},${qty},MCaf270,FACE WASH,100 ml,Unisex,MCaffeine,Face Wash,33051090,Pep Technologies_SJIT_Bhiwandi_CPWE,${dest},${mrp},209.3,219.77,5.0,10.46\n`;

export const seedMyntra = async (m: Masters): Promise<void> => {
  await insert('master_channels', { id: MY.id, slug: 'myntra', display_name: MY.name, db_aliases: [MY.name], has_processor: 1, is_active: 1, channel_type: 'B2C' });
  await insert('master_channel_skus', {
    pep_code: m.pepCode, pep_sku_id: m.pepSkuId, channel_id: MY.id, channel_name: MY.name, channel_code: MY_SKU, product_name: 'Face Wash',
    brand_name: 'mCaffeine', mrp: 299, margin: 0.85, rate_after_margin: 44.85, is_active: 1,
  });
  await insert('details_channels', {
    channel_id: MY.id, channel_name: MY.name, channel_location_code: 'Gurgaon', uniware_customer_code: 'MYNTRA_GURGAON_122413', channel_code: 'B2C_STN_MYNTRA_L',
    facility_code: m.facilityCode, facility_id: m.facilityId, consignee_name: 'Myntra Gurgaon', consignee_state: 'Haryana', consignee_gst_number: '06AAACM1234A1Z5',
    consignee_pin_code: '122413', final_shipping_address: 'Gurgaon', final_billing_address: 'Gurgaon', buyer_type: 'B2B', city: 'Gurgaon', is_active: 1,
    created_at: new Date(), updated_at: new Date(),
  });
};
