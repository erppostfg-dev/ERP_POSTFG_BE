import type { EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { D2C_DEFAULT_SETTINGS, D2C_STATE_KEY } from '../../../constants';
import {
  addDays, nextRefSerial, nextTransferSerial, parseDay, peekReferences, pepimsMaxSerial, pruneByDate, refDateToken, RefSerials, serialOfReference,
  shouldReadPepims, takeTransferCodes, todayIst,
} from '../reference';

/*
 * Transfer codes and reference serials (plan 2.7 / 2.10): pure rules, and the counter takes against a fake
 * EntityManager that keeps app_state in memory and answers PEPIMS's shipment_orders query.
 */

/** app_state + PEPIMS poNumbers in memory; only the SQL reference.ts sends. */
const fakeDb = (pepims: string[] = [], opts: { pepimsMissing?: boolean } = {}) => {
  const state = new Map<string, unknown>();
  const queries: string[] = [];
  const m = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      queries.push(sql);
      if (sql.startsWith('INSERT IGNORE INTO app_state')) {
        if (!state.has(params[0] as string)) state.set(params[0] as string, JSON.parse(params[1] as string));
        return Promise.resolve({});
      }
      if (sql.startsWith('SELECT value FROM app_state')) {
        const v = state.get(params[0] as string);
        return Promise.resolve(v === undefined ? [] : [{ value: JSON.stringify(v) }]);
      }
      if (sql.startsWith('UPDATE app_state')) {
        state.set(params[1] as string, JSON.parse(params[0] as string));
        return Promise.resolve({});
      }
      if (sql.includes('shipment_orders')) {
        if (opts.pepimsMissing) return Promise.reject(Object.assign(new Error("Unknown database 'mcaff_inv'"), { code: 'ER_BAD_DB_ERROR' }));
        const like = String(params[0]).replace(/%/g, '');
        return Promise.resolve(pepims.filter((p) => p.toLowerCase().includes(like.toLowerCase())).map((poNumber) => ({ poNumber })));
      }
      return Promise.reject(new Error(`unexpected SQL: ${sql}`));
    },
  };
  return { m: m as unknown as EntityManager, state, queries };
};

describe('dates', () => {
  it('parseDay takes YYYY-MM-DD or DD-MM-YYYY real days only', () => {
    expect(parseDay('2026-11-05')).toBe('2026-11-05');
    expect(parseDay(' 05-11-2026 ')).toBe('2026-11-05');
    expect(parseDay('5-1-2027')).toBe('2027-01-05');
    expect(parseDay('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-29', '31-04-2026', '2026/11/05', '05/11/2026', '20261105', '', 'x', null, 5]) expect(parseDay(bad)).toBeNull();
  });

  it('addDays crosses months and years', () => {
    expect(addDays('2026-11-25', 15)).toBe('2026-12-10');
    expect(addDays('2026-12-25', 15)).toBe('2027-01-09');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('today is the Indian day', () => {
    expect(todayIst(new Date('2026-11-03T18:29:00Z'))).toBe('2026-11-03');
    expect(todayIst(new Date('2026-11-03T18:31:00Z'))).toBe('2026-11-04');
  });
});

describe('reference serial rules', () => {
  it('the date token is DDMonYYYY', () => {
    expect(refDateToken('2026-11-05')).toBe('05Nov2026');
    expect(refDateToken('2027-01-09')).toBe('09Jan2027');
  });

  it('reads the serial of a reference of that day, any tag, any case', () => {
    expect(serialOfReference('mCaff_Kolkata3|05Nov2026|12', '2026-11-05')).toBe(12);
    expect(serialOfReference('mCaff_Kolkata3|05Nov2026|Int13', '2026-11-05')).toBe(13);
    expect(serialOfReference('Okhla Hub-939|05NOV2026|Freebee14', '2026-11-05')).toBe(14);
    expect(serialOfReference('mCaff_Kolkata3|06Nov2026|15', '2026-11-05')).toBeNull();
    expect(serialOfReference('IRA90000001', '2026-11-05')).toBeNull();
  });

  it('next serial is above our counter and PEPIMS', () => {
    expect(nextRefSerial(0, 0)).toBe(1);
    expect(nextRefSerial(12, 3)).toBe(13);
    expect(nextRefSerial(3, 60)).toBe(61);
  });

  it('PEPIMS is read until cutover + 30 days', () => {
    expect(shouldReadPepims(null, '2026-11-03')).toBe(true);
    expect(shouldReadPepims('2026-12-01', '2026-12-30')).toBe(true);
    expect(shouldReadPepims('2026-12-01', '2026-12-31')).toBe(false);
  });

  it('the counter keeps 60 days (and the day just taken)', () => {
    expect(pruneByDate({ '2026-08-01': 4, '2026-09-04': 2, '2026-11-03': 9 }, '2026-11-03')).toEqual({ '2026-09-04': 2, '2026-11-03': 9 });
    expect(pruneByDate({ '2026-01-01': 4 }, '2026-11-03', ['2026-01-01'])).toEqual({ '2026-01-01': 4 });
  });

  it('transfer serial restarts in a new month', () => {
    expect(nextTransferSerial({ month: null, last: 0 }, '2627-11')).toEqual({ month: '2627-11', last: 1 });
    expect(nextTransferSerial({ month: '2627-11', last: 41 }, '2627-11')).toEqual({ month: '2627-11', last: 42 });
    expect(nextTransferSerial({ month: '2627-10', last: 41 }, '2627-11')).toEqual({ month: '2627-11', last: 1 });
  });
});

describe('counter takes (one transaction)', () => {
  const settings = { ...D2C_DEFAULT_SETTINGS };

  it('20 takes in one transaction give 20 different serials per day, above PEPIMS, saved once', async () => {
    const db = fakeDb(['mCaff_Kolkata3|05Nov2026|Int7', 'HYP_Nagpur|05Nov2026|4', 'X|06Nov2026|90']);
    const refs = await RefSerials.open(db.m, settings, '2026-11-03');
    const taken: number[] = [];
    for (let i = 0; i < 20; i++) taken.push(await refs.take('2026-11-05'));
    expect(taken).toEqual(Array.from({ length: 20 }, (_, i) => i + 8));
    expect(await refs.take('2026-11-06')).toBe(91);
    await refs.save();
    expect(db.state.get(D2C_STATE_KEY.REF_SERIAL)).toEqual({ byDate: { '2026-11-05': 27, '2026-11-06': 91 } });
    // PEPIMS is read once per day per transaction, under the app_state row lock
    expect(db.queries.filter((q) => q.includes('shipment_orders'))).toHaveLength(2);
    expect(db.queries.some((q) => q.includes('FOR UPDATE'))).toBe(true);
  });

  it('a second transaction continues from the stored counter (PEPIMS re-read each time)', async () => {
    const db = fakeDb();
    db.state.set(D2C_STATE_KEY.REF_SERIAL, { byDate: { '2026-11-05': 5 } });
    const refs = await RefSerials.open(db.m, settings, '2026-11-03');
    expect(await refs.take('2026-11-05')).toBe(6);
    await refs.save();
    const again = await RefSerials.open(db.m, settings, '2026-11-03');
    expect(await again.take('2026-11-05')).toBe(7);
    // a seeded row is locked straight away (an INSERT IGNORE on it would take a shared lock: deadlock risk)
    expect(db.queries.some((q) => q.startsWith('INSERT IGNORE'))).toBe(false);
  });

  it('after cutover + 30 days PEPIMS is not read', async () => {
    const db = fakeDb(['A|05Nov2026|99']);
    const refs = await RefSerials.open(db.m, { ...settings, cutoverDate: '2026-01-01' }, '2026-11-03');
    expect(await refs.take('2026-11-05')).toBe(1);
    expect(db.queries.some((q) => q.includes('shipment_orders'))).toBe(false);
  });

  it('PEPIMS not on this server (test DB) counts as 0; other errors fail the take', async () => {
    expect(await pepimsMaxSerial(fakeDb([], { pepimsMissing: true }).m, '2026-11-05')).toBe(0);
    const broken = { query: () => Promise.reject(Object.assign(new Error('lock wait'), { code: 'ER_LOCK_WAIT_TIMEOUT' })) } as unknown as EntityManager;
    await expect(pepimsMaxSerial(broken, '2026-11-05')).rejects.toThrow('lock wait');
  });

  it('transfer codes IT-<FY>-<MM>-<NNN> follow each other and restart per month', async () => {
    const db = fakeDb();
    expect(await takeTransferCodes(db.m, '2026-11-03', 3)).toEqual(['IT-2627-11-001', 'IT-2627-11-002', 'IT-2627-11-003']);
    expect(await takeTransferCodes(db.m, '2026-11-30', 1)).toEqual(['IT-2627-11-004']);
    expect(await takeTransferCodes(db.m, '2026-12-01', 1)).toEqual(['IT-2627-12-001']);
    expect(db.state.get(D2C_STATE_KEY.TRANSFER_CODE)).toEqual({ month: '2627-12', last: 1 });
  });

  it('the preview peeks without writing, with the location prefix and type tag', async () => {
    const db = fakeDb(['HYP_Nagpur|05Nov2026|Int3']);
    db.state.set(D2C_STATE_KEY.REF_SERIAL, { byDate: { '2026-11-05': 1 } });
    const refs = await peekReferences(
      [{ prefix: 'HYP_Nagpur', poDate: '2026-11-05', type: 'Internal' }, { prefix: 'Mcaff_Gurgaon3', poDate: '2026-11-05', type: 'Regular' }, { prefix: 'Okhla Hub-939', poDate: '2026-11-07', type: 'Freebee' }],
      settings, '2026-11-03', db.m,
    );
    expect(refs).toEqual(['HYP_Nagpur|05Nov2026|Int4', 'Mcaff_Gurgaon3|05Nov2026|5', 'Okhla Hub-939|07Nov2026|Freebee1']);
    expect(db.state.get(D2C_STATE_KEY.REF_SERIAL)).toEqual({ byDate: { '2026-11-05': 1 } });
  });
});
