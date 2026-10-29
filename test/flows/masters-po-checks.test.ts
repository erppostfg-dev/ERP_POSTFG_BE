import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/constants';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, resetDb } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';

/*
 * Flow (2026-10-28): what is changed on the Masters pages must change what the PO checks decide for NEW POs.
 * A clean BigBasket PO passes with the seeded masters; each switch-off / edit through the API must send it to review
 * with the right reason, and switching back on / fixing must let it pass again.
 */
let m: Masters;
let admin: TestLogin;
const P = '/api/v1/masters';

const check = async () => {
  const reader = new MasterDataReader(await db());
  const r = await validatePo(bigBasketPo(m), await reader.forChannel(CHANNELS.BIGBASKET), new Date('2026-10-28T06:00:00Z'));
  return { status: r.status, issues: r.issues.map((i) => i.type), text: r.issues.map((i) => i.message).join(' | '), r };
};
const switchRow = (type: string, id: number, active: boolean) => api().post(`${P}/active/${type}/${id}`).set('Cookie', admin.cookie).send({ active }).expect(200);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

describe('Masters changes -> PO checks', () => {
  it('a clean PO passes with the seeded masters (baseline of this flow)', async () => {
    const { issues, r } = await check();
    expect(issues).toEqual([]);
    expect(r.location).toMatchObject({ locationCode: m.locationCode, customerCode: 'CUST_TEST_1', facilityCode: m.facilityCode });
    expect(r.lines[0]).toMatchObject({ pepCode: m.pepCode, ourRate: 349.3 });
  });

  it('channel SKU switched off -> SKU not mapped; on again -> passes', async () => {
    await switchRow('channel_sku', m.channelSkuId, false);
    expect((await check()).issues).toEqual(['SKU_NOT_MAPPED']);
    await switchRow('channel_sku', m.channelSkuId, true);
    expect((await check()).issues).toEqual([]);
  });

  it('PEP SKU switched off -> SKU inactive', async () => {
    await switchRow('pep_sku', m.pepSkuId, false);
    const c = await check();
    expect(c.issues).toEqual(['SKU_NOT_MAPPED']);
    expect(c.text).toContain('inactive in the PEP SKU master');
  });

  it('location switched off -> location not found', async () => {
    await switchRow('location', m.locationId, false);
    expect((await check()).issues).toContain('LOCATION_NOT_MAPPED');
  });

  it('warehouse switched off -> location served by an inactive warehouse', async () => {
    await switchRow('facility', m.facilityId, false);
    const c = await check();
    expect(c.issues).toContain('LOCATION_NOT_MAPPED');
    expect(c.text).toContain('which is inactive in the Warehouses master');
  });

  it('a rate edited on the page is the rate the PO is checked against', async () => {
    await api().patch(`${P}/edit/channel_sku/${m.channelSkuId}`).set('Cookie', admin.cookie).send({ changes: { rateAfterMargin: 300 } }).expect(200);
    const c = await check();
    expect(c.r.lines[0].ourRate).toBe(300);
    expect(c.issues).toContain('PRICE_MISMATCH');
  });

  it('a Uniware customer code cleared on the location -> location incomplete', async () => {
    await (await db()).query('UPDATE details_channels SET uniware_customer_code = NULL WHERE id = ?', [m.locationId]);
    const c = await check();
    expect(c.issues).toContain('LOCATION_NOT_MAPPED');
    expect(c.text).toContain('uniware_customer_code');
  });
});
