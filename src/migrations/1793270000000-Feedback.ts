import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Feedback (2026-10-29, user: everyone adds problems / improvements / questions with up to 4 images; the reporter, the
 * people added to an item and developer / admin change it): 4 new tables, nothing else changes. Generated from the
 * entities (feedback.entities.ts) by the schema check (test/meta/schema.test.ts). down() drops them (their rows go too).
 */

export class Feedback1793270000000 implements MigrationInterface {
    name = 'Feedback1793270000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`feedback_items\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`type\` enum ('problem', 'improvement', 'question') NOT NULL, \`title\` varchar(200) NOT NULL, \`description\` text NOT NULL, \`severity\` enum ('blocking', 'annoying', 'small') NULL, \`status\` enum ('new', 'in_progress', 'planned', 'fixed', 'wont_do', 'duplicate') NOT NULL DEFAULT 'new', \`duplicate_of_id\` bigint NULL, \`page\` varchar(500) NULL, \`context\` json NULL, \`reporter_id\` int NOT NULL, \`updated_by\` int NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_feedback_items_created\` (\`created_at\`), INDEX \`idx_feedback_items_status\` (\`status\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`feedback_members\` (\`item_id\` bigint NOT NULL, \`user_id\` int NOT NULL, \`added_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_feedback_members_user\` (\`user_id\`), PRIMARY KEY (\`item_id\`, \`user_id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`feedback_images\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`item_id\` bigint NOT NULL, \`s3_url\` varchar(1000) NOT NULL, \`file_name\` varchar(255) NOT NULL, \`content_type\` varchar(50) NOT NULL, \`size_bytes\` int NOT NULL, \`uploaded_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`removed_at\` datetime(6) NULL, \`removed_by\` int NULL, INDEX \`idx_feedback_images_item\` (\`item_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`feedback_comments\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`item_id\` bigint NOT NULL, \`user_id\` int NOT NULL, \`kind\` enum ('comment', 'change') NOT NULL DEFAULT 'comment', \`text\` text NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_feedback_comments_item\` (\`item_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` ADD CONSTRAINT \`fk_feedback_items_duplicate_of\` FOREIGN KEY (\`duplicate_of_id\`) REFERENCES \`feedback_items\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` ADD CONSTRAINT \`fk_feedback_items_reporter\` FOREIGN KEY (\`reporter_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` ADD CONSTRAINT \`fk_feedback_items_updated_by\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` ADD CONSTRAINT \`fk_feedback_members_item\` FOREIGN KEY (\`item_id\`) REFERENCES \`feedback_items\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` ADD CONSTRAINT \`fk_feedback_members_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` ADD CONSTRAINT \`fk_feedback_members_added_by\` FOREIGN KEY (\`added_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` ADD CONSTRAINT \`fk_feedback_images_item\` FOREIGN KEY (\`item_id\`) REFERENCES \`feedback_items\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` ADD CONSTRAINT \`fk_feedback_images_uploaded_by\` FOREIGN KEY (\`uploaded_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` ADD CONSTRAINT \`fk_feedback_images_removed_by\` FOREIGN KEY (\`removed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_comments\` ADD CONSTRAINT \`fk_feedback_comments_item\` FOREIGN KEY (\`item_id\`) REFERENCES \`feedback_items\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`feedback_comments\` ADD CONSTRAINT \`fk_feedback_comments_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`feedback_comments\` DROP FOREIGN KEY \`fk_feedback_comments_user\``);
        await queryRunner.query(`ALTER TABLE \`feedback_comments\` DROP FOREIGN KEY \`fk_feedback_comments_item\``);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` DROP FOREIGN KEY \`fk_feedback_images_removed_by\``);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` DROP FOREIGN KEY \`fk_feedback_images_uploaded_by\``);
        await queryRunner.query(`ALTER TABLE \`feedback_images\` DROP FOREIGN KEY \`fk_feedback_images_item\``);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` DROP FOREIGN KEY \`fk_feedback_members_added_by\``);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` DROP FOREIGN KEY \`fk_feedback_members_user\``);
        await queryRunner.query(`ALTER TABLE \`feedback_members\` DROP FOREIGN KEY \`fk_feedback_members_item\``);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` DROP FOREIGN KEY \`fk_feedback_items_updated_by\``);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` DROP FOREIGN KEY \`fk_feedback_items_reporter\``);
        await queryRunner.query(`ALTER TABLE \`feedback_items\` DROP FOREIGN KEY \`fk_feedback_items_duplicate_of\``);
        await queryRunner.query(`DROP TABLE \`feedback_comments\``);
        await queryRunner.query(`DROP TABLE \`feedback_images\``);
        await queryRunner.query(`DROP TABLE \`feedback_members\``);
        await queryRunner.query(`DROP TABLE \`feedback_items\``);
    }

}
