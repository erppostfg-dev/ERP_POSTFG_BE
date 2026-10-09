import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BASELINE (2026-10-09): the 10 tables that existed in mcaff_postfg_dev before the app owned its schema, exactly as
 * they were live (SHOW CREATE TABLE, AUTO_INCREMENT values left out), including the user's po_uploads ALTER of
 * 2026-10-08 (source + 'api', unique (email_message_id, po_number)).
 * CREATE TABLE IF NOT EXISTS: on the dev database (tables already there) it changes nothing and is only recorded as run;
 * on a new database (e.g. prod) it builds them. From now on every schema change is a migration after this one.
 */
export class Baseline1791500000000 implements MigrationInterface {
  name = 'Baseline1791500000000';

  public async up(q: QueryRunner): Promise<void> {
    // master_channels
    await q.query(`CREATE TABLE IF NOT EXISTS \`master_channels\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`slug\` varchar(50) NOT NULL,
  \`display_name\` varchar(100) NOT NULL,
  \`db_aliases\` json DEFAULT NULL,
  \`has_processor\` tinyint(1) NOT NULL DEFAULT '0',
  \`is_active\` tinyint(1) NOT NULL DEFAULT '1',
  \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`slug\` (\`slug\`),
  UNIQUE KEY \`display_name\` (\`display_name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // master_skus
    await q.query(`CREATE TABLE IF NOT EXISTS \`master_skus\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`pep_code\` varchar(100) NOT NULL,
  \`product_name\` varchar(500) DEFAULT NULL,
  \`mrp\` decimal(10,2) DEFAULT NULL,
  \`ean_code\` varchar(50) DEFAULT NULL,
  \`brand_name\` varchar(100) DEFAULT NULL,
  \`created_at\` datetime(6) DEFAULT NULL,
  \`updated_at\` datetime(6) DEFAULT NULL,
  \`hsn_code\` varchar(50) DEFAULT NULL,
  \`is_active\` tinyint(1) DEFAULT '1',
  \`product_type\` varchar(50) DEFAULT NULL,
  \`gst_tax_type\` varchar(50) DEFAULT NULL,
  \`length_mm\` decimal(10,2) DEFAULT NULL,
  \`width_mm\` decimal(10,2) DEFAULT NULL,
  \`height_mm\` decimal(10,2) DEFAULT NULL,
  \`weight_g\` decimal(10,2) DEFAULT NULL,
  \`determine_expiry_from\` varchar(100) DEFAULT NULL,
  \`shelf_life\` int DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`pep_code\` (\`pep_code\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // master_channel_skus
    await q.query(`CREATE TABLE IF NOT EXISTS \`master_channel_skus\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`pep_code\` varchar(100) NOT NULL,
  \`product_name\` varchar(500) DEFAULT NULL,
  \`mrp\` decimal(10,2) DEFAULT NULL,
  \`channel_code\` varchar(100) DEFAULT NULL,
  \`margin\` decimal(10,4) DEFAULT NULL,
  \`rate_after_margin\` decimal(10,2) DEFAULT NULL,
  \`ean_code\` varchar(50) DEFAULT NULL,
  \`channel_name\` varchar(100) DEFAULT NULL,
  \`brand_name\` varchar(100) DEFAULT NULL,
  \`channel_id\` int DEFAULT NULL,
  \`pep_sku_id\` int DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`fk_master_channel_skus_channel\` (\`channel_name\`),
  KEY \`idx_master_channel_skus_pep_code\` (\`pep_code\`),
  KEY \`idx_master_channel_skus_channel_code\` (\`channel_code\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // details_channels
    await q.query(`CREATE TABLE IF NOT EXISTS \`details_channels\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`channel_id\` int NOT NULL,
  \`channel_name\` varchar(100) NOT NULL,
  \`channel_location_code\` varchar(100) DEFAULT NULL,
  \`uniware_customer_code\` varchar(255) DEFAULT NULL,
  \`tally_ledger_name\` varchar(255) DEFAULT NULL,
  \`final_billing_address\` text,
  \`buyer_type\` varchar(100) DEFAULT NULL,
  \`buyer_gst_number\` varchar(50) DEFAULT NULL,
  \`buyer_state\` varchar(100) DEFAULT NULL,
  \`buyer_pin_code\` varchar(20) DEFAULT NULL,
  \`consignee_name\` varchar(255) DEFAULT NULL,
  \`consignee_state\` varchar(100) DEFAULT NULL,
  \`consignee_gst_number\` varchar(50) DEFAULT NULL,
  \`consignee_pin_code\` varchar(20) DEFAULT NULL,
  \`final_shipping_address\` text,
  \`created_at\` datetime(6) DEFAULT NULL,
  \`updated_at\` datetime(6) DEFAULT NULL,
  \`channel_code\` varchar(100) DEFAULT NULL,
  \`facility_code\` varchar(100) DEFAULT NULL,
  \`final_shipping_address_embedding\` json DEFAULT NULL,
  \`final_billing_address_embedding\` json DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`fk_details_channels_channel\` (\`channel_name\`),
  KEY \`fk_details_channel\` (\`channel_id\`),
  CONSTRAINT \`fk_details_channel\` FOREIGN KEY (\`channel_id\`) REFERENCES \`master_channels\` (\`id\`),
  CONSTRAINT \`fk_details_channels_channel\` FOREIGN KEY (\`channel_name\`) REFERENCES \`master_channels\` (\`display_name\`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // master_purchase_orders
    await q.query(`CREATE TABLE IF NOT EXISTS \`master_purchase_orders\` (
  \`uid\` bigint NOT NULL AUTO_INCREMENT,
  \`entryDate\` date DEFAULT NULL,
  \`poDate\` date DEFAULT NULL,
  \`facility\` varchar(255) DEFAULT NULL,
  \`channel\` varchar(255) DEFAULT NULL,
  \`location\` varchar(255) DEFAULT NULL,
  \`poNumber\` varchar(255) DEFAULT NULL,
  \`totalUnits\` int DEFAULT NULL,
  \`brandName\` varchar(255) DEFAULT NULL,
  \`remarksPlanning\` text,
  \`specialRemarksCOPT\` text,
  \`newShipmentReference\` varchar(255) DEFAULT NULL,
  \`statusActive\` varchar(50) DEFAULT NULL,
  \`statusPlanning\` varchar(50) DEFAULT NULL,
  \`statusWarehouse\` varchar(50) DEFAULT NULL,
  \`statusLogistics\` varchar(50) DEFAULT NULL,
  \`channelInwardingRemarks\` text,
  \`dispatchRemarksLogistics\` text,
  \`dispatchRemarksWarehouse\` text,
  \`dispatchDateTentative\` date DEFAULT NULL,
  \`workingDatePlanner\` date DEFAULT NULL,
  \`rtsDate\` date DEFAULT NULL,
  \`dispatchDate\` date DEFAULT NULL,
  \`currentAppointmentDate\` date DEFAULT NULL,
  \`firstAppointmentDateCOPT\` date DEFAULT NULL,
  \`noOfBoxes\` int DEFAULT NULL,
  \`orderNo1\` varchar(255) DEFAULT NULL,
  \`orderNo2\` varchar(255) DEFAULT NULL,
  \`orderNo3\` varchar(255) DEFAULT NULL,
  \`pickListNo\` varchar(255) DEFAULT NULL,
  \`workingTypeWarehouse\` varchar(255) DEFAULT NULL,
  \`inventoryRemarksWarehouse\` text,
  \`b2bWorkingTeamRemarks\` text,
  \`actualWeight\` decimal(12,3) DEFAULT NULL,
  \`volumetricWeight\` decimal(12,3) DEFAULT NULL,
  \`physicalWeight\` decimal(12,3) DEFAULT NULL,
  \`channelType\` varchar(100) DEFAULT NULL,
  \`firstTransporter\` varchar(255) DEFAULT NULL,
  \`firstDocketNo\` varchar(255) DEFAULT NULL,
  \`secondTransporter\` varchar(255) DEFAULT NULL,
  \`secondDocketNo\` varchar(255) DEFAULT NULL,
  \`thirdTransporter\` varchar(255) DEFAULT NULL,
  \`thirdDocketNo\` varchar(255) DEFAULT NULL,
  \`appointmentLetter\` text,
  \`labelsLink\` text,
  \`invoiceDate\` date DEFAULT NULL,
  \`invoiceLink\` text,
  \`cnLink\` text,
  \`ewayLink\` text,
  \`invoiceValue\` decimal(15,2) DEFAULT NULL,
  \`remarksAccountsTeam\` text,
  \`invoiceChallanNumber\` varchar(255) DEFAULT NULL,
  \`invoiceCheckedBy\` varchar(255) DEFAULT NULL,
  \`tallyCustomerName\` varchar(255) DEFAULT NULL,
  \`customerCode\` varchar(255) DEFAULT NULL,
  \`poEntryCount\` int DEFAULT NULL,
  \`temp\` varchar(255) DEFAULT NULL,
  \`deliveryDate\` date DEFAULT NULL,
  \`rescheduleLag\` int DEFAULT NULL,
  \`finalRemarks\` text,
  \`updatedGmv\` decimal(15,2) DEFAULT NULL,
  \`firstAppointmentDate\` date DEFAULT NULL,
  \`secondAppointmentDate\` date DEFAULT NULL,
  \`thirdAppointmentDate\` date DEFAULT NULL,
  \`remarkAp1\` text,
  \`remarkAp2\` text,
  \`remarkAp3\` text,
  \`deliveryCharges\` decimal(15,2) DEFAULT NULL,
  \`halting\` decimal(15,2) DEFAULT NULL,
  \`unloadingCharges\` decimal(15,2) DEFAULT NULL,
  \`dedicatedVehicle\` decimal(15,2) DEFAULT NULL,
  \`otherCharges\` decimal(15,2) DEFAULT NULL,
  \`document\` text,
  \`proofOfDispatch\` text,
  \`proofOfDelivery\` text,
  \`rpk\` varchar(255) DEFAULT NULL,
  \`poNumbers\` text,
  \`deliveryType\` varchar(100) DEFAULT NULL,
  \`appointmentShootedDate\` date DEFAULT NULL,
  \`appointmentRequestedDate\` date DEFAULT NULL,
  \`remarksWarehouse\` text,
  \`poNumberInwardCWH\` varchar(255) DEFAULT NULL,
  \`createdAt\` datetime DEFAULT NULL,
  \`updatedAt\` datetime DEFAULT NULL,
  PRIMARY KEY (\`uid\`),
  UNIQUE KEY \`uq_master_po_channel_po_number\` (\`channel\`,\`poNumber\`),
  CONSTRAINT \`fk_master_po_channel\` FOREIGN KEY (\`channel\`) REFERENCES \`master_channels\` (\`display_name\`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // details_purchase_orders
    await q.query(`CREATE TABLE IF NOT EXISTS \`details_purchase_orders\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`srNo\` varchar(50) DEFAULT NULL,
  \`skuName\` varchar(255) DEFAULT NULL,
  \`skuCode\` varchar(255) DEFAULT NULL,
  \`channelSkuCode\` varchar(255) DEFAULT NULL,
  \`qty\` int DEFAULT NULL,
  \`gmv\` decimal(15,2) DEFAULT NULL,
  \`poValue\` decimal(15,2) DEFAULT NULL,
  \`accountsWorking\` text,
  \`channelInwardingQuantity\` int DEFAULT NULL,
  \`actualWeight\` decimal(12,3) DEFAULT NULL,
  \`shipmentOrderId\` bigint NOT NULL,
  \`createdAt\` datetime DEFAULT NULL,
  \`updatedAt\` datetime DEFAULT NULL,
  \`updatedQty\` int DEFAULT NULL,
  \`updatedGmv\` decimal(15,2) DEFAULT NULL,
  \`updatedPoValue\` decimal(15,2) DEFAULT NULL,
  \`brandName\` varchar(255) DEFAULT NULL,
  \`poNumber\` varchar(255) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`fk_details_master_po\` (\`shipmentOrderId\`),
  CONSTRAINT \`fk_details_master_po\` FOREIGN KEY (\`shipmentOrderId\`) REFERENCES \`master_purchase_orders\` (\`uid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // sale_order_code_counter
    await q.query(`CREATE TABLE IF NOT EXISTS \`sale_order_code_counter\` (
  \`counter_date\` date NOT NULL,
  \`last_serial\` int NOT NULL,
  PRIMARY KEY (\`counter_date\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // po_uploads
    await q.query(`CREATE TABLE IF NOT EXISTS \`po_uploads\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`source\` enum('email','manual','api') NOT NULL,
  \`channel\` varchar(100) DEFAULT NULL,
  \`file_name\` varchar(255) NOT NULL,
  \`file_url\` varchar(500) NOT NULL,
  \`file_type\` varchar(20) DEFAULT NULL,
  \`email_message_id\` varchar(255) DEFAULT NULL,
  \`email_from\` varchar(255) DEFAULT NULL,
  \`email_subject\` varchar(500) DEFAULT NULL,
  \`email_received_at\` datetime DEFAULT NULL,
  \`uploaded_by\` varchar(255) DEFAULT NULL,
  \`ocr_status\` enum('pending','running','success','issue','error') NOT NULL DEFAULT 'pending',
  \`ocr_result\` json DEFAULT NULL,
  \`ocr_started_at\` datetime DEFAULT NULL,
  \`ocr_finished_at\` datetime DEFAULT NULL,
  \`ocr_attempts\` tinyint NOT NULL DEFAULT '0',
  \`po_number\` varchar(255) DEFAULT NULL,
  \`po_uid\` bigint DEFAULT NULL,
  \`uniware_csv_url\` varchar(500) DEFAULT NULL,
  \`status\` enum('queued','extracting','needs_review','processing','completed','rejected','failed') NOT NULL DEFAULT 'queued',
  \`error_details\` json DEFAULT NULL,
  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`completed_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_po_uploads_message_po\` (\`email_message_id\`,\`po_number\`),
  KEY \`idx_po_uploads_status\` (\`status\`,\`created_at\`),
  KEY \`idx_po_uploads_po_number\` (\`po_number\`),
  KEY \`fk_po_uploads_po\` (\`po_uid\`),
  KEY \`fk_po_uploads_channel\` (\`channel\`),
  CONSTRAINT \`fk_po_uploads_channel\` FOREIGN KEY (\`channel\`) REFERENCES \`master_channels\` (\`display_name\`) ON UPDATE CASCADE,
  CONSTRAINT \`fk_po_uploads_po\` FOREIGN KEY (\`po_uid\`) REFERENCES \`master_purchase_orders\` (\`uid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // po_issues
    await q.query(`CREATE TABLE IF NOT EXISTS \`po_issues\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`upload_id\` bigint NOT NULL,
  \`line_no\` int DEFAULT NULL,
  \`issue_type\` enum('OCR_ISSUE','DUPLICATE_PO','LOCATION_NOT_MAPPED','SKU_NOT_MAPPED','PRICE_MISMATCH','MRP_MISMATCH','QTY_MISMATCH','TOTAL_MISMATCH','PO_EXPIRED','OTHER') NOT NULL,
  \`field_name\` varchar(100) DEFAULT NULL,
  \`details\` varchar(500) DEFAULT NULL,
  \`original_values\` json DEFAULT NULL,
  \`resolved_values\` json DEFAULT NULL,
  \`save_as_master\` tinyint(1) NOT NULL DEFAULT '0',
  \`status\` enum('open','approved','rejected') NOT NULL DEFAULT 'open',
  \`resolved_by\` varchar(255) DEFAULT NULL,
  \`resolved_at\` datetime DEFAULT NULL,
  \`remark\` varchar(500) DEFAULT NULL,
  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_po_issues_open\` (\`status\`,\`issue_type\`),
  KEY \`fk_po_issues_upload\` (\`upload_id\`),
  CONSTRAINT \`fk_po_issues_upload\` FOREIGN KEY (\`upload_id\`) REFERENCES \`po_uploads\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    // po_issue_actions
    await q.query(`CREATE TABLE IF NOT EXISTS \`po_issue_actions\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`issue_id\` bigint NOT NULL,
  \`action\` enum('created','assigned','commented','approved','rejected','reopened') NOT NULL,
  \`action_by\` varchar(255) DEFAULT NULL,
  \`remark\` varchar(500) DEFAULT NULL,
  \`before_value\` json DEFAULT NULL,
  \`after_value\` json DEFAULT NULL,
  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_po_issue_actions_issue\` (\`issue_id\`,\`created_at\`),
  CONSTRAINT \`fk_po_issue_actions_issue\` FOREIGN KEY (\`issue_id\`) REFERENCES \`po_issues\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  /** Never drops: these tables hold the master data and the POs. Undo by hand only, with the owner's OK. */
  public async down(): Promise<void> {
    throw new Error('The baseline migration is not reverted automatically: it would drop every table.');
  }
}
