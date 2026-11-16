import { CHANNELS } from './channels';

/*
 * Appointment dates from email (2026-11-16, user: "use these emails to update the appointment date; show in PO
 * Overview which came from the email and which not; click the column = that row's history"). Revert = remove
 * modules/appointments, this file, the entity + migration AppointmentEmails and the few lines that call them.
 *
 * Gmail filters (made by the user) put the label APPOINTMENT_LABEL on:
 *   Scootsy (Swiggy Instamart vendor portal): "Appointment CREATED|CANCELLED - dd-mm-yyyy | PurchaseOrder - <PO>"
 *   Zepto: "Purchase Order Scheduled|ReScheduled|Un-Scheduled, <PO>"
 *   Blinkit (2026-11-16, PartnersBiz): replies in the PO's own thread (subject PO_BCPL / PO_BLINK ..., no attachment)
 *     "The appointment for PO number <PO> has been scheduled on <yyyy-mm-dd> for <hh:mm:ss> ... Appointment ID: <n>" /
 *     "... has been rescheduled to ..."; "[<date>] <facility> | Appointment Cancellation |" ("PO Numbers <PO> has
 *     been cancelled ... Appointment ID / Appointment Date / Facility Name"). Blinkit often sends the same email 2-7
 *     times: a repeat of the PO's last email (same status, date, slot, ID) is kept, applied, with no new History row.
 * The server reads that label every POLL_MINUTES (own reader, not the PO intake), keeps every email as a row of
 * po_appointment_emails and applies it to the saved PO: the newest change wins (an email or a person's edit),
 * cancelled / un-scheduled clears the date.
 */
export const APPOINTMENTS = {
  /** Gmail label, exactly as in Gmail. */
  LABEL: 'Appointment Date',
  /** How often the label is read (minutes); and how far back each read looks (days). */
  POLL_MINUTES: 10,
  POLL_LOOKBACK_DAYS: 3,
  /** The first run (once per database): emails of the last BACKFILL_DAYS found by the filters' own searches. */
  BACKFILL_DAYS: 60,
  /** app_state key of the reader (backfill done, last run). */
  STATE_KEY: 'appointment-emails',
  /** An email whose PO is not saved yet is tried again on every run for this many days. */
  WAITING_DAYS: 60,
  /** Columns sizes (entity + migration). */
  TEXT_MAX: 255,
} as const;

/** The two channels and the Gmail searches of their filters (used by the one-time backfill). */
export const APPOINTMENT_CHANNELS = {
  [CHANNELS.SCOOTSY]: { label: 'Scootsy', search: 'subject:("PurchaseOrder" ("Appointment CREATED" OR "Appointment CANCELLED")) -subject:(re OR fw OR fwd)' },
  [CHANNELS.ZEPTO]: { label: 'Zepto', search: 'subject:("Purchase Order Scheduled" OR "Purchase Order ReScheduled" OR "Purchase Order Un-Scheduled") zeptonow.com -subject:(re OR fw OR fwd)' },
  [CHANNELS.BLINKIT]: { label: 'Blinkit', search: '((subject:(PO_BCPL OR PO_BLINK) ("has been scheduled on" OR "has been rescheduled to")) OR (subject:"Appointment Cancellation" "Blinkit Warehouse")) -subject:(re OR fw OR fwd)' },
} as const;
/** Channels read in the first run before Blinkit was added (state.backfilledAt of 2026-11-16): not read again. */
export const APPOINTMENT_FIRST_CHANNELS: readonly string[] = [CHANNELS.SCOOTSY, CHANNELS.ZEPTO];
export type AppointmentChannel = keyof typeof APPOINTMENT_CHANNELS;

/** What the email says. */
export const APPOINTMENT_ACTION = {
  CREATED: 'created',
  RESCHEDULED: 'rescheduled',
  CANCELLED: 'cancelled',
} as const;
export type AppointmentAction = (typeof APPOINTMENT_ACTION)[keyof typeof APPOINTMENT_ACTION];

/** What was done with it. */
export const APPOINTMENT_OUTCOME = {
  /** Written to the PO (a shipment_logs row, log_id). */
  APPLIED: 'applied',
  /** The PO had a newer change (a later email or a person's edit): kept in the history only. */
  OLDER: 'older',
  /** No saved PO with this number yet: tried again on every run (WAITING_DAYS). */
  WAITING: 'waiting',
  /** Not in one of the known formats (subject / date not readable). */
  UNREADABLE: 'unreadable',
} as const;
export type AppointmentOutcome = (typeof APPOINTMENT_OUTCOME)[keyof typeof APPOINTMENT_OUTCOME];

/** Where a PO's current appointment date came from (PO Overview mark + filter `appointmentSource`). */
export const APPOINTMENT_SOURCE = {
  EMAIL: 'email',
  TYPED: 'typed',
  CANCELLED: 'cancelled',
  NONE: 'none',
} as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCE)[keyof typeof APPOINTMENT_SOURCE];

/** History remark texts (shipment_logs.remark of a change made from an email). */
export const APPOINTMENT_TEXT = {
  remark: (channel: string, status: string, extra: string[]) => [`${channel} appointment email: ${status}`, ...extra].join(', '),
  slot: (s: string) => `slot ${s}`,
  ref: (s: string) => `ID ${s}`,
  hub: (s: string) => `at ${s}`,
  firstFilled: (channel: string) => `${channel} appointment email: first appointment`,
} as const;
