import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { APPOINTMENT_ACTION, APPOINTMENT_OUTCOME, AppointmentAction, AppointmentOutcome } from '../constants/appointments';
import { TABLES } from '../constants/db';

/**
 * po_appointment_emails (2026-11-16, constants/appointments.ts): every appointment email read from the Gmail label
 * "Appointment Date" (Scootsy, Zepto), once (gmail_id unique), and what was done with it. Never deleted.
 * An applied one points at the shipment_logs row it wrote (log_id): the PO's appointment date came from this email as
 * long as that row is the PO's newest currentAppointmentDate change (a person's later edit = typed again).
 */
@Entity({ name: TABLES.PO_APPOINTMENT_EMAILS })
@Index('uq_po_appointment_emails_gmail', ['gmailId'], { unique: true })
@Index('idx_po_appointment_emails_po', ['poUid'])
@Index('idx_po_appointment_emails_log', ['logId'])
@Index('idx_po_appointment_emails_waiting', ['outcome', 'channel', 'poNumber'])
export class PoAppointmentEmail {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'gmail_id', type: 'varchar', length: 32 })
  gmailId: string;

  /** constants/channels name (scootsy / zepto); null when the email was not readable. */
  @Column({ name: 'channel', type: 'varchar', length: 30, nullable: true })
  channel: string | null;

  @Column({ name: 'po_number', type: 'varchar', length: 100, nullable: true })
  poNumber: string | null;

  @Column({ name: 'action', type: 'enum', enum: Object.values(APPOINTMENT_ACTION), nullable: true })
  action: AppointmentAction | null;

  /** The appointment date (created / rescheduled), or the date that was cancelled. */
  @Column({ name: 'appointment_date', type: 'date', nullable: true })
  appointmentDate: string | null;

  /** Zepto: the old date of a reschedule / un-schedule. */
  @Column({ name: 'previous_date', type: 'date', nullable: true })
  previousDate: string | null;

  /** Scootsy: slot time ("9 AM - 11 AM"). */
  @Column({ name: 'slot', type: 'varchar', length: 100, nullable: true })
  slot: string | null;

  /** Scootsy: appointment ID. */
  @Column({ name: 'appointment_ref', type: 'varchar', length: 100, nullable: true })
  appointmentRef: string | null;

  /** Warehouse / hub of the channel (Scootsy Warehouse Name, Zepto MH Name). */
  @Column({ name: 'hub', type: 'varchar', length: 150, nullable: true })
  hub: string | null;

  /** Scootsy booked quantity, Zepto PO quantity. */
  @Column({ name: 'quantity', type: 'int', nullable: true })
  quantity: number | null;

  /** Zepto: remarks of a reschedule. */
  @Column({ name: 'remarks', type: 'varchar', length: 255, nullable: true })
  remarks: string | null;

  @Column({ name: 'subject', type: 'varchar', length: 255 })
  subject: string;

  /** When Gmail received it: the time of this change ("newest wins"). */
  @Column({ name: 'received_at', type: 'datetime', precision: 6 })
  receivedAt: Date;

  @Column({ name: 'outcome', type: 'enum', enum: Object.values(APPOINTMENT_OUTCOME) })
  outcome: AppointmentOutcome;

  /** master_purchase_orders.uid once matched. */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  /** shipment_logs.id of the currentAppointmentDate change it wrote (applied). */
  @Column({ name: 'log_id', type: 'bigint', nullable: true })
  logId: string | null;

  @Column({ name: 'applied_at', type: 'datetime', precision: 6, nullable: true })
  appliedAt: Date | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
