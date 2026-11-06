import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Feedback notifications (2026-11-06, user: "if they are assigned or someone replied in the thread they get a
 * notification at the top icon with 1, 2"): one new table feedback_notifications (who is told, the item, assigned /
 * added / comment, who did it, read_at). Nothing else changes; no rows for the past. Generated from the entity by the
 * schema check (test/meta/schema.test.ts). down() drops it (its rows go too).
 */

export class FeedbackNotifications1794300000000 implements MigrationInterface {
    name = 'FeedbackNotifications1794300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`feedback_notifications\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`user_id\` int NOT NULL, \`item_id\` bigint NOT NULL, \`kind\` enum ('assigned', 'added', 'comment') NOT NULL, \`actor_id\` int NOT NULL, \`text\` varchar(300) NOT NULL DEFAULT '', \`read_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_feedback_notifications_item\` (\`item_id\`, \`user_id\`), INDEX \`idx_feedback_notifications_user\` (\`user_id\`, \`read_at\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` ADD CONSTRAINT \`fk_feedback_notifications_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` ADD CONSTRAINT \`fk_feedback_notifications_item\` FOREIGN KEY (\`item_id\`) REFERENCES \`feedback_items\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` ADD CONSTRAINT \`fk_feedback_notifications_actor\` FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` DROP FOREIGN KEY \`fk_feedback_notifications_actor\``);
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` DROP FOREIGN KEY \`fk_feedback_notifications_item\``);
        await queryRunner.query(`ALTER TABLE \`feedback_notifications\` DROP FOREIGN KEY \`fk_feedback_notifications_user\``);
        await queryRunner.query(`DROP TABLE \`feedback_notifications\``);
    }

}
