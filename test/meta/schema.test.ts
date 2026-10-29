import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../helpers/db';

/*
 * The entities and the migrations describe the same schema (2026-10-29): the test DB is built from ALL migrations
 * (setup/global.ts), so anything TypeORM would still change to match the entities is a migration that is missing or
 * wrong (a new column in an entity without its migration fails here, before it fails on dev). The SQL TypeORM wants is
 * printed: it is what `npm run migration:generate` would write.
 */
afterAll(closeDb);

describe('schema', () => {
  it('the migrations build exactly what the entities describe', async () => {
    const pending = (await (await db()).driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    if (pending.length) console.log(`Missing in the migrations:\n${pending.join(';\n')}`);
    expect(pending).toEqual([]);
  });
});
