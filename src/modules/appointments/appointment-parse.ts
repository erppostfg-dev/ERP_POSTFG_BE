import { APPOINTMENT_ACTION, AppointmentAction, AppointmentChannel, CHANNELS } from '../../constants';

/*
 * Reads one appointment email (constants/appointments.ts). The subject decides (channel, PO number, status, date);
 * the body adds the details. Formats seen in the mailbox (60 days, 2026-11-16):
 *   Scootsy  "Appointment CREATED - 27-11-2026 | PurchaseOrder - LKOPO204938" + HTML table: PO ID, Appointment Status,
 *            Slot Date, Slot Time, Appointment ID, Warehouse Name, Vendor Code, Booked Quantity
 *   Zepto    "Purchase Order Scheduled, P6216282"     body: PO Number, PO Quantity, MH Name, Scheduled Date: yyyy-mm-dd
 *            "Purchase Order ReScheduled, P6120990"   + Old Scheduled Date, New Scheduled Date, Remarks
 *            "Purchase Order Un-Scheduled, P5937946"  + Previous Scheduled Date
 * Zepto's plain text often has no space between fields ("P6216282PO Quantity: 354MH Name: ..."): read by the labels.
 */

export interface ParsedAppointment {
  channel: AppointmentChannel;
  poNumber: string;
  action: AppointmentAction;
  /** yyyy-mm-dd: the new date, or the date that was cancelled. */
  appointmentDate: string;
  previousDate: string | null;
  slot: string | null;
  appointmentRef: string | null;
  hub: string | null;
  quantity: number | null;
  remarks: string | null;
}

const SCOOTSY_SUBJECT = /Appointment\s+(CREATED|CANCELLED)\s*-\s*(\d{2})-(\d{2})-(\d{4})\s*\|\s*PurchaseOrder\s*-\s*(\S+)/i;
const ZEPTO_SUBJECT = /Purchase\s+Order\s+(Scheduled|Re-?Scheduled|Un-?Scheduled)\s*,\s*(\S+)/i;
const ISO_DAY = /(\d{4}-\d{2}-\d{2})/;
const ZEPTO_STOP = '(?=Old Scheduled Date|New Scheduled Date|Previous Scheduled Date|Scheduled Date|Remarks:|Please Note|Best regards|Regards|$)';

/** A real calendar day, or null. */
const validDay = (iso: string | undefined | null): string | null => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
};

const clip = (v: string | undefined | null, max: number): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const int = (v: string | undefined | null): number | null => {
  const n = Number((v ?? '').replace(/[^\d]/g, ''));
  return v && Number.isInteger(n) && n >= 0 && n < 2_147_483_647 ? n : null;
};

/** The email body as one line of text: an HTML table with its cells as "value |" (Scootsy), else the plain text. */
export const bodyText = (text: string | undefined, html: string | undefined): string => {
  const raw = text?.trim() && !/<t[dh][\s>]/i.test(html ?? '') ? text : (html || text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(br|\/p|\/tr|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
  return raw.replace(/\s+/g, ' ').trim();
};

/** Scootsy table cell after a header cell: "Slot Time | 9 AM - 11 AM |". */
const cell = (body: string, label: string): string | undefined =>
  body.match(new RegExp(`${label}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i'))?.[1];

const parseScootsy = (subject: string, body: string): ParsedAppointment | null => {
  const m = subject.match(SCOOTSY_SUBJECT);
  if (!m) return null;
  const day = validDay(`${m[4]}-${m[3]}-${m[2]}`);
  if (!day) return null;
  return {
    channel: CHANNELS.SCOOTSY,
    poNumber: m[5].trim(),
    action: m[1].toUpperCase() === 'CANCELLED' ? APPOINTMENT_ACTION.CANCELLED : APPOINTMENT_ACTION.CREATED,
    appointmentDate: day,
    previousDate: null,
    slot: clip(cell(body, 'Slot Time'), 100),
    appointmentRef: clip(cell(body, 'Appointment ID'), 100),
    hub: clip(cell(body, 'Warehouse Name'), 150),
    quantity: int(cell(body, 'Booked Quantity')),
    remarks: null,
  };
};

const zeptoField = (body: string, label: string, value: string): string | undefined =>
  body.match(new RegExp(`${label}\\s*:\\s*${value}`, 'i'))?.[1];

const parseZepto = (subject: string, body: string): ParsedAppointment | null => {
  const m = subject.match(ZEPTO_SUBJECT);
  if (!m) return null;
  const kind = m[1].toLowerCase().replace('-', '');
  const date = (label: string) => validDay(zeptoField(body, label, ISO_DAY.source));
  // "Scheduled Date" alone (not Old / New / Previous)
  const plain = validDay(body.match(/(?<!(?:Old|New|Previous)\s?)Scheduled Date\s*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]);
  let action: AppointmentAction;
  let day: string | null;
  let previous: string | null = null;
  if (kind === 'unscheduled') {
    action = APPOINTMENT_ACTION.CANCELLED;
    day = date('Previous Scheduled Date') ?? plain;
  } else if (kind === 'rescheduled') {
    action = APPOINTMENT_ACTION.RESCHEDULED;
    day = date('New Scheduled Date');
    previous = date('Old Scheduled Date');
  } else {
    action = APPOINTMENT_ACTION.CREATED;
    day = plain;
  }
  if (!day) return null;
  return {
    channel: CHANNELS.ZEPTO,
    poNumber: m[2].trim(),
    action,
    appointmentDate: day,
    previousDate: previous,
    slot: null,
    appointmentRef: null,
    hub: clip(zeptoField(body, 'MH Name', `(.+?)\\s*${ZEPTO_STOP}`), 150),
    quantity: int(zeptoField(body, 'PO Quantity', '(\\d+)')),
    remarks: clip(zeptoField(body, 'Remarks', `(.*?)\\s*${ZEPTO_STOP}`), 255),
  };
};

const BLINKIT_SUBJECT = /\bPO_(?:BCPL|BLINK)\b/i;
const BLINKIT_CANCEL_SUBJECT = /\|\s*Appointment Cancellation\s*\|/i;

/** Blinkit (PartnersBiz): scheduled / rescheduled (in the PO's thread) and cancellation. */
const parseBlinkit = (subject: string, body: string): ParsedAppointment | null => {
  const ref = clip(body.match(/Appointment ID[\s:|]*(\d+)/i)?.[1], 100);
  if (BLINKIT_CANCEL_SUBJECT.test(subject)) {
    const po = body.match(/PO Numbers?\s+(\d+)[\s,]*has been cancelled/i)?.[1];
    const day = validDay(body.match(/Appointment Date[\s:|]*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? subject.match(/^\s*\[(\d{4}-\d{2}-\d{2})\]/)?.[1]);
    if (!po || !day) return null;
    return {
      channel: CHANNELS.BLINKIT, poNumber: po, action: APPOINTMENT_ACTION.CANCELLED, appointmentDate: day, previousDate: null,
      slot: null, appointmentRef: ref, hub: clip(body.match(/Facility Name[\s:|]*(.+?)[\s|]*(?=We understand|Please confirm|Thank|$)/i)?.[1], 150),
      quantity: null, remarks: null,
    };
  }
  if (!BLINKIT_SUBJECT.test(subject)) return null;
  const m = body.match(/PO number\s+(\d+)\s+has been (scheduled on|rescheduled to)\s+(\d{4}-\d{2}-\d{2})(?:\s+for\s+(\d{1,2}:\d{2})(?::\d{2})?)?/i);
  const day = validDay(m?.[3]);
  if (!m || !day) return null;
  return {
    channel: CHANNELS.BLINKIT, poNumber: m[1],
    action: /rescheduled/i.test(m[2]) ? APPOINTMENT_ACTION.RESCHEDULED : APPOINTMENT_ACTION.CREATED,
    appointmentDate: day, previousDate: null, slot: clip(m[4], 100), appointmentRef: ref,
    hub: clip(body.match(/report to\s+(?:HOT\s+)?(.+?)\s+at least/i)?.[1], 150), quantity: null, remarks: null,
  };
};

/** One email -> what it says, or null when it is in none of the known formats. */
export const parseAppointmentEmail = (subject: string, body: string): ParsedAppointment | null =>
  parseScootsy(subject, body) ?? parseZepto(subject, body) ?? parseBlinkit(subject, body);
