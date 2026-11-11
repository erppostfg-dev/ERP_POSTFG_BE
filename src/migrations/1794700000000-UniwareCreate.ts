import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Create in Uniware + nothing-missed status sync (2026-11-09, constants/uniware-create.ts, constants/po-uniware-sync.ts):
 *   - new table uniware_creates: one row per "Create in Uniware" request of one PO (queue + record of the answer);
 *   - master_purchase_orders.uniwareDoneAt: when Uniware itself first said the PO is done. Filled for the POs the sync
 *     already saw COMPLETE / CANCELLED (their last read time), so they get the 15 days of after-care reads from then.
 * down() drops both.
 */

export class UniwareCreate1794700000000 implements MigrationInterface {
    name = 'UniwareCreate1794700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`uniware_creates\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`upload_id\` bigint NOT NULL, \`po_uid\` bigint NOT NULL, \`sale_order_code\` varchar(45) NOT NULL, \`facility\` varchar(100) NOT NULL, \`status\` enum ('queued', 'creating', 'created', 'exists', 'failed') NOT NULL DEFAULT 'queued', \`attempts\` int NOT NULL DEFAULT '0', \`error\` text NULL, \`items\` int NULL, \`order_value\` decimal(14,2) NULL, \`requested_by\` int NOT NULL, \`requested_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`started_at\` datetime(6) NULL, \`finished_at\` datetime(6) NULL, INDEX \`idx_uniware_creates_status\` (\`status\`, \`id\`), INDEX \`idx_uniware_creates_upload\` (\`upload_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` ADD \`uniwareDoneAt\` datetime(6) NULL`);
        await queryRunner.query(`UPDATE \`master_purchase_orders\` SET \`uniwareDoneAt\` = COALESCE(\`lastSyncedAt\`, NOW(6)) WHERE \`transferCode\` IS NULL AND (\`uniwareStatus\` LIKE 'COMPLETE%' OR \`uniwareStatus\` LIKE 'CANCELLED%')`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` DROP COLUMN \`uniwareDoneAt\``);
        await queryRunner.query(`DROP INDEX \`idx_uniware_creates_upload\` ON \`uniware_creates\``);
        await queryRunner.query(`DROP INDEX \`idx_uniware_creates_status\` ON \`uniware_creates\``);
        await queryRunner.query(`DROP TABLE \`uniware_creates\``);
    }

}
