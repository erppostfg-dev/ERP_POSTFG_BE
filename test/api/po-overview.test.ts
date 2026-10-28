import type { AddressInfo } from 'net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo, type Upload } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * PO Overview (2026-10-28): only POs marked "uploaded to Uniware" show; access follows the person's team
 * (users.po_team -> team_column_access, seeded by the migrations), page access and, for warehouse / logistics, their
 * warehouses (user_facilities). Every saved field is a shipment_logs row (History) and a live change.
 * POs get here the real way: chain -> verify -> download the CSV -> mark uploaded.
 */
covers([
  'GET /po-overview/shipments', 'GET /po-overview/lines', 'GET /po-overview/shipments/:uid', 'GET /po-overview/filter-options',
  'GET /po-overview/columns', 'PATCH /po-overview/shipments/:uid', 'GET /po-overview/shipments/:uid/history', 'GET /po-overview/edit-options',
  'GET /po-overview/events', 'GET /po-overview/changes',
]);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;

/** A PO all the way to PO Overview (as the team does it on the Processed tab). */
const onOverview = async (poNumber: string): Promise<Upload> => {
  const u = await runPo(bigBasketPo(m, { po_number: poNumber }));
  await api().post(`${V}/po-verify/${u.id}/verify`).set('Cookie', admin.cookie).send({}).expect(200);
  await api().get(`${V}/po-review/${u.id}/uniware-csv`).set('Cookie', admin.cookie).expect(200);
  await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', admin.cookie).send({ uploadIds: [u.id] }).expect(200);
  return u;
};
/** A person with a PO Overview team (and warehouses, for warehouse / logistics). */
const teamMember = async (team: string, role = 'operations-executive', facilityIds: number[] = []) => {
  const who = await loginAs(role);
  await (await db()).query('UPDATE users SET po_team = ? WHERE id = ?', [team, who.userId]);
  for (const f of facilityIds) await insert('user_facilities', { user_id: who.userId, facility_id: f });
  return who;
};
const patch = (who: TestLogin, uid: string, changes: Record<string, { from: unknown; to: unknown }>, remark?: string) =>
  api().patch(`${V}/po-overview/shipments/${uid}`).set('Cookie', who.cookie).send({ changes, ...(remark ? { remark } : {}) });

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

describe('what PO Overview shows', () => {
  it('401 / 403; a page viewer reads', async () => {
    expect((await api().get(`${V}/po-overview/shipments`)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(`${V}/po-overview/shipments`).set('Cookie', nobody.cookie)).status).toBe(403);
    const viewer = await loginAs('viewer');
    expect((await api().get(`${V}/po-overview/shipments`).set('Cookie', viewer.cookie)).status).toBe(200);
  });

  it('only POs marked uploaded to Uniware; undo takes it off again', async () => {
    const shown = await onOverview('IRA92000001');
    await runPo(bigBasketPo(m, { po_number: 'IRA92000002' })); // completed, not uploaded yet
    const list = await api().get(`${V}/po-overview/shipments`).set('Cookie', admin.cookie).expect(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ uid: shown.po_uid, poNumber: 'IRA92000001', channel: 'BigBasket' });
    await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', admin.cookie).send({ uploadIds: [shown.id], undo: true }).expect(200);
    expect((await api().get(`${V}/po-overview/shipments`).set('Cookie', admin.cookie).expect(200)).body.meta.total).toBe(0);
  });

  it('filters, paging, lines and one shipment', async () => {
    const a = await onOverview('IRA92000011');
    await onOverview('IRA92000012');
    const filtered = await api().get(`${V}/po-overview/shipments?channel=BigBasket&pageSize=1&page=2`).set('Cookie', admin.cookie).expect(200);
    expect(filtered.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(filtered.body.data).toHaveLength(1);
    expect((await api().get(`${V}/po-overview/shipments?channel=Zepto`).set('Cookie', admin.cookie).expect(200)).body.meta.total).toBe(0);
    const lines = await api().get(`${V}/po-overview/lines?skuCode=${m.pepCode}`).set('Cookie', admin.cookie).expect(200);
    expect(lines.body.meta.total).toBe(2);
    const one = await api().get(`${V}/po-overview/shipments/${a.po_uid}`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(one.body.data)).toContain(m.pepCode);
    expect((await api().get(`${V}/po-overview/shipments/999999`).set('Cookie', admin.cookie)).status).toBe(404);
  });

  it('filter-options and edit-options give the dropdowns', async () => {
    await onOverview('IRA92000021');
    const f = await api().get(`${V}/po-overview/filter-options`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(f.body.data)).toContain('BigBasket');
    const e = await api().get(`${V}/po-overview/edit-options`).set('Cookie', admin.cookie).expect(200);
    expect(e.body.data).toHaveProperty('statuses');
    expect(e.body.data).toHaveProperty('transporters');
  });
});

describe('columns and who may edit them', () => {
  it('admin without a team edits every group; a page viewer edits nothing', async () => {
    const adm = (await api().get(`${V}/po-overview/columns`).set('Cookie', admin.cookie).expect(200)).body.data;
    const access = (d: { teams: { key: string; access: string }[] }) => Object.fromEntries(d.teams.map((g) => [g.key, g.access]));
    expect(Object.keys(access(adm)).sort()).toEqual(['accounts', 'copt', 'logistics', 'planning', 'warehouse']);
    expect(Object.values(access(adm)).every((a) => a === 'edit')).toBe(true);
    const viewer = await loginAs('viewer');
    const v = (await api().get(`${V}/po-overview/columns`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(Object.values(access(v)).some((a) => a === 'edit')).toBe(false);
  });

  it('a warehouse person: edits warehouse columns, sees planning, does not see accounts', async () => {
    const wh = await teamMember('warehouse', 'operations-executive', [m.facilityId]);
    const d = (await api().get(`${V}/po-overview/columns`).set('Cookie', wh.cookie).expect(200)).body.data;
    const access = Object.fromEntries((d.teams as { key: string; access: string }[]).map((g) => [g.key, g.access]));
    expect(access).toMatchObject({ warehouse: 'edit', planning: 'view', logistics: 'view' });
    // accounts is hidden from the warehouse team: the group is not sent at all
    expect(access).not.toHaveProperty('accounts');
    expect(d).toMatchObject({ team: 'warehouse', facilityScoped: true, facilities: [m.facilityCode] });
  });
});

describe('saving a shipment', () => {
  it('saves a field with old -> new in History and as a live change', async () => {
    const u = await onOverview('IRA92000031');
    const res = await patch(admin, u.po_uid!, { remarksPlanning: { from: null, to: 'call DC first' } }, 'from planning call');
    expect(res.status).toBe(200);
    expect((await rows<{ r: string }>('SELECT remarksPlanning r FROM master_purchase_orders WHERE uid = ?', [u.po_uid]))[0].r).toBe('call DC first');
    const h = await api().get(`${V}/po-overview/shipments/${u.po_uid}/history`).set('Cookie', admin.cookie).expect(200);
    expect(h.body.data[0]).toMatchObject({ field: 'remarksPlanning', newValue: 'call DC first', remark: 'from planning call', byEmail: admin.email });
    const changes = await api().get(`${V}/po-overview/changes?after=0`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(changes.body)).toContain(u.po_uid!);
  });

  it('409 when someone else saved the field meanwhile (from differs); nothing saved', async () => {
    const u = await onOverview('IRA92000041');
    await patch(admin, u.po_uid!, { remarksPlanning: { from: null, to: 'first' } }).expect(200);
    const res = await patch(admin, u.po_uid!, { remarksPlanning: { from: null, to: 'second' } }).expect(409);
    expect(res.body.error.code).toBe('FIELDS_CHANGED_MEANWHILE');
    expect((await rows<{ r: string }>('SELECT remarksPlanning r FROM master_purchase_orders WHERE uid = ?', [u.po_uid]))[0].r).toBe('first');
  });

  it('a team edits only its own columns; locked columns (PO number) never', async () => {
    const u = await onOverview('IRA92000051');
    const planner = await teamMember('planning', 'operations-executive');
    await patch(planner, u.po_uid!, { remarksPlanning: { from: null, to: 'ok' } }).expect(200);
    const refused = await patch(planner, u.po_uid!, { remarksWarehouse: { from: null, to: 'not mine' } }).expect(403);
    expect(refused.body.error.code).toBe('FIELDS_NOT_EDITABLE');
    const locked = await patch(admin, u.po_uid!, { poNumber: { from: 'IRA92000051', to: 'X' } }).expect(403);
    expect(locked.body.error.code).toBe('FIELDS_NOT_EDITABLE');
    expect(await count('shipment_logs', "field_name IN ('remarksWarehouse', 'poNumber')")).toBe(0);
  });

  it('warehouse team: edits shipments of its own warehouse only', async () => {
    const u = await onOverview('IRA92000061');
    const other = await insert('master_facilities', { code: 'OTHER_WH', name: 'Other', is_active: 1, source: 'manual', uniware_export: 0 });
    const outsider = await teamMember('warehouse', 'operations-executive', [other]);
    const one = await api().get(`${V}/po-overview/shipments/${u.po_uid}`).set('Cookie', outsider.cookie).expect(200);
    expect(one.body.data.canEdit ?? one.body.data.shipment?.canEdit).toBe(false);
    expect((await patch(outsider, u.po_uid!, { remarksWarehouse: { from: null, to: 'x' } }).expect(403)).body.error.code).toBe('SHIPMENT_NOT_EDITABLE');
    const insider = await teamMember('warehouse', 'operations-executive', [m.facilityId]);
    await patch(insider, u.po_uid!, { remarksWarehouse: { from: null, to: 'packed' } }).expect(200);
  });

  it('a page viewer cannot save; bad values are refused', async () => {
    const u = await onOverview('IRA92000071');
    const viewer = await loginAs('viewer');
    expect((await patch(viewer, u.po_uid!, { remarksPlanning: { from: null, to: 'x' } })).status).toBe(403);
    expect((await patch(admin, u.po_uid!, { noOfBoxes: { from: null, to: 'many' } })).status).toBe(400);
    expect((await patch(admin, u.po_uid!, { statusPlanning: { from: null, to: 'NOT A STATUS' } })).status).toBe(400);
    expect(await count('shipment_logs', "field_name IN ('remarksPlanning', 'noOfBoxes', 'statusPlanning')")).toBe(0);
  });
});

describe('live updates', () => {
  it('events: an SSE stream for page viewers', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const ctl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}${V}/po-overview/events`, { headers: { Cookie: admin.cookie }, signal: ctl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      ctl.abort();
      expect((await fetch(`http://127.0.0.1:${port}${V}/po-overview/events`)).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
