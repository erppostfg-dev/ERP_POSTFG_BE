import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * PO Overview line list (2026-11-27, prod jam: the page query sorted every line + its PO, 4-12 s, 30 s under load).
 * The page is now read in index order: details_purchase_orders (shipmentOrderId DESC, id ASC) = newest PO first, its
 * lines in their order. MySQL 8 builds it online (reads / writes go on); ~320K rows on prod = seconds. down() drops it.
 */

export class LineListIndex1797000000000 implements MigrationInterface {
    name = 'LineListIndex1797000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("CREATE INDEX `idx_details_po_ship_desc` ON `details_purchase_orders` (`shipmentOrderId` DESC, `id` ASC)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX `idx_details_po_ship_desc` ON `details_purchase_orders`");
    }

}
