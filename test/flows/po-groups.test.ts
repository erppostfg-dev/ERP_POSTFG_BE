import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OTHERS_CHANNEL, PO_GROUP, PO_GROUPS, poGroupOf } from '../../src/constants';
import { PepimsMigration1795500000000 } from '../../src/migrations/1795500000000-PepimsMigration';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, seedTransferChannel, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * PEPIMS -> prod migration, step 1 (2026-11-16, user): every PO has a group (Channel / D2C / Marketing / Institutional /
 * Internal Transfer / Others) from its channel, PEPIMS's own buyer name in partyName, and imported POs (importedFrom)
 * show on PO Overview although they never had a Uniware CSV of ours. The channel "Others" is only there for the FK:
 * the Masters pages leave it out like the two bulk channels.
 */

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;

/** An imported PEPIMS PO as the import tool will write it (no po_uploads row). */
const importedPo = (poNumber: string, channel: string, group: string, partyName: string | null) =>
  insert('master_purchase_orders', {
    poNumber, channel, poGroup: group, partyName, importedFrom: 'pepims', poDate: '2026-11-01', entryDate: '2026-11-01',
    statusActive: 'Active', statusPlanning: 'Confirmed', createdAt: new Date(), updatedAt: new Date(),
  });
const shipments = (query = '') => api().get(`${V}/po-overview/shipments${query}`).set('Cookie', admin.cookie);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

describe('PO group', () => {
  it('comes from the channel (bulk, D2C, warehouses, Others; anything else = Channel, any case)', () => {
    expect(poGroupOf('Bulk Marketing')).toBe(PO_GROUP.MARKETING);
    expect(poGroupOf('bulk institutional ')).toBe(PO_GROUP.INSTITUTIONAL);
    expect(poGroupOf('McaffeineB2C')).toBe(PO_GROUP.D2C);
    expect(poGroupOf('HYP_Website')).toBe(PO_GROUP.D2C);
    expect(poGroupOf('GGN_WAREHOUSE')).toBe(PO_GROUP.INTERNAL_TRANSFER);
    expect(poGroupOf('kol_warehouse')).toBe(PO_GROUP.INTERNAL_TRANSFER);
    expect(poGroupOf(OTHERS_CHANNEL.NAME)).toBe(PO_GROUP.OTHERS);
    expect(poGroupOf('Blinkit')).toBe(PO_GROUP.CHANNEL);
    expect(poGroupOf(null)).toBe(PO_GROUP.CHANNEL);
  });

  it('a PO saved by the pipeline is group Channel, no party name, not imported', async () => {
    const u = await runPo(bigBasketPo(m, { po_number: 'IRA93000001' }));
    const [po] = await rows<{ poGroup: string; partyName: string | null; importedFrom: string | null }>(
      'SELECT poGroup, partyName, importedFrom FROM master_purchase_orders WHERE uid = ?', [u.po_uid]);
    expect(po).toEqual({ poGroup: PO_GROUP.CHANNEL, partyName: null, importedFrom: null });
  });
});

describe('PO Overview with imported POs', () => {
  it('shows an imported PO without a Uniware mark; a PO of ours still needs the mark', async () => {
    const uid = await importedPo('PEP-OTH-1', OTHERS_CHANNEL.NAME, PO_GROUP.OTHERS, 'IIT BOMBAY');
    await runPo(bigBasketPo(m, { po_number: 'IRA93000002' })); // completed, not marked uploaded: stays off
    const list = await shipments().expect(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ uid: String(uid), poNumber: 'PEP-OTH-1', channel: 'Others', poGroup: 'Others', partyName: 'IIT BOMBAY', importedFrom: 'pepims' });
  });

  it('filters by group; an unknown group is refused; the dropdown and the Overview columns have it', async () => {
    await importedPo('PEP-OTH-2', OTHERS_CHANNEL.NAME, PO_GROUP.OTHERS, 'Ceat Limited');
    await importedPo('PEP-MKT-1', 'Bulk Marketing', PO_GROUP.MARKETING, 'Jiya');
    expect((await shipments('?poGroup=Others').expect(200)).body.meta.total).toBe(1);
    expect((await shipments('?poGroup=Others&poGroup=Marketing').expect(200)).body.meta.total).toBe(2);
    expect((await shipments('?poGroup=Channel').expect(200)).body.meta.total).toBe(0);
    const bad = await shipments('?poGroup=Nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(bad.body.error.details)).toContain('poGroup');
    const lines = await api().get(`${V}/po-overview/lines?poGroup=Marketing`).set('Cookie', admin.cookie).expect(200);
    expect(lines.body.meta.total).toBe(0); // imported without lines here
    const f = await api().get(`${V}/po-overview/filter-options`).set('Cookie', admin.cookie).expect(200);
    expect(f.body.data.poGroup).toEqual([...PO_GROUPS]);
    const cols = await api().get(`${V}/po-overview/columns`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(cols.body.data)).toContain('"poGroup"');
    expect(JSON.stringify(cols.body.data)).toContain('"partyName"');
  });
});

describe('the channel Others', () => {
  it('exists (switched off) for the FK, and the Masters pages leave it out', async () => {
    const [ch] = await rows<{ display_name: string; is_active: number }>('SELECT display_name, is_active FROM master_channels WHERE id = ?', [OTHERS_CHANNEL.ID]);
    expect(ch).toEqual({ display_name: 'Others', is_active: 0 });
    const list = await api().get(`${V}/masters/channel-customers`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(list.body.data)).not.toContain('"Others"');
    const form = await api().get(`${V}/masters/form-options`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(form.body.data)).not.toContain('"Others"');
  });
});

describe('migration PepimsMigration', () => {
  it('gives the POs that already exist their group from the channel', async () => {
    await seedTransferChannel(); // McaffeineB2C
    await insert('master_channels', { id: 9002, slug: 'ggn-warehouse', display_name: 'GGN_WAREHOUSE', db_aliases: ['GGN_WAREHOUSE'], has_processor: 0, is_active: 0 });
    const ours = (await runPo(bigBasketPo(m, { po_number: 'IRA93000003' }))).po_uid;
    const mkt = await importedPo('OLD-MKT', 'Bulk Marketing', PO_GROUP.CHANNEL, null);
    const inst = await importedPo('OLD-INST', 'Bulk Institutional', PO_GROUP.CHANNEL, null);
    const d2c = await importedPo('OLD-D2C', 'McaffeineB2C', PO_GROUP.CHANNEL, null);
    const wh = await importedPo('OLD-WH', 'GGN_WAREHOUSE', PO_GROUP.CHANNEL, null);
    const qr = (await db()).createQueryRunner();
    try {
      // the rows above are kept (columns dropped, added back, filled from the channel)
      const mig = new PepimsMigration1795500000000();
      await mig.down(qr);
      await mig.up(qr);
    } finally {
      await qr.release();
    }
    const groups = await rows<{ uid: string; poGroup: string }>('SELECT uid, poGroup FROM master_purchase_orders ORDER BY uid');
    const of = (uid: number | string | null) => groups.find((g) => String(g.uid) === String(uid))?.poGroup;
    expect([of(ours), of(mkt), of(inst), of(d2c), of(wh)]).toEqual([
      PO_GROUP.CHANNEL, PO_GROUP.MARKETING, PO_GROUP.INSTITUTIONAL, PO_GROUP.D2C, PO_GROUP.INTERNAL_TRANSFER]);
    const [others] = await rows<{ n: number }>('SELECT COUNT(*) n FROM master_channels WHERE id = ?', [OTHERS_CHANNEL.ID]);
    expect(Number(others.n)).toBe(1);
  });
});
