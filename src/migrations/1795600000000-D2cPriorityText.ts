import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * D2C transfer priority as free text (user, 2026-11-17: "Make it P0 and any thing as it may be different from P1 P2 P3"):
 * master_purchase_orders.transferPriority varchar(2) -> varchar(20) (D2C_LIMITS.PRIORITY_MAX). Values stay as they are.
 * down() cuts back to varchar(2): a longer priority is shortened to its first 2 characters first.
 */
export class D2cPriorityText1795600000000 implements MigrationInterface {
    name = 'D2cPriorityText1795600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `master_purchase_orders` MODIFY `transferPriority` varchar(20) NULL");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("UPDATE `master_purchase_orders` SET `transferPriority` = LEFT(`transferPriority`, 2) WHERE CHAR_LENGTH(`transferPriority`) > 2");
        await queryRunner.query("ALTER TABLE `master_purchase_orders` MODIFY `transferPriority` varchar(2) NULL");
    }
}
