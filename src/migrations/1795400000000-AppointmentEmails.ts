import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Appointment dates from email (2026-11-16, constants/appointments.ts): ONE new table po_appointment_emails (every
 * Scootsy / Zepto appointment email read from the Gmail label "Appointment Date" and what was done with it).
 * Nothing else changes: the dates go into the existing master_purchase_orders columns through shipment_logs rows.
 * down() drops the table (the dates already written to POs and their History rows stay).
 */
export class AppointmentEmails1795400000000 implements MigrationInterface {
    name = 'AppointmentEmails1795400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("CREATE TABLE `po_appointment_emails` (`id` bigint NOT NULL AUTO_INCREMENT, `gmail_id` varchar(32) NOT NULL, `channel` varchar(30) NULL, `po_number` varchar(100) NULL, `action` enum ('created', 'rescheduled', 'cancelled') NULL, `appointment_date` date NULL, `previous_date` date NULL, `slot` varchar(100) NULL, `appointment_ref` varchar(100) NULL, `hub` varchar(150) NULL, `quantity` int NULL, `remarks` varchar(255) NULL, `subject` varchar(255) NOT NULL, `received_at` datetime(6) NOT NULL, `outcome` enum ('applied', 'older', 'waiting', 'unreadable') NOT NULL, `po_uid` bigint NULL, `log_id` bigint NULL, `applied_at` datetime(6) NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_po_appointment_emails_gmail` (`gmail_id`), INDEX `idx_po_appointment_emails_po` (`po_uid`), INDEX `idx_po_appointment_emails_log` (`log_id`), INDEX `idx_po_appointment_emails_waiting` (`outcome`, `channel`, `po_number`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE `po_appointment_emails`");
    }
}
