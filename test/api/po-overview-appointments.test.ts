import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAppointmentEmail, bodyText } from '../../src/modules/appointments/appointment-parse';
import { applyWaiting, ingestAppointmentEmail } from '../../src/modules/appointments/appointment.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

/*
 * Appointment dates from email (2026-11-16, constants/appointments.ts): Scootsy / Zepto emails of the Gmail label
 * "Appointment Date" set the PO's appointment date (newest change wins, cancelled clears it), every change in History,
 * PO Overview shows where the date came from (filter + mark) and the appointment history per shipment.
 * The Gmail part (listing the label) is a thin wrapper; the emails go in here through ingestAppointmentEmail.
 */
covers(['GET /po-overview/shipments/:uid/appointments']);

const V = '/api/v1';
let m: Masters;
let admin: TestLogin;

const scootsyHtml = (po: string, status: string, date: string) => `<html><head><style>.appointment-details th { padding: 8px; }</style></head><body>
<p>Hi,</p><p>Please find the appointment details below:</p><table class="appointment-details">
<tr><th>PO ID</th><td>${po}</td></tr><tr><th>Appointment Status</th><td>${status}</td></tr><tr><th>Slot Date</th><td>${date}</td></tr>
<tr><th>Slot Time</th><td>9 AM - 11 AM</td></tr><tr><th>Appointment ID</th><td>a1dde0c4</td></tr><tr><th>Warehouse Name</th><td>LKO IM1</td></tr>
<tr><th>Vendor Code</th><td>1N96211356</td></tr><tr><th>Booked Quantity</th><td>80</td></tr></table><p>Thanks</p></body></html>`;
const scootsy = (gmailId: string, po: string, status: 'CREATED' | 'CANCELLED', date: string, at: string) => ({
  gmailId, subject: `Appointment ${status} - ${date} | PurchaseOrder - ${po}`, receivedAt: new Date(at), html: scootsyHtml(po, status, date),
});
const zepto = (gmailId: string, kind: 'Scheduled' | 'ReScheduled' | 'Un-Scheduled', po: string, text: string, at: string) => ({
  gmailId, subject: `Purchase Order ${kind}, ${po}`, receivedAt: new Date(at), text,
});

/** A PO on PO Overview, saved under a Scootsy / Zepto channel with this PO number. */
const onOverview = async (channel: 'Scootsy Logistics' | 'Zepto', poNumber: string): Promise<string> => {
  const u = await runPo(bigBasketPo(m, { po_number: `IRA${Date.now() % 100000000}` }));
  await api().post(`${V}/po-verify/${u.id}/verify`).set('Cookie', admin.cookie).send({}).expect(200);
  await api().get(`${V}/po-review/${u.id}/uniware-csv`).set('Cookie', admin.cookie).expect(200);
  await api().post(`${V}/po-review/uniware-uploaded`).set('Cookie', admin.cookie).send({ uploadIds: [u.id] }).expect(200);
  await (await db()).query('UPDATE master_purchase_orders SET channel = ?, poNumber = ? WHERE uid = ?', [channel, poNumber, u.po_uid]);
  return u.po_uid!;
};
const po = async (uid: string) => (await rows<{ cur: string | null; first: string | null; all: unknown }>(
  "SELECT DATE_FORMAT(currentAppointmentDate, '%Y-%m-%d') cur, DATE_FORMAT(firstAppointmentDateCOPT, '%Y-%m-%d') first, allAppointmentDate `all` FROM master_purchase_orders WHERE uid = ?", [uid]))[0];
const listed = async (query = '') => (await api().get(`${V}/po-overview/shipments?${query}`).set('Cookie', admin.cookie).expect(200)).body;
const history = (uid: string, who = admin) => api().get(`${V}/po-overview/shipments/${uid}/appointments`).set('Cookie', who.cookie);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  await insert('master_channels', { id: 20, slug: 'scootsy', display_name: 'Scootsy Logistics', db_aliases: ['Scootsy Logistics'], has_processor: 1, is_active: 1 });
  await insert('master_channels', { id: 2, slug: 'zepto', display_name: 'Zepto', db_aliases: ['Zepto'], has_processor: 1, is_active: 1 });
});
afterAll(closeDb);

describe('reading the emails', () => {
  it('Scootsy CREATED / CANCELLED: subject + table details', () => {
    const e = scootsy('g1', 'LKOPO204938', 'CREATED', '27-11-2026', '2026-11-16T05:20:34Z');
    expect(parseAppointmentEmail(e.subject, bodyText(undefined, e.html))).toEqual({
      channel: 'scootsy', poNumber: 'LKOPO204938', action: 'created', appointmentDate: '2026-11-27', previousDate: null,
      slot: '9 AM - 11 AM', appointmentRef: 'a1dde0c4', hub: 'LKO IM1', quantity: 80, remarks: null,
    });
    const c = scootsy('g2', 'JPAPO85164', 'CANCELLED', '16-11-2026', '2026-11-16T06:24:33Z');
    expect(parseAppointmentEmail(c.subject, bodyText(undefined, c.html))).toMatchObject({ action: 'cancelled', appointmentDate: '2026-11-16' });
  });

  it('Zepto Scheduled / ReScheduled / Un-Scheduled, fields glued together as in the real emails', () => {
    const s = 'Hi Team,The appointment for the following PO has been confirmed. PO Details: PO Number: P6216282PO Quantity: 354MH Name: CHN-SS-MH-THIRUVALLURScheduled Date: 2026-11-23Please Note: Kindly share the invoice';
    expect(parseAppointmentEmail('Purchase Order Scheduled, P6216282', bodyText(s, undefined))).toEqual({
      channel: 'zepto', poNumber: 'P6216282', action: 'created', appointmentDate: '2026-11-23', previousDate: null,
      slot: null, appointmentRef: null, hub: 'CHN-SS-MH-THIRUVALLUR', quantity: 354, remarks: null,
    });
    const r = 'PO Details:\n PO Number: P6120990 PO Quantity: 660 MH Name: PUN-DRY-MH2-KOREGAON Old Scheduled Date: 2026-11-10 New Scheduled Date: 2026-11-17 Remarks: rePlease Note: Kindly';
    expect(parseAppointmentEmail('Purchase Order ReScheduled, P6120990', bodyText(r, undefined))).toMatchObject({
      action: 'rescheduled', appointmentDate: '2026-11-17', previousDate: '2026-11-10', hub: 'PUN-DRY-MH2-KOREGAON', quantity: 660, remarks: 're',
    });
    const u = 'PO Number: P5937946PO Quantity: 862MH Name: COI-DRY-MH-SULURPrevious Scheduled Date:2026-11-19Best regards';
    expect(parseAppointmentEmail('Purchase Order Un-Scheduled, P5937946', bodyText(u, undefined))).toMatchObject({
      action: 'cancelled', appointmentDate: '2026-11-19', hub: 'COI-DRY-MH-SULUR',
    });
  });

  it('anything else (reply, no date, impossible date) is not read', () => {
    expect(parseAppointmentEmail('Re: hello', 'x')).toBeNull();
    expect(parseAppointmentEmail('Purchase Order Scheduled, P1', 'PO Number: P1')).toBeNull();
    expect(parseAppointmentEmail('Appointment CREATED - 31-02-2026 | PurchaseOrder - X1', '')).toBeNull();
  });
});

describe('applying them to the PO', () => {
  it('created -> date + First Appointment Date + History; PO Overview: from email, filter, history', async () => {
    const uid = await onOverview('Scootsy Logistics', 'LKOPO204938');
    expect(await ingestAppointmentEmail(scootsy('g1', 'LKOPO204938', 'CREATED', '27-11-2026', '2026-11-16T05:20:34Z'))).toBe('applied');
    expect(await po(uid)).toMatchObject({ cur: '2026-11-27', first: '2026-11-27', all: ['2026-11-27'] });
    const logs = await rows<{ field_name: string; source: string; new_value: string; remark: string }>('SELECT field_name, source, new_value, remark FROM shipment_logs WHERE shipment_uid = ? AND user_id IS NULL AND field_name LIKE ? ORDER BY id', [uid, '%Appointment%']);
    expect(logs.map((l) => l.field_name)).toEqual(['firstAppointmentDateCOPT', 'currentAppointmentDate']);
    expect(logs[1]).toMatchObject({ source: 'system', new_value: '2026-11-27' });
    expect(logs[1].remark).toContain('Scootsy appointment email: CREATED, slot 9 AM - 11 AM, ID a1dde0c4');

    expect((await listed()).data[0]).toMatchObject({ uid, currentAppointmentDate: '2026-11-27', appointmentSource: 'email' });
    expect((await listed('appointmentSource=email')).meta.total).toBe(1);
    expect((await listed('appointmentSource=typed')).meta.total).toBe(0);
    const h = (await history(uid).expect(200)).body.data;
    expect(h[0]).toMatchObject({ kind: 'email', by: 'Scootsy', action: 'created', date: '2026-11-27', slot: '9 AM - 11 AM', appointmentRef: 'a1dde0c4', hub: 'LKO IM1', quantity: 80, outcome: 'applied', current: true });
    // the same email again (another run) = nothing new
    expect(await ingestAppointmentEmail(scootsy('g1', 'LKOPO204938', 'CREATED', '27-11-2026', '2026-11-16T05:20:34Z'))).toBe('known');
    expect(await count('po_appointment_emails')).toBe(1);
  });

  it('cancelled -> date cleared (even with a First Appointment Date), "cancelled" mark + filter, Not assigned', async () => {
    const uid = await onOverview('Scootsy Logistics', 'JPAPO85164');
    await ingestAppointmentEmail(scootsy('g1', 'JPAPO85164', 'CREATED', '16-11-2026', '2026-11-12T05:00:00Z'));
    expect(await ingestAppointmentEmail(scootsy('g2', 'JPAPO85164', 'CANCELLED', '16-11-2026', '2026-11-14T05:00:00Z'))).toBe('applied');
    expect(await po(uid)).toMatchObject({ cur: null, first: '2026-11-16' });
    expect((await listed()).data[0]).toMatchObject({ currentAppointmentDate: null, appointmentSource: 'cancelled' });
    expect((await listed('appointmentSource=cancelled')).meta.total).toBe(1);
    expect((await listed('appointmentSource=none')).meta.total).toBe(0);
    expect((await listed('notAssigned=appointmentDate')).meta.total).toBe(1);
    const h = (await history(uid).expect(200)).body.data;
    expect(h.map((x: { action: string; current: boolean }) => [x.action, x.current])).toEqual([['cancelled', true], ['created', false]]);
  });

  it('newest wins: a person edits after the email -> typed; an OLDER email is kept, not applied; a newer one applies', async () => {
    const uid = await onOverview('Zepto', 'P6216282');
    await insert('master_appointment_remarks', { list: 'appointment_change', remark: 'Channel moved it', sort_order: 1, is_active: 1, source: 'manual' });
    await ingestAppointmentEmail(zepto('g1', 'Scheduled', 'P6216282', 'PO Number: P6216282PO Quantity: 354MH Name: CHN-SS-MHScheduled Date: 2026-11-23Please Note', '2026-11-14T10:30:00Z'));
    await api().patch(`${V}/po-overview/shipments/${uid}`).set('Cookie', admin.cookie)
      .send({ changes: { currentAppointmentDate: { from: '2026-11-23', to: '2026-11-25' } }, remark: 'Channel moved it' }).expect(200);
    expect((await listed()).data[0]).toMatchObject({ currentAppointmentDate: '2026-11-25', appointmentSource: 'typed' });
    expect((await listed('appointmentSource=typed')).meta.total).toBe(1);

    // received before the person's save (it reached us late): history only
    expect(await ingestAppointmentEmail(zepto('g2', 'ReScheduled', 'P6216282', 'PO Number: P6216282 Old Scheduled Date: 2026-11-23 New Scheduled Date: 2026-11-24 Remarks: x', '2026-11-15T10:00:00Z'))).toBe('older');
    expect((await po(uid)).cur).toBe('2026-11-25');
    // a newer one wins over the person's
    expect(await ingestAppointmentEmail(zepto('g3', 'ReScheduled', 'P6216282', 'PO Number: P6216282 Old Scheduled Date: 2026-11-25 New Scheduled Date: 2026-11-28 Remarks: dock full', new Date(Date.now() + 60_000).toISOString()))).toBe('applied');
    expect((await listed()).data[0]).toMatchObject({ currentAppointmentDate: '2026-11-28', appointmentSource: 'email' });

    const h = (await history(uid).expect(200)).body.data as { kind: string; action: string; outcome: string | null; by: string | null; current: boolean }[];
    expect(h.map((x) => [x.kind, x.action, x.outcome])).toEqual([
      ['email', 'rescheduled', 'applied'], ['change', 'set', null], ['email', 'rescheduled', 'older'], ['email', 'created', 'applied'],
    ]);
    expect(h[1].by).toBeTruthy();
    expect(h.filter((x) => x.current)).toHaveLength(1);
  });

  it('PO not saved yet -> waiting, applied when the PO is saved; unreadable kept', async () => {
    expect(await ingestAppointmentEmail(zepto('g1', 'Scheduled', 'P5937946', 'PO Number: P5937946 Scheduled Date: 2026-11-19 Regards', '2026-11-12T10:00:00Z'))).toBe('waiting');
    expect(await ingestAppointmentEmail({ gmailId: 'g2', subject: 'Purchase Order Scheduled, P1', receivedAt: new Date(), text: 'no date here' })).toBe('unreadable');
    expect(await applyWaiting()).toBe(0);
    const uid = await onOverview('Zepto', 'P5937946');
    expect(await applyWaiting()).toBe(1);
    expect((await po(uid)).cur).toBe('2026-11-19');
    expect((await rows<{ outcome: string }>('SELECT outcome FROM po_appointment_emails ORDER BY id')).map((r) => r.outcome)).toEqual(['applied', 'unreadable']);
    // another channel's PO with the same number is never touched
    expect(await ingestAppointmentEmail(scootsy('g3', 'P5937946', 'CREATED', '30-11-2026', new Date(Date.now() + 60_000).toISOString()))).toBe('waiting');
    expect((await po(uid)).cur).toBe('2026-11-19');
  });
});

describe('access', () => {
  it('history: 401, viewer reads, unknown 404, Logistics columns hidden 403; bad filter 400', async () => {
    const uid = await onOverview('Scootsy Logistics', 'X1');
    expect((await api().get(`${V}/po-overview/shipments/${uid}/appointments`)).status).toBe(401);
    expect((await history(uid, await loginAs('viewer'))).status).toBe(200);
    expect((await history('999999999', admin)).status).toBe(404);
    const wh = await loginAs('operations-executive');
    await (await db()).query('UPDATE users SET po_team = ? WHERE id = ?', ['warehouse', wh.userId]);
    await (await db()).query("UPDATE team_column_access SET access = 'none' WHERE team = 'warehouse' AND column_group = 'logistics'");
    expect((await history(uid, wh)).body.error?.code).toBe('APPOINTMENTS_HIDDEN');
    const bad = await api().get(`${V}/po-overview/shipments?appointmentSource=maybe`).set('Cookie', admin.cookie).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
});
