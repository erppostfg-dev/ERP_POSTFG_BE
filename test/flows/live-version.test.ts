import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reviewVersion } from '../../src/modules/po-review/po-review.live';
import { closeDb, db, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * Load (2026-11-04, audit K8 + K9): the screens' live "anything new?" check every few seconds used COUNT(*) + MAX(updated_at)
 * with no index (two full table scans). Now MAX(id) + MAX(updated_at) on indexes (migration ListIndexes): MySQL answers
 * both from the index alone ("Select tables optimized away" = no rows read), and the version still moves on every new
 * row and every change.
 */

beforeEach(resetDb);
afterAll(closeDb);

describe('live check', () => {
  it('reads no rows: both MAX values come straight from an index (EXPLAIN)', async () => {
    for (const table of ['po_uploads', 'po_review_submissions']) {
      const plan = await rows<{ Extra: string | null }>(`EXPLAIN SELECT MAX(id), MAX(updated_at) FROM ${table}`);
      expect(plan.map((p) => p.Extra).join(' ')).toMatch(/Select tables optimized away|No matching min\/max row/);
    }
  });

  it('the version moves on a new PO and on a change to one', async () => {
    const m = await seedMasters();
    const v0 = await reviewVersion();
    const u = await runPo(bigBasketPo(m, { po_number: 'IRA98000001', delivery_facility_code: 'WMS-UNKNOWN', delivery_pincode: '999999' }));
    const v1 = await reviewVersion();
    expect(v1).not.toBe(v0);
    // a change one second later (updated_at has second precision): the DB itself sets updated_at
    await new Promise((r) => setTimeout(r, 1_100));
    await (await db()).query("UPDATE po_uploads SET status = 'rejected' WHERE id = ?", [u.id]);
    expect(await reviewVersion()).not.toBe(v1);
  });

  it('the new list indexes are there (migration ListIndexes)', async () => {
    const idx = await rows<{ t: string; n: string }>(
      `SELECT DISTINCT TABLE_NAME t, INDEX_NAME n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN
        ('idx_po_uploads_updated', 'idx_po_uploads_status_completed', 'idx_po_uploads_status_updated', 'idx_po_uploads_status_received',
         'idx_po_issues_upload_status', 'idx_po_review_submissions_decided', 'idx_po_review_submissions_updated')`);
    expect(idx).toHaveLength(7);
  });
});
