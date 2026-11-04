import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * D2C internal transfer routes (2026-11-03; plan d2c-internal-transfers, "Route codes from the user's sheet"): the
 * Uniware channel + customer codes depend on (sending facility, channel, location) and the vendor code on (sending
 * facility, receiving facility), so they are kept per ROUTE, not per facility.
 *   - NEW d2c_transfer_routes: one row per (dispatch facility, transfer location = details_channels row) with the
 *     Uniware channel code, customer code / name and vendor code; filled by `npm run d2c:routes-load`, edited in Masters;
 *   - details_channels.transfer_po_prefix: PO number prefix of a transfer location (PEPIMS's, e.g. HYP_Nagpur);
 *   - master_change_logs.master_type gets 'transfer_route' (route edits keep their history like the other masters);
 *   - master_facilities: DROP uniware_vendor_code / uniware_customer_code added by D2cTransfers1793800000000 (never
 *     used; refused unless every value is NULL). allow_internal_transfer stays.
 * down() REFUSES while any route exists; then removes the routes' history rows, restores the enum, drops the column
 * and the table and adds the two (empty) facility columns back.
 */

const LOG_TYPES_OLD = ['pep_sku', 'channel_sku', 'channel', 'location', 'facility'];
const LOG_TYPE_NEW = 'transfer_route';
const enumOf = (values: string[]) => `enum (${values.map((v) => `'${v}'`).join(', ')})`;

export class D2cTransferRoutes1793900000000 implements MigrationInterface {
    name = 'D2cTransferRoutes1793900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [f] = await queryRunner.query(
            `SELECT COUNT(*) n FROM \`master_facilities\` WHERE \`uniware_vendor_code\` IS NOT NULL OR \`uniware_customer_code\` IS NOT NULL`,
        );
        if (Number(f.n)) {
            throw new Error(`master_facilities has ${f.n} row(s) with uniware_vendor_code / uniware_customer_code set: move them to d2c_transfer_routes first (not dropped).`);
        }
        await queryRunner.query(`CREATE TABLE \`d2c_transfer_routes\` (
            \`id\` int NOT NULL AUTO_INCREMENT, \`dispatch_facility_id\` int NOT NULL, \`location_id\` bigint NOT NULL,
            \`uniware_channel_code\` varchar(100) NULL, \`customer_code\` varchar(100) NULL, \`customer_name\` varchar(255) NULL,
            \`vendor_code\` varchar(100) NULL, \`is_active\` tinyint NOT NULL DEFAULT 1,
            \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            UNIQUE INDEX \`uq_d2c_transfer_routes_route\` (\`dispatch_facility_id\`, \`location_id\`),
            INDEX \`idx_d2c_transfer_routes_location\` (\`location_id\`),
            PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        // dispatch_facility_id is served by the unique index (its first column), location_id by its own index
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` ADD CONSTRAINT \`fk_d2c_transfer_routes_facility\` FOREIGN KEY (\`dispatch_facility_id\`) REFERENCES \`master_facilities\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` ADD CONSTRAINT \`fk_d2c_transfer_routes_location\` FOREIGN KEY (\`location_id\`) REFERENCES \`details_channels\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`details_channels\` ADD \`transfer_po_prefix\` varchar(100) NULL`);
        await queryRunner.query(`ALTER TABLE \`master_change_logs\` MODIFY \`master_type\` ${enumOf([...LOG_TYPES_OLD, LOG_TYPE_NEW])} NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`uniware_customer_code\`, DROP COLUMN \`uniware_vendor_code\``);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [r] = await queryRunner.query(`SELECT COUNT(*) n FROM \`d2c_transfer_routes\``);
        if (Number(r.n)) throw new Error(`D2C transfer routes exist (${r.n}). Delete them first (DELETE FROM d2c_transfer_routes) if they are really not needed.`);

        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`uniware_vendor_code\` varchar(100) NULL, ADD \`uniware_customer_code\` varchar(100) NULL`);
        // the history of routes that no longer exist (none left, see above)
        await queryRunner.query(`DELETE FROM \`master_change_logs\` WHERE \`master_type\` = ?`, [LOG_TYPE_NEW]);
        await queryRunner.query(`ALTER TABLE \`master_change_logs\` MODIFY \`master_type\` ${enumOf(LOG_TYPES_OLD)} NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`details_channels\` DROP COLUMN \`transfer_po_prefix\``);
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` DROP FOREIGN KEY \`fk_d2c_transfer_routes_location\``);
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` DROP FOREIGN KEY \`fk_d2c_transfer_routes_facility\``);
        await queryRunner.query(`DROP TABLE \`d2c_transfer_routes\``);
    }

}
