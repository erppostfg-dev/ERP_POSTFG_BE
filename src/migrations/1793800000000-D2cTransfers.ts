import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * D2C internal transfers (2026-11-03; plan d2c-internal-transfers v3 section 2 + the user's answers appended to it).
 * Reuses the PO tables (user: "as few new tables as possible"); nothing existing is renamed, dropped or retyped.
 *   - master_purchase_orders: 13 nullable transfer columns; transferCode NOT NULL = the row is a transfer (unique);
 *     index (transferStage, transferPriority, poDate) for the transfer list;
 *   - details_purchase_orders: dispatchedQty, allocatedQty;
 *   - shipment_logs: uniware_status + new action / source values (full lists as on dev, checked 2026-11-03);
 *   - details_channels.transfer_facility_id (receiving facility of a transfer location, FK -> master_facilities);
 *   - master_facilities: allow_internal_transfer (0 for every row), uniware_vendor_code, uniware_customer_code;
 *   - NEW po_invoices: one row per Uniware invoice / package of a transfer, with its inward PO, GRNs and variance;
 *   - master_channels: the 5 transfer channels, INACTIVE (none of them existed on dev on 2026-11-03, matched by
 *     normalised display_name / slug / alias); each inserted only if no row has that slug or display_name;
 *   - page_permissions for /operations/d2c-transfers (operations-executive editor, demand-planner + viewer viewer),
 *     only where the role has no row for it; operations-manager / admin / developer inherit /operations;
 *   - app_state: d2c:ref-serial, d2c:transfer-code, d2c:so-serial (own daily counter of the erp_it_ SO codes),
 *     d2c:settings (live = false, testFacilities = TEST_FACILITY) and d2c:migration (what this inserted, for down()).
 * down() REFUSES while any transfer or po_invoices row exists (npm run d2c:purge -- --apply first); then removes the
 * transfer log rows, restores the enums, drops the columns / table and deletes only the channels / permission rows
 * this migration inserted (channels only when nothing points at them).
 */

const ACTIONS_OLD = ['created', 'field_changed', 'bulk_update', 'line_qty_requested', 'line_qty_approved', 'line_qty_rejected', 'uniware_uploaded', 'uniware_upload_undone'];
const ACTIONS_NEW = [
    'stage_changed', 'so_requested', 'so_created', 'so_failed', 'stock_warning', 'cancelled', 'balance_closed', 'expiry_changed', 'line_added',
    'line_removed', 'invoice_seen', 'inward_po_requested', 'inward_po_created', 'inward_po_failed', 'grn_received', 'variance_reason', 'sync_error',
];
const SOURCES_OLD = ['screen', 'bulk_csv', 'pipeline', 'review', 'script'];
const SOURCES_NEW = ['tool_api', 'uniware', 'system'];
const enumOf = (values: string[]) => `enum (${values.map((v) => `'${v}'`).join(', ')})`;

/** [slug, display_name]: the PEPIMS channel names of internal transfers (hyp-website = the in-transit import's slug). */
const CHANNELS: [string, string][] = [
    ['mcaffeine-b2c', 'McaffeineB2C'],
    ['hyp-website', 'HYP_Website'],
    ['ggn-warehouse', 'GGN_WAREHOUSE'],
    ['mum-warehouse2', 'MUM_WAREHOUSE2'],
    ['kol-warehouse', 'KOL_WAREHOUSE'],
];
const PAGE = '/operations/d2c-transfers';
const PERMISSIONS: [string, string][] = [['operations-executive', 'editor'], ['demand-planner', 'viewer'], ['viewer', 'viewer']];
const STATE: [string, unknown][] = [
    ['d2c:ref-serial', { byDate: {} }],
    ['d2c:transfer-code', { month: null, last: 0 }],
    ['d2c:so-serial', { byDate: {} }],
    ['d2c:settings', {
        types: ['Regular', 'Internal', 'Freebee'], channels: CHANNELS.map(([, name]) => name), defaultExpiryDays: 15, soNotFoundHours: 24,
        syncMinutes: 30, live: false, testFacilities: ['TEST_FACILITY'], cutoverDate: null,
    }],
];
const MIGRATION_KEY = 'd2c:migration';

type Affected = { affectedRows?: number } | unknown[];
const affected = (r: unknown): number => {
    const x = (Array.isArray(r) ? r[1] ?? r[0] : r) as Affected;
    return Number((x as { affectedRows?: number })?.affectedRows ?? 0);
};

export class D2cTransfers1793800000000 implements MigrationInterface {
    name = 'D2cTransfers1793800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\`
            ADD \`transferCode\` varchar(30) NULL, ADD \`transferType\` varchar(30) NULL, ADD \`transferPriority\` varchar(2) NULL,
            ADD \`transferStage\` varchar(30) NULL, ADD \`transferStageAt\` datetime(6) NULL, ADD \`transferBatchId\` char(36) NULL,
            ADD \`transferFileUrl\` varchar(500) NULL, ADD \`soState\` varchar(10) NULL, ADD \`soRequestedAt\` datetime(6) NULL,
            ADD \`soError\` text NULL, ADD \`balanceClosedReason\` varchar(20) NULL, ADD \`lastSyncedAt\` datetime(6) NULL, ADD \`syncError\` text NULL,
            ADD UNIQUE INDEX \`uq_master_po_transfer_code\` (\`transferCode\`),
            ADD INDEX \`idx_master_po_transfer_stage\` (\`transferStage\`, \`transferPriority\`, \`poDate\`)`);
        await queryRunner.query(`ALTER TABLE \`details_purchase_orders\` ADD \`dispatchedQty\` int NULL, ADD \`allocatedQty\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`shipment_logs\` ADD \`uniware_status\` varchar(100) NULL,
            MODIFY \`action\` ${enumOf([...ACTIONS_OLD, ...ACTIONS_NEW])} NOT NULL,
            MODIFY \`source\` ${enumOf([...SOURCES_OLD, ...SOURCES_NEW])} NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`allow_internal_transfer\` tinyint NOT NULL DEFAULT 0,
            ADD \`uniware_vendor_code\` varchar(100) NULL, ADD \`uniware_customer_code\` varchar(100) NULL`);
        await queryRunner.query(`ALTER TABLE \`details_channels\` ADD \`transfer_facility_id\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`details_channels\` ADD CONSTRAINT \`fk_details_channels_transfer_facility\` FOREIGN KEY (\`transfer_facility_id\`) REFERENCES \`master_facilities\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`CREATE TABLE \`po_invoices\` (
            \`id\` bigint NOT NULL AUTO_INCREMENT, \`po_uid\` bigint NOT NULL, \`sale_order_code\` varchar(100) NULL,
            \`shipping_package_code\` varchar(100) NOT NULL, \`invoice_code\` varchar(100) NULL, \`invoice_display_code\` varchar(100) NULL,
            \`invoice_date\` datetime NULL, \`package_status\` varchar(50) NULL, \`dispatched_at\` datetime NULL, \`units\` int NOT NULL DEFAULT 0,
            \`inward_po_code\` varchar(100) NULL, \`inward_po_state\` varchar(10) NULL, \`inward_po_requested_at\` datetime(6) NULL,
            \`inward_po_error\` text NULL, \`inward_po_status\` varchar(50) NULL, \`grn_codes\` json NULL, \`received_units\` int NOT NULL DEFAULT 0,
            \`grn_completed_at\` datetime NULL, \`variance_reason\` varchar(20) NULL, \`variance_note\` text NULL, \`sku_qty\` json NULL,
            \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            UNIQUE INDEX \`uq_po_invoices_package\` (\`po_uid\`, \`shipping_package_code\`),
            UNIQUE INDEX \`uq_po_invoices_inward_po_code\` (\`inward_po_code\`),
            INDEX \`idx_po_invoices_inward_po_state\` (\`inward_po_state\`),
            PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`po_invoices\` ADD CONSTRAINT \`fk_po_invoices_po\` FOREIGN KEY (\`po_uid\`) REFERENCES \`master_purchase_orders\`(\`uid\`) ON DELETE RESTRICT ON UPDATE CASCADE`);

        // transfer channels: inactive (kept out of PO Verify settings, Manual Upload, intake), only the missing ones.
        // Only on a database that already has its channel list (dev / prod): a database built empty from the
        // migrations (the test DB in CI) loads its channels itself, and rows added here would take its ids.
        const insertedChannelSlugs: string[] = [];
        const [{ n: channelRows }] = await queryRunner.query(`SELECT COUNT(*) AS n FROM \`master_channels\``);
        for (const [slug, name] of Number(channelRows) > 0 ? CHANNELS : []) {
            const r = await queryRunner.query(
                `INSERT INTO \`master_channels\` (\`slug\`, \`display_name\`, \`db_aliases\`, \`has_processor\`, \`is_active\`)
                 SELECT ?, ?, ?, 0, 0 FROM DUAL
                  WHERE NOT EXISTS (SELECT 1 FROM \`master_channels\` WHERE \`slug\` = ? OR \`display_name\` = ?)`,
                [slug, name, JSON.stringify([name, slug]), slug, name],
            );
            if (affected(r)) insertedChannelSlugs.push(slug);
        }
        const insertedPermissionRoles: string[] = [];
        for (const [role, level] of PERMISSIONS) {
            const r = await queryRunner.query(
                `INSERT INTO \`page_permissions\` (\`role\`, \`page_slug\`, \`access_level\`)
                 SELECT ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM \`page_permissions\` WHERE \`role\` = ? AND \`page_slug\` = ?)`,
                [role, PAGE, level, role, PAGE],
            );
            if (affected(r)) insertedPermissionRoles.push(role);
        }
        for (const [key, value] of STATE) {
            await queryRunner.query(
                `INSERT INTO \`app_state\` (\`state_key\`, \`value\`, \`updated_at\`)
                 SELECT ?, CAST(? AS JSON), NOW() FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM \`app_state\` WHERE \`state_key\` = ?)`,
                [key, JSON.stringify(value), key],
            );
        }
        await queryRunner.query(
            `INSERT INTO \`app_state\` (\`state_key\`, \`value\`, \`updated_at\`) VALUES (?, CAST(? AS JSON), NOW())
             ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`updated_at\` = VALUES(\`updated_at\`)`,
            [MIGRATION_KEY, JSON.stringify({ insertedChannelSlugs, insertedPermissionRoles, at: new Date().toISOString() })],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [t] = await queryRunner.query(`SELECT COUNT(*) n FROM \`master_purchase_orders\` WHERE \`transferCode\` IS NOT NULL`);
        const [i] = await queryRunner.query(`SELECT COUNT(*) n FROM \`po_invoices\``);
        const n = Number(t.n) + Number(i.n);
        if (n) throw new Error(`D2C transfers exist (${t.n} transfers, ${i.n} invoices). Delete them with \`npm run d2c:purge -- --apply\` first.`);

        const [rec] = await queryRunner.query(`SELECT \`value\` FROM \`app_state\` WHERE \`state_key\` = ?`, [MIGRATION_KEY]);
        const record = (typeof rec?.value === 'string' ? JSON.parse(rec.value) : rec?.value ?? {}) as { insertedChannelSlugs?: string[]; insertedPermissionRoles?: string[] };

        // log rows with the new values can only belong to transfers (none left), so this deletes nothing on a clean DB
        await queryRunner.query(
            `DELETE FROM \`shipment_logs\` WHERE \`action\` IN (${ACTIONS_NEW.map(() => '?').join(', ')}) OR \`source\` IN (${SOURCES_NEW.map(() => '?').join(', ')})`,
            [...ACTIONS_NEW, ...SOURCES_NEW],
        );
        await queryRunner.query(`ALTER TABLE \`shipment_logs\` DROP COLUMN \`uniware_status\`,
            MODIFY \`action\` ${enumOf(ACTIONS_OLD)} NOT NULL, MODIFY \`source\` ${enumOf(SOURCES_OLD)} NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`po_invoices\` DROP FOREIGN KEY \`fk_po_invoices_po\``);
        await queryRunner.query(`DROP TABLE \`po_invoices\``);
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` DROP INDEX \`idx_master_po_transfer_stage\`, DROP INDEX \`uq_master_po_transfer_code\`,
            DROP COLUMN \`transferCode\`, DROP COLUMN \`transferType\`, DROP COLUMN \`transferPriority\`, DROP COLUMN \`transferStage\`,
            DROP COLUMN \`transferStageAt\`, DROP COLUMN \`transferBatchId\`, DROP COLUMN \`transferFileUrl\`, DROP COLUMN \`soState\`,
            DROP COLUMN \`soRequestedAt\`, DROP COLUMN \`soError\`, DROP COLUMN \`balanceClosedReason\`, DROP COLUMN \`lastSyncedAt\`, DROP COLUMN \`syncError\``);
        await queryRunner.query(`ALTER TABLE \`details_purchase_orders\` DROP COLUMN \`dispatchedQty\`, DROP COLUMN \`allocatedQty\``);
        await queryRunner.query(`ALTER TABLE \`details_channels\` DROP FOREIGN KEY \`fk_details_channels_transfer_facility\``);
        await queryRunner.query(`ALTER TABLE \`details_channels\` DROP COLUMN \`transfer_facility_id\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`uniware_customer_code\`, DROP COLUMN \`uniware_vendor_code\`, DROP COLUMN \`allow_internal_transfer\``);

        // only what up() inserted, and a channel only while nothing points at it
        for (const slug of record.insertedChannelSlugs ?? []) {
            await queryRunner.query(
                `DELETE c FROM \`master_channels\` c WHERE c.\`slug\` = ?
                    AND NOT EXISTS (SELECT 1 FROM \`details_channels\` d WHERE d.\`channel_id\` = c.\`id\` OR d.\`channel_name\` = c.\`display_name\`)
                    AND NOT EXISTS (SELECT 1 FROM \`master_purchase_orders\` p WHERE p.\`channel\` = c.\`display_name\`)
                    AND NOT EXISTS (SELECT 1 FROM \`po_uploads\` u WHERE u.\`channel\` = c.\`display_name\`)
                    AND NOT EXISTS (SELECT 1 FROM \`master_channel_skus\` s WHERE s.\`channel_id\` = c.\`id\`)`,
                [slug],
            );
        }
        for (const role of record.insertedPermissionRoles ?? []) {
            await queryRunner.query(`DELETE FROM \`page_permissions\` WHERE \`role\` = ? AND \`page_slug\` = ?`, [role, PAGE]);
        }
        await queryRunner.query(`DELETE FROM \`app_state\` WHERE \`state_key\` LIKE 'd2c:%'`);
    }

}
