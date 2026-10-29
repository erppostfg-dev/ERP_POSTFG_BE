import { describe, expect, it } from 'vitest';
import { recentReport, ReportJob } from '../sources/myntra-partner-portal';

/*
 * The Myntra robot's fallback (user, 2026-10-28): Myntra refuses a new Seller_Inventory_Report a while after the last
 * one, and the newest completed one of the MYNTRA store is used instead while it is recent.
 */

const NOW = Date.parse('2026-10-28T11:00:00Z');
const job = (id: number, minutesAgo: number, over: Partial<ReportJob> = {}): ReportJob => ({
  id, reportId: 16, status: 'COMPLETED', createdOn: NOW - minutesAgo * 60_000, queryParams: '{"storeId":"2297","partnerType":"PPMP"}', ...over,
});

describe('Myntra recent Seller_Inventory_Report', () => {
  it('takes the newest completed one', () => {
    expect(recentReport([job(3, 10), job(2, 40)], NOW)?.id).toBe(3);
  });

  it('skips jobs still running, other reports and other stores', () => {
    const jobs = [
      job(5, 2, { status: 'IN_PROGRESS' }),
      job(4, 5, { reportId: 12 }),
      job(3, 8, { queryParams: { storeId: 4603, partnerType: 'PPMP' } }),
      job(2, 30, { queryParams: { storeId: 2297, partnerType: 'PPMP' } }),
    ];
    expect(recentReport(jobs, NOW)?.id).toBe(2);
  });

  it('uses none older than two hours', () => {
    expect(recentReport([job(1, 121)], NOW)).toBeUndefined();
  });
});
