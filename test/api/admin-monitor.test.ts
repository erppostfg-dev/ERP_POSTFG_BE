import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearErrorCountCache, clearMonitorCache } from '../../src/modules/monitor/monitor.service';
import { clearClientErrorLimits } from '../../src/routes/client-errors.routes';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, resetDb } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Admin > Monitor (2026-11-05, developers only): CloudWatch logs + metrics read with the EC2's OWN role. The AWS layer
 * (modules/monitor/aws.ts) is replaced here: the tests check who may see it, the laptop answer (no instance = nothing
 * read), how the log lines become health points / alerts / the peak view, and that one failing read keeps the rest.
 */
covers([
  'GET /admin/monitor/access', 'GET /admin/monitor/overview', 'GET /admin/monitor/peak',
  'GET /admin/monitor/errors', 'GET /admin/monitor/errors/count', 'GET /admin/monitor/errors/request/:requestId', 'POST /client-errors',
]);

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
let devUserId = 0;
const answer = (query: string): Record<string, string>[] => {
  if (query.includes('by errorCode, method, path')) {
    return [{ errorCode: 'PO_NOT_VERIFIED', method: 'GET', path: '/po-review/12/csv', n: '4', people: '2', first: '2026-11-26 09:00:00.000', last: '2026-11-26 09:30:00.000', error: 'Verify the PO first', requestId: 'req-abc1', status: '409', lastUser: String(devUserId), level: 'info' }];
  }
  if (query.includes('by code, source')) {
    return [{ code: 'UNIWARE_FORBIDDEN', source: 'UNIWARE', n: '500', first: '2026-11-26 06:29:00.000', last: '2026-11-26 07:19:00.000', msg: 'saleorder/get refused', reason: 'Uniware refused the call', fix: 'check the API user / IP allow-list', jobId: 'po-sync-9', level: 'error' }];
  }
  if (query.includes('by kind, errorCode, page')) {
    return [{ kind: 'crash', errorCode: 'UI_CRASH', page: '/operations/po-review', n: '1', people: '1', first: '2026-11-26 08:00:00.000', last: '2026-11-26 08:00:00.000', error: 'TypeError: x is undefined', lastUser: '999999', level: 'warn' }];
  }
  if (query.includes('level = "error" or code = "CLIENT_ERROR"')) return [{ n: '5' }];
  if (query.includes('filter requestId =')) {
    return [
      { '@timestamp': '2026-11-26 09:30:00.000', '@message': JSON.stringify({ level: 'info', code: 'API_CLIENT_ERROR', source: 'APP', msg: 'GET /po-review/12/csv 409', requestId: 'req-abc1', status: 409 }) },
    ];
  }
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
  clearErrorCountCache();
  clearClientErrorLimits();
  dev = await loginAs('developer');
  devUserId = dev.userId;
});
afterAll(closeDb);

describe('Admin > Monitor', () => {
  it('developers only (an admin is refused, no login = 401)', async () => {
    const admin = await loginAs('admin');
    for (const path of ['/access', '/overview', '/peak?at=2026-11-05T10:05:00Z', '/errors', '/errors/count', '/errors/request/req-abc1']) {
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

  it('overview: heartbeats -> health points, alerts + counts, which POST_FG; no machine / database metrics; window checked', async () => {
    expect((await api().get(`${V}/overview?window=2y`).set('Cookie', dev.cookie)).status).toBe(400);
    const d = (await api().get(`${V}/overview?window=1h`).set('Cookie', dev.cookie)).body.data;
    expect(d.window).toBe('1h');
    expect(d.health.data).toHaveLength(2);
    expect(d.health.data[1]).toMatchObject({ t: '2026-11-05T10:05:00.000Z', rssMb: 612, dbPoolFree: 7, dbPoolMaxWaiting: 2, running: ['job:ocr upload 70'] });
    expect(d.alerts.data[0]).toMatchObject({ code: 'API_SLOW', t: '2026-11-05T10:04:00.000Z' });
    expect(d.alertCounts.data).toEqual([{ code: 'API_SLOW', level: 'warn', count: 7, last: '2026-11-05T10:04:00.000Z' }]);
    expect(d.env.database).toBe('mcaff_postfg_test');
    expect(d.metrics).toBeUndefined();
    expect(d.alarms).toBeUndefined();
    expect(aws.metricData).not.toHaveBeenCalled();
    expect(aws.alarms).not.toHaveBeenCalled();
  });

  it('one read refused (no permission yet): that part says why, the rest still shows', async () => {
    aws.insights.mockImplementation((q: string) => (q.includes('level in') && !q.includes('stats')
      ? Promise.reject(Object.assign(new Error('not authorized to perform: logs:StartQuery'), { name: 'AccessDenied' }))
      : Promise.resolve(answer(q))));
    const d = (await api().get(`${V}/overview`).set('Cookie', dev.cookie)).body.data;
    expect(d.alerts).toMatchObject({ ok: false, data: null });
    expect(d.alerts.error).toContain('AccessDenied');
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

  it('errors: what people saw / background failures / browser errors, grouped, with the last person; window checked', async () => {
    expect((await api().get(`${V}/errors?window=2y`).set('Cookie', dev.cookie)).status).toBe(400);
    const d = (await api().get(`${V}/errors?window=24h`).set('Cookie', dev.cookie)).body.data;
    expect(d).toMatchObject({ onServer: true, window: '24h', totals: { server: 4, background: 500, browser: 1 } });
    expect(d.env.database).toBe('mcaff_postfg_test');
    expect(d.server.data[0]).toMatchObject({
      what: 'PO_NOT_VERIFIED', where: 'GET /po-review/12/csv', count: 4, people: 2, status: 409, requestId: 'req-abc1',
      last: '2026-11-26T09:30:00.000Z', lastUser: { id: dev.userId, email: dev.email },
    });
    expect(d.background.data[0]).toMatchObject({ what: 'UNIWARE_FORBIDDEN', where: 'UNIWARE', count: 500, fix: 'check the API user / IP allow-list', jobId: 'po-sync-9', lastUser: null });
    // a person no longer in the users table: no name, the row still shows
    expect(d.browser.data[0]).toMatchObject({ what: 'crash · UI_CRASH', where: '/operations/po-review', lastUser: null });
    // the signed-out check is not an error; the load hints are not failures
    const queries = aws.insights.mock.calls.map((c) => String(c[0]));
    expect(queries.find((q) => q.includes('by errorCode, method, path'))).toContain('errorCode != "UNAUTHENTICATED"');
    expect(queries.find((q) => q.includes('by code, source'))).toContain('code != "API_SLOW"');
  });

  it('errors on a laptop: says so, reads nothing', async () => {
    aws.instance = null;
    const d = (await api().get(`${V}/errors`).set('Cookie', dev.cookie)).body.data;
    expect(d).toMatchObject({ onServer: false, totals: { server: 0, background: 0, browser: 0 }, server: { ok: false } });
    expect((await api().get(`${V}/errors/count`).set('Cookie', dev.cookie)).body.data).toEqual({ onServer: false, lastHour: null });
    expect(aws.insights).not.toHaveBeenCalled();
  });

  it('errors/count: serious errors of the last hour, asked of CloudWatch at most every 5 minutes; a refused read = null', async () => {
    expect((await api().get(`${V}/errors/count`).set('Cookie', dev.cookie)).body.data).toEqual({ onServer: true, lastHour: 5 });
    await api().get(`${V}/errors/count`).set('Cookie', dev.cookie);
    expect(aws.insights).toHaveBeenCalledTimes(1);
    clearErrorCountCache();
    aws.insights.mockRejectedValue(new Error('AccessDenied'));
    expect((await api().get(`${V}/errors/count`).set('Cookie', dev.cookie)).body.data).toEqual({ onServer: true, lastHour: null });
  });

  it('errors/request/:id: every line of one request; a bad id is refused before CloudWatch', async () => {
    expect((await api().get(`${V}/errors/request/${encodeURIComponent('x" or 1=1')}`).set('Cookie', dev.cookie)).status).toBe(400);
    expect(aws.insights).not.toHaveBeenCalled();
    const d = (await api().get(`${V}/errors/request/req-abc1`).set('Cookie', dev.cookie)).body.data;
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ t: '2026-11-26T09:30:00.000Z', code: 'API_CLIENT_ERROR', fields: { requestId: 'req-abc1', status: 409 } });
  });
});

describe('POST /client-errors (a browser reports what the server never saw)', () => {
  const C = '/api/v1/client-errors';
  const ok = { kind: 'crash', message: 'TypeError: x is undefined', page: '/operations/po-review', code: 'UI_CRASH' };

  it('any signed-in person; not signed in = 401', async () => {
    expect((await api().post(C).send(ok)).status).toBe(401);
    const viewer = await loginAs('viewer');
    const res = await api().post(C).set('Cookie', viewer.cookie).send(ok);
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ logged: true });
  });

  it('writes one CLIENT_ERROR log line (warn), with the person and the page', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
    try {
      await api().post(C).set('Cookie', dev.cookie).send({ ...ok, status: 0, requestId: 'req-x1' });
    } finally {
      spy.mockRestore();
    }
    const line = out.find((l) => l.includes('CLIENT_ERROR'));
    expect(line).toBeDefined();
    expect(line).toContain('/operations/po-review');
  });

  it('checks the body: kind from the list, message and page required', async () => {
    const res = await api().post(C).set('Cookie', dev.cookie).send({ kind: 'boom', page: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['kind', 'message', 'page']);
  });

  it('at most 20 lines per person per minute: more are dropped quietly', async () => {
    let last: { logged: boolean } | null = null;
    for (let i = 0; i < 21; i++) last = (await api().post(C).set('Cookie', dev.cookie).send(ok)).body.data;
    expect(last).toEqual({ logged: false });
  });
});
