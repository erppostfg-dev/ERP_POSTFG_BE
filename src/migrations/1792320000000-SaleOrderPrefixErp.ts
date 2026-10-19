import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Sale order prefix sf_ -> erp_ (user, 2026-10-19: "remove the sf prefix and add erp, and change everything till now").
 * Data only, no schema change. Renames the codes made so far (none was uploaded to Uniware, user confirmed):
 *   master_purchase_orders.orderNo1 (the PO's sale order), po_review_submissions.sale_order_code (approved reviews),
 *   shipment_logs.remark of "created" history rows (they show the code).
 * Only values that are exactly a code (sf_ + digits) change. The Uniware CSVs in S3 are rewritten by
 * `npm run sale-orders:prefix -- --apply`. down() puts sf_ back on the same values.
 * Hand-written (TypeORM has nothing to generate for data).
 */
export class SaleOrderPrefixErp1792320000000 implements MigrationInterface {
    name = 'SaleOrderPrefixErp1792320000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("UPDATE `master_purchase_orders` SET `orderNo1` = CONCAT('erp_', SUBSTRING(`orderNo1`, 4)) WHERE `orderNo1` REGEXP '^sf_[0-9]{11,}$'");
        await queryRunner.query("UPDATE `po_review_submissions` SET `sale_order_code` = CONCAT('erp_', SUBSTRING(`sale_order_code`, 4)) WHERE `sale_order_code` REGEXP '^sf_[0-9]{11,}$'");
        await queryRunner.query("UPDATE `shipment_logs` SET `remark` = CONCAT('erp_', SUBSTRING(`remark`, 4)) WHERE `action` = 'created' AND `remark` REGEXP '^sf_[0-9]{11,}$'");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("UPDATE `shipment_logs` SET `remark` = CONCAT('sf_', SUBSTRING(`remark`, 5)) WHERE `action` = 'created' AND `remark` REGEXP '^erp_[0-9]{11,}$'");
        await queryRunner.query("UPDATE `po_review_submissions` SET `sale_order_code` = CONCAT('sf_', SUBSTRING(`sale_order_code`, 5)) WHERE `sale_order_code` REGEXP '^erp_[0-9]{11,}$'");
        await queryRunner.query("UPDATE `master_purchase_orders` SET `orderNo1` = CONCAT('sf_', SUBSTRING(`orderNo1`, 5)) WHERE `orderNo1` REGEXP '^erp_[0-9]{11,}$'");
    }

}
