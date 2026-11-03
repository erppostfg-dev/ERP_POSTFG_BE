import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { myntraStrConnector } from '../../src/modules/channel-api/myntra/myntra-str.connector';
import { runStrRobot, setAfterStored, type StrFetcher } from '../../src/modules/channel-api/myntra/str.service';
import { runConnector } from '../../src/modules/channel-api/runner';
import { api, loginAs } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { clearS3 } from '../helpers/fake-s3';
import { seedMasters, type Masters } from '../helpers/fixtures';

/*
 * Myntra STRs step 2 (2026-11-03): a stored STR becomes a PO through the shared runner. Rules (user): our rate (master
 * margin) + our GST, Myntra's List / Landed Price never used (no price / total check, no "price missing"), MRP checked;
 * location from the Destination WH (the user's sheet), warehouse from that location; a location whose Uniware channel
 * differs from the sheet -> review; never taken twice.
 */

const MY = { id: 5, name: 'Myntra' };
const SKU = 'MCFNFCWH86498566';
let m: Masters;

const HEAD = 'GTIN,GTINS,Style Id,SKU Code,Quantity,Vendor Article No,Vendor Article Name,Size,Gender,Brand Name,Article Type Name,HSN Code,Source WH,Destination WH,MRP,List Price,Landed Price,IGST Rate,IGST Amount';
const csv = (dest: string, mrp = 299, sku = SKU) =>
  `${HEAD}\n08906129573567,"[""08906129573567""]",26828554,${sku},10,MCaf270,FACE WASH,100 ml,Unisex,MCaffeine,Face Wash,33051090,Pep Technologies_SJIT_Bhiwandi_CPWE,${dest},${mrp},209.3,219.77,5.0,10.46\n`;

const seedMyntra = async () => {
  await insert('master_channels', { id: MY.id, slug: 'myntra', display_name: MY.name, db_aliases: [MY.name], has_processor: 1, is_active: 1, channel_type: 'B2C' });
  await insert('master_channel_skus', {
    pep_code: m.pepCode, pep_sku_id: m.pepSkuId, channel_id: MY.id, channel_name: MY.name, channel_code: SKU, product_name: 'Face Wash',
    brand_name: 'mCaffeine', mrp: 299, margin: 0.85, rate_after_margin: 44.85, is_active: 1,
  });
  const loc = (code: string, customer: string, uniware: string, pin: string) => insert('details_channels', {
    channel_id: MY.id, channel_name: MY.name, channel_location_code: code, uniware_customer_code: customer, channel_code: uniware,
    facility_code: m.facilityCode, facility_id: m.facilityId, consignee_name: `Myntra ${code}`, consignee_state: 'X', consignee_gst_number: '06AAACM1234A1Z5',
    consignee_pin_code: pin, final_shipping_address: code, final_billing_address: code, buyer_type: 'B2B', city: code, is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  await loc('Gurgaon', 'MYNTRA_GURGAON_122413', 'B2C_STN_MYNTRA_L', '122413');
  // our master says B2C_STN_MYNTRA, the user's sheet B2C_STN_MYNTRA_L -> review
  await loc('Mumbai', 'MYNTRA_MUMBAI_421101', 'B2C_STN_MYNTRA', '421101');
};
const strItem = (str: string, dest: string) => insert('channel_pull_items', {
  source_system: 'myntra_str', external_id: str, status: null, warehouse: dest, created_on: '2026-10-27', label: `${str} · NON TC P0 · ${dest}`,
  data: JSON.stringify({ email: { folder: 'f', subject: 'Re: Request to Raise STRs', receivedAt: '2026-10-27T05:09:20.000Z' }, order: 1, group: 'NON TC', priority: 'P0', destination: dest, runs: 0, lastError: null }),
  fetched_at: new Date(),
});
const uploads = () => rows<{ po_number: string; status: string; po_uid: string | null }>('SELECT po_number, status, po_uid FROM po_uploads ORDER BY id');
const openIssues = (po: string) => rows<{ issue_type: string; details: string }>(
  "SELECT i.issue_type, i.details FROM po_issues i JOIN po_uploads u ON u.id = i.upload_id WHERE u.po_number = ? AND i.status = 'open'", [po]);

beforeEach(async () => {
  setAfterStored(() => undefined);
  await resetDb();
  clearS3();
  m = await seedMasters();
  await seedMyntra();
  const admin = await loginAs('admin');
  await insert('channel_intake_settings', { channel: 'myntra', enabled: 1, process_from: new Date('2026-10-01T00:00:00Z'), updated_by: admin.userId, updated_at: new Date() });
});
afterAll(closeDb);

describe('stored STRs -> POs', () => {
  it('our rate + our GST (no price check), location from the sheet; Mumbai channel differs -> review; unknown SKU -> review; never twice', async () => {
    await strItem('STNCPWEBP271026-01', 'BP');
    await strItem('STNCPWEMW271026-01', 'MW');
    await strItem('STNCPWEBW271026-01', 'BW');
    const files: Record<string, string> = {
      'STNCPWEBP271026-01': csv('Bilaspur Warehouse - Gurgaon'),
      'STNCPWEMW271026-01': csv('Myntra warehouse ( Mumbai )'),
      // Bangalore is not in this test's masters: review for the location
      'STNCPWEBW271026-01': csv('Bangalore - New Whitefield W/H'),
    };
    const fetcher: StrFetcher = async (strs) => strs.map((str) => ({ str, csv: files[str] }));
    let after = 0;
    setAfterStored(() => { after++; });
    expect((await runStrRobot('test', fetcher)).stored).toBe(3);
    expect(after).toBe(1);

    await runConnector(myntraStrConnector, { apply: true, saveCheckpoint: true });
    const u = await uploads();
    expect(u.map((x) => [x.po_number, x.status])).toEqual([
      ['STNCPWEBP271026-01', 'completed'], ['STNCPWEMW271026-01', 'needs_review'], ['STNCPWEBW271026-01', 'needs_review'],
    ]);
    // the sale order: our rate 44.85 (margin 0.85), not Myntra's landed 219.77; Gurgaon's customer + facility
    const [order] = await rows<{ customerCode: string; facility: string; location: string; orderNo1: string }>('SELECT customerCode, facility, location, orderNo1 FROM master_purchase_orders WHERE poNumber = ?', ['STNCPWEBP271026-01']);
    expect(order).toMatchObject({ customerCode: 'MYNTRA_GURGAON_122413', facility: m.facilityCode, location: 'Gurgaon' });
    const lines = await rows<{ qty: number; poValue: string }>('SELECT qty, poValue FROM details_purchase_orders WHERE poNumber = ?', ['STNCPWEBP271026-01']);
    expect(lines.map((l) => [Number(l.qty), Number(l.poValue)])).toEqual([[10, 448.5]]);
    expect(await openIssues('STNCPWEBP271026-01')).toEqual([]);
    // Mumbai: only the Uniware channel (no price issue)
    const mw = await openIssues('STNCPWEMW271026-01');
    expect(mw).toHaveLength(1);
    expect(mw[0].details).toContain('B2C_STN_MYNTRA_L');
    expect((await openIssues('STNCPWEBW271026-01')).map((i) => i.issue_type)).toEqual(['LOCATION_NOT_MAPPED']);
    // Verify shows Myntra's own price as information next to ours (never used)
    const [bp] = await rows<{ id: string }>("SELECT id FROM po_uploads WHERE po_number = 'STNCPWEBP271026-01'");
    const reviewer = await loginAs('operations-executive');
    const d = (await api().get(`/api/v1/po-verify/${bp.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(d.totals.channelPrice).toMatchObject({ value: 2197.7 });
    expect(d.totals.saved.value).toBe(448.5);
    expect(d.lines[0]).toMatchObject({ rate: 44.85, rateDiffers: false, po: { channelPrice: 219.77, channelGst: 5 } });
    // taken once: another run makes nothing new
    await runConnector(myntraStrConnector, { apply: true, saveCheckpoint: true });
    expect(await uploads()).toHaveLength(3);
    expect(Number((await rows<{ n: number }>("SELECT COUNT(*) n FROM channel_pull_items WHERE source_system = 'myntra_str' AND taken_at IS NOT NULL"))[0].n)).toBe(3);
  });

  it('MRP is still checked; a waiting or failed STR never becomes a PO', async () => {
    await strItem('STNCPWEBP271026-02', 'BP');
    await strItem('STNCPWEBP271026-03', 'BP');
    await runStrRobot('test', async (strs) => strs.map((str) => (str.endsWith('-02') ? { str, csv: csv('Bilaspur Warehouse - Gurgaon', 349) } : { str, csv: null, error: 'not found on the Myntra portal' })));
    await runConnector(myntraStrConnector, { apply: true, saveCheckpoint: true });
    expect((await uploads()).map((x) => [x.po_number, x.status])).toEqual([['STNCPWEBP271026-02', 'needs_review']]);
    expect((await openIssues('STNCPWEBP271026-02')).map((i) => i.issue_type)).toEqual(['MRP_MISMATCH']);
  });
});
