import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Feedback "Assigned to" (2026-10-29, user: "we need assign it to and who created, always in the app"): one nullable
 * column feedback_items.assigned_to (FK users, RESTRICT) + its index. Existing items stay unassigned. down() drops it.
 */

export class FeedbackAssignee1793280000000 implements MigrationInterface {
    name = 'FeedbackAssignee1793280000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`feedback_items\` ADD \`assigned_to\` int NULL`);
        await queryRunner.query(`CREATE INDEX \`idx_feedback_items_assigned\` ON \`feedback_items\` (\`assigned_to\`)`);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` ADD CONSTRAINT \`fk_feedback_items_assigned_to\` FOREIGN KEY (\`assigned_to\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`feedback_items\` DROP FOREIGN KEY \`fk_feedback_items_assigned_to\``);
        await queryRunner.query(`DROP INDEX \`idx_feedback_items_assigned\` ON \`feedback_items\``);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` DROP COLUMN \`assigned_to\``);
    }

}
