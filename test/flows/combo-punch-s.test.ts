import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/constants';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { punchCodeOf, validatePo } from '../../src/modules/po-validation/validate-po';
import type { MasterSku } from '../../src/entities';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';

/*
 * Combos, gift kits and M_Tools are punched with their _S code (PM 2026-10-29) when OUR master has it switched on
 * (user 2026-10-30); else the mapped code as before (the masters team adds the missing _S codes). The _S code goes to
 * the Uniware CSV (Sale Order Item Code + Item SKU Code) and the saved PO line; the price check keeps the mapped row.
 * Seeded: channel SKU BB-TEST-ITEM-1 -> MCAFF_TEST_001 (made a Combo here), MRP 499, rate 349.30.
 */
const V = '/api/v1';
let m: Masters;

const sql = async (q: string, params: unknown[] = []) => (await db()).query(q, params);
const asCombo = (type = 'Combo') => sql('UPDATE master_skus SET product_type = ? WHERE pep_code = ?', [type, m.pepCode]);
const addSku = (pepCode: string, isActive = 1, mrp = 499) =>
  insert('master_skus', { pep_code: pepCode, product_name: 'Test combo (punch code)', brand_name: 'mCaffeine', product_type: 'Combo', mrp, gst_tax_type: '18', is_active: isActive, created_at: new Date(), updated_at: new Date() });
const validate = async () => (await validatePo(bigBasketPo(m), await new MasterDataReader(await db()).forChannel(CHANNELS.BIGBASKET), new Date('2026-10-30T06:00:00Z'))).lines[0];

/** The 14-column CSV line of a completed upload: [Sale Order Item Code, Item SKU Code]. */
const csvCodes = (u: Upload) => {
  const csv = s3Objects().get(u.uniware_csv_url!.replace(/^s3:\/\/[^/]+\//, ''))!;
  const line = csv.trim().split(/\r?\n/)[1].split(',');
  return [line[4], line[6]];
};
const savedCodes = async (u: Upload) => (await rows<{ skuCode: string }>('SELECT skuCode FROM details_purchase_orders WHERE shipmentOrderId = ?', [u.po_uid])).map((r) => r.skuCode);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
});
afterAll(closeDb);

describe('the chain punches a combo with its _S code', () => {
  it('_S in our master and switched on: the CSV (both code columns) and the saved PO line get it; the price check is unchanged', async () => {
    await asCombo();
    await addSku(`${m.pepCode}_S`, 1, 999); // a different MRP on the _S row does not move the check (mapped row)
    const l = await validate();
    expect(l).toMatchObject({ pepCode: m.pepCode, punchCode: `${m.pepCode}_S`, ourMrp: 499, ourRate: 349.3 });
    const u = await runPo(bigBasketPo(m));
    expect(u.status).toBe('completed');
    expect(csvCodes(u)).toEqual([`${m.pepCode}_S`, `${m.pepCode}_S`]);
    expect(await savedCodes(u)).toEqual([`${m.pepCode}_S`]);
  });

  it('no _S code in our master: punched with the mapped code as before', async () => {
    await asCombo();
    const u = await runPo(bigBasketPo(m));
    expect(u.status).toBe('completed');
    expect(csvCodes(u)).toEqual([m.pepCode, m.pepCode]);
    expect(await savedCodes(u)).toEqual([m.pepCode]);
  });

  it('the _S code is switched off: the mapped code', async () => {
    await asCombo('Gift Kit');
    await addSku(`${m.pepCode}_S`, 0);
    expect((await validate()).punchCode).toBe(m.pepCode);
  });

  it('a lower-case _s code is punched as our master spells it; Gift Kit counts too', async () => {
    await asCombo('Gift Kit');
    await addSku(`${m.pepCode}_s`);
    expect((await validate()).punchCode).toBe(`${m.pepCode}_s`);
  });

  it('not a combo / gift kit / M_Tool: the mapped code even when an _S code exists', async () => {
    await addSku(`${m.pepCode}_S`); // seeded type SIMPLE
    expect((await validate()).punchCode).toBe(m.pepCode);
  });

  it('a PO approved from review is punched the same way', async () => {
    await asCombo();
    await addSku(`${m.pepCode}_S`);
    const reviewer = await loginAs('operations-executive');
    const admin = await loginAs('admin');
    const u = await runPo(bigBasketPo(m, { po_number: 'IRA90000002', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    expect(u.status).toBe('needs_review');
    const detail = await api().get(`${V}/po-review/${u.id}`).set('Cookie', reviewer.cookie).expect(200);
    expect((detail.body as { data: { lines: { pepCode: string; punchCode: string }[] } }).data.lines[0]).toMatchObject({ pepCode: m.pepCode, punchCode: `${m.pepCode}_S` });
    await api().post(`${V}/po-review/${u.id}/submit`).set('Cookie', reviewer.cookie).send({ location: { detailsChannelId: m.locationId }, remark: 'right DC' }).expect(200);
    const [s] = await rows<{ id: string }>('SELECT id FROM po_review_submissions WHERE upload_id = ?', [u.id]);
    await api().post(`${V}/approvals/po-reviews/${s.id}/approve`).set('Cookie', admin.cookie).send({}).expect(200);
    const [done] = await rows<Upload>('SELECT id, status, po_number, po_uid, uniware_csv_url, channel FROM po_uploads WHERE id = ?', [u.id]);
    expect(done.status).toBe('completed');
    expect(csvCodes(done)).toEqual([`${m.pepCode}_S`, `${m.pepCode}_S`]);
    expect(await savedCodes(done)).toEqual([`${m.pepCode}_S`]);
  });
});

describe('punchCodeOf (which codes the rule covers)', () => {
  const sku = (pepCode: string, productType: string | null, isActive = true) => ({ pepCode, productType, isActive }) as MasterSku;
  const master = (...s: MasterSku[]) => new Map(s.map((x) => [x.pepCode.toLowerCase(), x]));

  it('M_Tools by their code (no product type)', () => {
    const tool = sku('MTOOL1_JD', null);
    expect(punchCodeOf('MTOOL1_JD', tool, master(tool, sku('MTOOL1_JD_S', null)))).toBe('MTOOL1_JD_S');
  });

  it('codes that are already a punch code or a code of their own stay as they are', () => {
    const all = master(sku('CMB1_S_S', 'Combo'), sku('CMB1_S1_S', 'Combo'), sku('MGKIT64_SWM_S_N1_S', 'Gift Kit'));
    expect(punchCodeOf('CMB1_S', sku('CMB1_S', 'Combo'), all)).toBe('CMB1_S');
    expect(punchCodeOf('CMB1_S1', sku('CMB1_S1', 'Combo'), all)).toBe('CMB1_S1');
    expect(punchCodeOf('MGKIT64_SWM_S_N1', sku('MGKIT64_SWM_S_N1', 'Gift Kit'), all)).toBe('MGKIT64_SWM_S_N1');
  });
});
