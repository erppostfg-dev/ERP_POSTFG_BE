import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * D2C transfer routes with more than one Uniware channel (2026-11-03; plan d2c-internal-transfers, "Updated route
 * sheet"): a route (sending facility, transfer location) may have 2+ Uniware channels (Motherhub routes:
 * D2C_TRANSFER_HYP_L and D2C_TRANSFER_MCAFF_L); Ops pick one per transfer.
 *   - d2c_transfer_routes: unique key (dispatch_facility_id, location_id) -> (dispatch_facility_id, location_id,
 *     uniware_channel_code). The new index is added BEFORE the old one is dropped: fk_d2c_transfer_routes_facility needs
 *     an index starting with dispatch_facility_id at every moment (the new unique key starts with it);
 *   - master_purchase_orders.transferRouteId int NULL -> d2c_transfer_routes.id (ON DELETE RESTRICT, own index): the
 *     route (so the Uniware channel / customer / vendor) a transfer uses. NULL for channel POs.
 * down() REFUSES while a route pair has 2+ rows or a transfer has transferRouteId set.
 */

export class D2cRouteChannels1794000000000 implements MigrationInterface {
    name = 'D2cRouteChannels1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` ADD UNIQUE INDEX \`uq_d2c_transfer_routes_route_channel\` (\`dispatch_facility_id\`, \`location_id\`, \`uniware_channel_code\`)`);
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` DROP INDEX \`uq_d2c_transfer_routes_route\``);
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` ADD \`transferRouteId\` int NULL, ADD INDEX \`idx_master_po_transfer_route\` (\`transferRouteId\`)`);
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` ADD CONSTRAINT \`fk_master_po_transfer_route\` FOREIGN KEY (\`transferRouteId\`) REFERENCES \`d2c_transfer_routes\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [t] = await queryRunner.query(`SELECT COUNT(*) n FROM \`master_purchase_orders\` WHERE \`transferRouteId\` IS NOT NULL`);
        if (Number(t.n)) throw new Error(`${t.n} transfer(s) have transferRouteId set: the chosen Uniware channel would be lost. Not reverted.`);
        const pairs = await queryRunner.query(
            `SELECT dispatch_facility_id, location_id, COUNT(*) n FROM \`d2c_transfer_routes\` GROUP BY dispatch_facility_id, location_id HAVING COUNT(*) > 1`,
        );
        if (pairs.length) {
            throw new Error(`${pairs.length} route(s) (sender + location) have 2+ Uniware channels (e.g. facility ${pairs[0].dispatch_facility_id} -> location ${pairs[0].location_id}): keep one row each first. Not reverted.`);
        }
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` DROP FOREIGN KEY \`fk_master_po_transfer_route\``);
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` DROP INDEX \`idx_master_po_transfer_route\`, DROP COLUMN \`transferRouteId\``);
        // old key back first, then the new one goes (the facility FK keeps an index all the time)
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` ADD UNIQUE INDEX \`uq_d2c_transfer_routes_route\` (\`dispatch_facility_id\`, \`location_id\`)`);
        await queryRunner.query(`ALTER TABLE \`d2c_transfer_routes\` DROP INDEX \`uq_d2c_transfer_routes_route_channel\``);
    }

}
