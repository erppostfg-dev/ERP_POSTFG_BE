import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMonitorCache } from '../../src/modules/monitor/monitor.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Admin > Monitor (2026-11-05, developers only): CloudWatch logs + metrics read with the EC2's OWN role. The AWS layer
 * (modules/monitor/aws.ts) is replaced here: the tests check who may see it, the laptop answer (no instance = nothing
 * read), how the log lines become health points / alerts / the peak view, and that one failing read keeps the rest.
 */
covers(['GET /admin/monitor/access', 'GET /admin/monitor/overview', 'GET /admin/monitor/peak']);

const aws = vi.hoisted(() => ({
  instance: null as string | null,
  insights: vi.fn(),
  metricData: vi.fn(),
  alarms: vi.fn(),
  checkAccess: vi.fn(),
}));
vi.mock('../../src/modules/monitor/aws', () => ({
  onServer: () => Promise.resolve(aws.instance),
  insights: aws.insights,
  metricData: aws.metricData,
  alarms: aws.alarms,
  checkAccess: aws.checkAccess,
}));

const V = '/api/v1/admin/monitor';
let dev: TestLogin;

const beat = (t: string, rssMb: number, running: unknown[] = []) => ({
  '@timestamp': t,
  '@message': JSON.stringify({ code: 'PROCESS_HEARTBEAT', rssMb, cpuPct: 12, loopP99Ms: 20, requests: 40, errors5xx: 1, dbPool: { size: 10, free: 7, waiting: 0, maxWaiting: 2 }, running }),
});

/** Answers per query text, as CloudWatch would. */
const answer = (query: string): Record<string, string>[] => {
  if (query.includes('PROCESS_HEARTBEAT')) return [beat('2026-11-05 10:00:00.000', 310), beat('2026-11-05 10:05:00.000', 612, ['job:ocr upload 70'])];
  if (query.includes('stats count() as n')) return [{ code: 'API_SLOW', level: 'warn', n: '7', last: '2026-11-05 10:04:00.000' }];
  if (query.includes('by method, path')) return [{ method: 'GET', path: '/po-review', calls: '30', avgMs: '412.5', maxMs: '3900', dbq: '120', kbs: '800' }];
  if (query.includes('by jobId')) return [{ jobId: 'ocr-70', source: 'OCR', lines: '12', first: '2026-11-05 10:01:00.000', last: '2026-11-05 10:04:30.000', firstMsg: 'OCR started' }];
  if (query.includes('level in')) return [{ '@timestamp': '2026-11-05 10:04:00.000', level: 'warn', code: 'API_SLOW', msg: 'GET /po-review 3900 ms', path: '/po-review' }];
  return [];
};

beforeEach(async () => {
  await resetDb();
  clearMonitorCache();
  aws.instance = 'i-0861f2e66c3ce83f7';
  aws.insights.mockReset().mockImplementation((q: string) => Promise.resolve(answer(q)));
  aws.metricData.mockReset().mockResolvedValue([
    { id: 'cpu', label: 'CPU %', points: [{ t: '2026-11-05T10:00:00.000Z', v: 8 }] },
    { id: 'mem', label: 'mem_used_percent', points: [{ t: '2026-11-05T10:00:00.000Z', v: 71 }] },
    { id: 'dbcpu', label: 'CPUUtilization', points: [{ t: '2026-11-05T10:00:00.000Z', v: 33 }] },
  ]);
  aws.alarms.mockReset().mockResolvedValue([]);
  aws.checkAccess.mockReset().mockResolvedValue([{ action: 'logs:StartQuery + GetQueryResults', ok: true, error: null }]);
  dev = await loginAs('developer');
});
afterAll(closeDb);

describe('Admin > Monitor', () => {
  it('developers only (an admin is refused, no login = 401)', async () => {
    const admin = await loginAs('admin');
    for (const path of ['/access', '/overview', '/peak?at=2026-11-05T10:05:00Z']) {
      expect((await api().get(V + path)).status).toBe(401);
      expect((await api().get(V + path).set('Cookie', admin.cookie)).body.error.code).toBe('DEVELOPER_ONLY');
    }
    expect(aws.insights).not.toHaveBeenCalled();
  });

  it('on a laptop (no instance): says so and reads nothing from AWS', async () => {
    aws.instance = null;
    const access = (await api().get(`${V}/access`).set('Cookie', dev.cookie)).body.data;
    expect(access).toMatchObject({ onServer: false, checks: [] });
    const overview = (await api().get(`${V}/overview`).set('Cookie', dev.cookie)).body.data;
    expect(overview.onServer).toBe(false);
    expect(overview.health.ok).toBe(false);
    expect(aws.insights).not.toHaveBeenCalled();
    expect(aws.metricData).not.toHaveBeenCalled();
    expect(aws.checkAccess).not.toHaveBeenCalled();
  });

  it('access: the role checks of the server', async () => {
    const res = await api().get(`${V}/access`).set('Cookie', dev.cookie);
    expect(res.body.data).toMatchObject({ onServer: true, instanceId: 'i-0861f2e66c3ce83f7', checks: [{ ok: true }] });
  });

  it('overview: heartbeats -> health points, alerts + counts, server / database metrics; window checked', async () => {
    expect((await api().get(`${V}/overview?window=2y`).set('Cookie', dev.cookie)).status).toBe(400);
    const d = (await api().get(`${V}/overview?window=1h`).set('Cookie', dev.cookie)).body.data;
    expect(d.window).toBe('1h');
    expect(d.health.data).toHaveLength(2);
    expect(d.health.data[1]).toMatchObject({ t: '2026-11-05T10:05:00.000Z', rssMb: 612, dbPoolFree: 7, dbPoolMaxWaiting: 2, running: ['job:ocr upload 70'] });
    expect(d.alerts.data[0]).toMatchObject({ code: 'API_SLOW', t: '2026-11-05T10:04:00.000Z' });
    expect(d.alertCounts.data).toEqual([{ code: 'API_SLOW', level: 'warn', count: 7, last: '2026-11-05T10:04:00.000Z' }]);
    expect(d.metrics.data.server.map((s: { id: string }) => s.id)).toEqual(['cpu', 'mem']);
    expect(d.metrics.data.database.map((s: { id: string }) => s.id)).toEqual(['dbcpu']);
  });

  it('one read refused (no permission yet): that part says why, the rest still shows', async () => {
    aws.metricData.mockRejectedValue(Object.assign(new Error('not authorized to perform: cloudwatch:GetMetricData'), { name: 'AccessDenied' }));
    const d = (await api().get(`${V}/overview`).set('Cookie', dev.cookie)).body.data;
    expect(d.metrics).toMatchObject({ ok: false, data: null });
    expect(d.metrics.error).toContain('AccessDenied');
    expect(d.health.ok).toBe(true);
  });

  it('answers are kept a minute (each CloudWatch scan is metered)', async () => {
    await api().get(`${V}/overview`).set('Cookie', dev.cookie);
    const calls = aws.insights.mock.calls.length;
    await api().get(`${V}/overview`).set('Cookie', dev.cookie);
    expect(aws.insights.mock.calls.length).toBe(calls);
  });

  it('peak: APIs by load, jobs and alerts around that moment; at checked', async () => {
    expect((await api().get(`${V}/peak?at=yesterday`).set('Cookie', dev.cookie)).status).toBe(400);
    const d = (await api().get(`${V}/peak?at=2026-11-05T10:05:00Z`).set('Cookie', dev.cookie)).body.data;
    expect(d.from).toBe('2026-11-05T10:00:00.000Z');
    expect(d.apis.data).toEqual([{ method: 'GET', path: '/po-review', calls: 30, avgMs: 413, maxMs: 3900, dbQueries: 120, kb: 800 }]);
    expect(d.jobs.data[0]).toMatchObject({ jobId: 'ocr-70', source: 'OCR', lines: 12 });
    expect(d.health.data).toMatchObject({ rssMb: 310 });
  });
});
