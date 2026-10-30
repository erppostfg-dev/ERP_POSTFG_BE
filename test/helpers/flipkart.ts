import type { ConsignmentsRobotResult } from '../../src/modules/channel-api/flipkart/consignments.robot';
import { insert } from './db';
import type { Masters } from './fixtures';

/*
 * Flipkart consignments test data (2026-10-30): files exactly as Seller Hub gives them (the consignment CSV's and the
 * Bulk Consignment File's real headers), the robot's result as the worker returns it, and Flipkart in the masters
 * (master_channels id 8, our test PEP SKU under one FSN at rate 74.85, one warehouse).
 */

export const FK = { id: 8, name: 'Flipkart' };
export const FSN = 'BWSHJYA2VSNKVZXW';
export const WAREHOUSE = 'ahm_khe_wh_nl_01nl';

const HEAD = '"Product Name","FSN","SKU Id","Brand","Size","Style Code","Color","Isbn","Model Id","Quantity Sent","Quantity Received","Inwarded to Store","QC Fail ","QC In Progress","QC Passed","Cost Price","Length(In cms)","Breadth(In cms)","Height(In cms)","Weight(In kgs)"';
export const fkCsv = (lines: { fsn?: string; sku?: string; qty: number; cost: number }[]) => `${HEAD}\n${lines
  .map((l) => `"Body Wash 250ml","${l.fsn ?? FSN}","${l.sku ?? 'Mcaf408_WB'}","mCaffeine","N/A","N/A","N/A","N/A","N/A","${l.qty}","0","N/A","N/A","N/A","N/A","${l.cost.toFixed(2)}","16.0","5.6","4.7","0.285"`).join('\n')}\n`;

export const BULK_HEAD = 'Consignment Id,Creation Date,Week,Warehouse Id,Promised Qty,Actual Qty,Live on Flipkart Qty,Consignment Status,Dispatch Type,Scheduled Pick Up Date,Scheduled Drop In Date,Super Category,BU';
export const fkBulk = (rows: { id: string; qty: number; status?: string; warehouse?: string }[]) => `${BULK_HEAD}\n${rows
  .map((r) => `${r.id},2026-10-24 10:30:09,43,${r.warehouse ?? WAREHOUSE},${r.qty},,0,${r.status ?? 'PICK_UP_ORDER_REGISTERED'},PICK_UP,2026-10-30 10:00:00,2026-11-06 10:00:00,Grooming,BGM`).join('\n')}\n`;

export const fkRobot = (fetched: ConsignmentsRobotResult['fetched'], bulk: string | null): ConsignmentsRobotResult =>
  ({ total: fetched.length, pages: 1, seen: fetched.map((f) => f.id), fetched, bulkCsv: bulk });

export const seedFlipkart = async (m: Masters): Promise<void> => {
  await insert('master_channels', { id: FK.id, slug: 'flipkart', display_name: FK.name, db_aliases: [FK.name], has_processor: 1, is_active: 1, channel_type: 'B2C' });
  await insert('master_channel_skus', {
    pep_code: m.pepCode, pep_sku_id: m.pepSkuId, channel_id: FK.id, channel_name: FK.name, channel_code: FSN, product_name: 'Body Wash',
    brand_name: 'mCaffeine', mrp: 499, margin: 0.85, rate_after_margin: 74.85, is_active: 1,
  });
  await insert('details_channels', {
    channel_id: FK.id, channel_name: FK.name, channel_location_code: WAREHOUSE, uniware_customer_code: 'FLIPKART_AHMEDABAD_387570', channel_code: 'FLIPKART',
    facility_code: m.facilityCode, facility_id: m.facilityId, consignee_name: 'Flipkart Ahmedabad', consignee_state: 'Gujarat', consignee_gst_number: '24AAACF1234A1Z5',
    consignee_pin_code: '387570', final_shipping_address: 'Ahmedabad', final_billing_address: 'Ahmedabad', buyer_type: 'B2B', city: 'Ahmedabad', is_active: 1,
    created_at: new Date(), updated_at: new Date(),
  });
};

/** Flipkart switched ON in PO intake from `from` (needs a user for updated_by). */
export const fkSwitchOn = (userId: number, from = '2026-10-01T00:00:00Z') =>
  insert('channel_intake_settings', { channel: 'flipkart', enabled: 1, process_from: new Date(from), updated_by: userId, updated_at: new Date() });
