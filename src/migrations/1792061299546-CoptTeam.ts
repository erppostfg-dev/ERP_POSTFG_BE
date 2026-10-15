import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * COPT team (2026-10-15, user): planning's columns from Special Remarks to Delivery Type moved to a new COPT group,
 * after planning. Adds 'copt' to users.po_team, team_column_access.team and .column_group (CHANGEd in place, values
 * kept) and seeds the 10 default access rows (constants DEFAULT_TEAM_ACCESS): COPT edits COPT and sees the rest;
 * every other team (planning too) sees COPT. Hand-added INSERT / DELETE. down() removes exactly this (it fails while a
 * user is still on team copt: move them first).
 */

export class CoptTeam1792061299546 implements MigrationInterface {
    name = 'CoptTeam1792061299546'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` CHANGE \`po_team\` \`po_team\` enum ('planning', 'copt', 'warehouse', 'logistics', 'accounts', 'viewer') NULL`);
        await queryRunner.query(`DROP INDEX \`uq_team_column_access\` ON \`team_column_access\``);
        await queryRunner.query(`ALTER TABLE \`team_column_access\` CHANGE \`team\` \`team\` enum ('planning', 'copt', 'warehouse', 'logistics', 'accounts', 'viewer') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`team_column_access\` CHANGE \`column_group\` \`column_group\` enum ('planning', 'copt', 'warehouse', 'logistics', 'accounts') NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`uq_team_column_access\` ON \`team_column_access\` (\`team\`, \`column_group\`)`);
        await queryRunner.query(`INSERT INTO \`team_column_access\` (\`team\`, \`column_group\`, \`access\`) VALUES ('copt', 'planning', 'view'), ('copt', 'copt', 'edit'), ('copt', 'warehouse', 'view'), ('copt', 'logistics', 'view'), ('copt', 'accounts', 'view'), ('planning', 'copt', 'view'), ('warehouse', 'copt', 'view'), ('logistics', 'copt', 'view'), ('accounts', 'copt', 'view'), ('viewer', 'copt', 'view')`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM \`team_column_access\` WHERE \`team\` = 'copt' OR \`column_group\` = 'copt'`);
        await queryRunner.query(`DROP INDEX \`uq_team_column_access\` ON \`team_column_access\``);
        await queryRunner.query(`ALTER TABLE \`team_column_access\` CHANGE \`column_group\` \`column_group\` enum ('planning', 'warehouse', 'logistics', 'accounts') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`team_column_access\` CHANGE \`team\` \`team\` enum ('planning', 'warehouse', 'logistics', 'accounts', 'viewer') NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`uq_team_column_access\` ON \`team_column_access\` (\`team\`, \`column_group\`)`);
        await queryRunner.query(`ALTER TABLE \`users\` CHANGE \`po_team\` \`po_team\` enum ('planning', 'warehouse', 'logistics', 'accounts', 'viewer') NULL`);
    }

}
