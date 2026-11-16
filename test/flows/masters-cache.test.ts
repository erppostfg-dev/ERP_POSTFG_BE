import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { importMasterUpload } from '../../src/modules/intransit/masters-upload';
import { cachedPepSkus } from '../../src/modules/masters/masters.cache';
import { closeDb, insert, resetDb, rows } from '../helpers/db';

/*
 * The shared cached PEP SKU list (2026-11-11, modules/masters/masters.cache.ts): an In-transit master upload (Ajay's
 * modules/intransit, which writes master_skus outside the Masters page) drops it after its commit, like a Masters save;
 * a dry run does not (nothing was written).
 */

const mrpOf = async (code: string) => (await cachedPepSkus()).find((s) => s.pepCode === code)?.mrp;
const upload = (dryRun: boolean) =>
  importMasterUpload('SKU-Not To Consider.csv', new TextEncoder().encode('Item SkuCode\nSKU_C\n'), { id: null, name: 'test' }, { dryRun });
const intransitTest = env.intransit.test;

beforeEach(async () => {
  await resetDb();
  const now = new Date();
  await insert('master_skus', { pep_code: 'SKU_C', product_name: 'Coffee Lip Balm', mrp: 100, is_active: 1, created_at: now, updated_at: now });
  // master uploads are refused on a test machine (INTRANSIT_TEST); this test writes only to the test DB
  (env.intransit as { test: boolean }).test = false;
});
afterEach(() => {
  (env.intransit as { test: boolean }).test = intransitTest;
});
afterAll(closeDb);

describe('shared cached SKU list', () => {
  it('an In-transit master upload drops it after the commit; a dry run does not', async () => {
    expect(await mrpOf('SKU_C')).toBe(100);
    await rows('UPDATE master_skus SET mrp = 130 WHERE pep_code = ?', ['SKU_C']);
    expect(await mrpOf('SKU_C')).toBe(100); // cached
    await upload(true);
    expect(await mrpOf('SKU_C')).toBe(100); // dry run: nothing written, cache kept
    await upload(false);
    expect(await mrpOf('SKU_C')).toBe(130); // committed: dropped, read again
    expect(await rows('SELECT intransit_consider FROM master_skus WHERE pep_code = ?', ['SKU_C'])).toEqual([{ intransit_consider: 0 }]);
  });
});
