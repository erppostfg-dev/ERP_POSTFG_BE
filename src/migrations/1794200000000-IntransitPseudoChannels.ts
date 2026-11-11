import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * In-transit pseudo channels (2026-11-04): Website and DarkStore, INACTIVE (kept out of PO Verify, Manual Upload, intake).
 * The in-transit Location Master names them (Website = the D2C hubs, DarkStore = the NCR dark stores), and the masters
 * upload refuses the whole file while a channel is missing: so the database Location Master stayed at 37 rows, every
 * other fulfilment centre came out as "no Final Location" and builds stopped at the new-SKU question (287 on 4 Nov).
 * Only on a database that already has its channel list (dev / prod): an empty database built from the migrations (the
 * CI test DB) seeds its channels itself, with fixed ids. down() removes them only when no location uses them.
 */

const CHANNELS: [slug: string, name: string][] = [['website', 'Website'], ['darkstore', 'DarkStore']];

export class IntransitPseudoChannels1794200000000 implements MigrationInterface {
    name = 'IntransitPseudoChannels1794200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [{ n }] = await queryRunner.query(`SELECT COUNT(*) AS n FROM \`master_channels\``);
        if (Number(n) === 0) return;
        for (const [slug, name] of CHANNELS) {
            await queryRunner.query(
                `INSERT INTO \`master_channels\` (\`slug\`, \`display_name\`, \`db_aliases\`, \`has_processor\`, \`is_active\`)
                 SELECT ?, ?, ?, 0, 0 FROM DUAL
                  WHERE NOT EXISTS (SELECT 1 FROM \`master_channels\` WHERE \`slug\` = ? OR \`display_name\` = ?)`,
                [slug, name, JSON.stringify([name, slug]), slug, name],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [slug] of CHANNELS) {
            await queryRunner.query(
                `DELETE c FROM \`master_channels\` c WHERE c.\`slug\` = ? AND c.\`is_active\` = 0
                   AND NOT EXISTS (SELECT 1 FROM \`details_channels\` d WHERE d.\`channel_id\` = c.\`id\`)`,
                [slug],
            );
        }
    }

}
