import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { istToday } from '../input-store';
import { deleteDailyFile, fetchInput, forgetListings, resolveStored, restoreTemplate, s3Source, saveDailyFile, saveTemplate, templateVersions } from '../s3/inputs';
import {
  fyOf, importKey, inputKey, isoWeekOf, monthlyKey, newStamp, parseBuildKey, parseInputKey, stampTime, tombstoneKey, weeklyKey,
} from '../s3/layout';
import { periodStart } from '../s3/periods';
import { drainOnce, loadQueue, queuedItems } from '../s3/queue';
import { visibleScopes, writeScope } from '../s3/scope';
import { copy, head, put, useS3 } from '../s3/store';
import { S3Fake } from './s3-fake';

/*
 * The in-transit S3 store (user, 2026-10-26): key layout, saving with checks, the day's inputs from listings (newest
 * wins, deletes, a test machine's own copy, the 30-day cut), the queue while S3 is down. S3 is faked (s3-fake.ts); no
 * database needed (the day's final build / periods need one: checked by hand).
 */

const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const who = { id: 7, name: 'Tést User' };

let fake: S3Fake;
let root = '';
const saved = { dir: '', s3: false, test: false };

beforeEach(async () => {
  fake = new S3Fake();
  useS3(fake.client());
  forgetListings();
  Object.assign(saved, { dir: env.intransit.dir, s3: env.intransit.s3Enabled, test: env.intransit.test });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'intransit-s3-'));
  Object.assign(env.intransit, { dir: root, s3Enabled: true, test: false });
  Object.defineProperty(AppDataSource, 'isInitialized', { value: true, configurable: true, writable: true });
  await loadQueue();
});

afterEach(() => {
  useS3(null);
  Object.assign(env.intransit, { dir: saved.dir, s3Enabled: saved.s3, test: saved.test });
  Object.defineProperty(AppDataSource, 'isInitialized', { value: false, configurable: true, writable: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('layout', () => {
  it('puts a day in its FY (April-March) and month', () => {
    expect(fyOf('2026-04-01')).toBe('FY26-27');
    expect(fyOf('2027-03-31')).toBe('FY26-27');
    expect(fyOf('2026-03-31')).toBe('FY25-26');
    expect(inputKey('prod', 'FK_GRN.csv', '2026-10-26', 'S')).toBe('inventory/GRN_SOH/FY26-27/October/2026-10-26/FK_GRN.csv/S__FK_GRN.csv');
    expect(inputKey('test', 'PO_Format.csv', '2027-01-05', 'S')).toBe('inventory-test/Daily Inputs/FY26-27/January/2027-01-05/PO_Format.csv/S__PO_Format.csv');
  });

  it('gives a week to the FY of its Thursday and never repeats a name in an FY', () => {
    expect(isoWeekOf('2026-12-31')).toMatchObject({ week: 53, fy: 'FY26-27' });
    expect(isoWeekOf('2027-01-01').week).toBe(53); // same ISO week (Mon 28 Dec 2026 .. Sun 3 Jan 2027)
    // Wed 31 Mar 2027: its Thursday is 1 Apr 2027 -> the next FY
    expect(isoWeekOf('2027-03-31')).toMatchObject({ week: 13, fy: 'FY27-28' });
    expect(weeklyKey('prod', '2027-03-31').key).toBe('inventory/Weekly Snapshot/FY27-28/W13.xlsx');
    // FY27-28 also ends on ISO week 13 (of 2028): that one carries its year
    expect(weeklyKey('prod', '2028-03-30').label).toBe('W13_2028');
    expect(weeklyKey('prod', '2026-10-26').label).toBe('W44');
    expect(monthlyKey('prod', '2026-10-26').key).toBe('inventory/Monthly Snapshot/FY26-27/October.xlsx');
    expect(periodStart('weekly', 'FY27-28', 'W13')).toBe('2027-03-29');
    expect(periodStart('weekly', 'FY27-28', 'W13_2028')).toBe('2028-03-27');
    expect(periodStart('weekly', 'FY26-27', 'W01')).toBe('2027-01-04');
    expect(periodStart('monthly', 'FY26-27', 'January')).toBe('2027-01-01');
  });

  it('reads keys back', () => {
    const at = new Date('2026-10-26T04:51:03.123Z');
    const s = newStamp(at);
    expect(stampTime(s)?.toISOString()).toBe(at.toISOString());
    expect(parseInputKey(inputKey('prod', 'FK_SOH.csv', '2026-10-26', s), 'prod')).toMatchObject({ name: 'FK_SOH.csv', day: '2026-10-26', deleted: false });
    expect(parseInputKey(tombstoneKey('prod', 'FK_SOH.csv', '2026-10-26', s), 'prod')?.deleted).toBe(true);
    expect(parseBuildKey('inventory/Full Report/FY26-27/October/2026-10-26/10-21-03_run41/sheets/x.csv.gz')).toEqual({ day: '2026-10-26', folder: '10-21-03_run41', runId: '41' });
    expect(importKey('prod', 'Split1.csv', 3, 'my file/../x.csv', at)).toMatch(/^inventory\/Masters\/Imports\/Split1\/FY26-27\/October\/2026-10-26T04-51-03-123Z-[a-z0-9]{4}__u3__my file_.._x.csv$/);
  });
});

describe('store', () => {
  it('saves with metadata and checks it', async () => {
    const r = await put('inventory/x/a.csv', Buffer.from('a,b\n1,2\n'), { byId: who.id, byName: who.name, source: 'upload', problems: ['p1'] });
    expect(r.stored).toBe('s3');
    const h = await head('inventory/x/a.csv');
    expect(h?.meta).toMatchObject({ byId: 7, byName: 'Tést User', source: 'upload', problems: ['p1'] });
    expect(fake.objects.get('inventory/x/a.csv')?.meta['by-name']).toBe('T%C3%A9st%20User'); // ASCII in S3
  });

  it('never writes the live area from a test machine', async () => {
    env.intransit.test = true;
    expect(writeScope()).toBe('test');
    expect(visibleScopes()).toEqual(['test', 'prod']);
    await expect(put('inventory/x/a.csv', Buffer.from('x'), { source: 'upload' })).rejects.toThrow(/writes only/);
    await expect(put('inventory-test/x/a.csv', Buffer.from('x'), { source: 'upload' })).resolves.toMatchObject({ stored: 's3' });
  });

  it('copies with all metadata, across keys with spaces and brackets', async () => {
    await put('inventory/Full Report/d/Sheet35(2) + x.csv', Buffer.from('1'), { byId: 1, byName: 'A', source: 'build', runId: '5' });
    const h = await copy('inventory/Full Report/d/Sheet35(2) + x.csv', 'inventory/Weekly Snapshot/FY26-27/W44.xlsx', { source: 'period' });
    expect(h.meta).toMatchObject({ byId: 1, byName: 'A', source: 'period', runId: '5' });
    expect(fake.copySources[0]).toContain('Full%20Report');
    expect(fake.copySources[0]).toContain('Sheet35(2)%20%2B%20x.csv');
  });
});

describe('the day\'s inputs', () => {
  const day = daysAgo(1);

  it('uses the newest version of the latest day <= date; a delete falls back to the day before', async () => {
    await saveDailyFile('FK_GRN.csv', daysAgo(3), Buffer.from('Consignment Id,GRN Status,GRN Qty\nold,,1\n'), who, 'upload');
    await saveDailyFile('FK_GRN.csv', day, Buffer.from('Consignment Id,GRN Status,GRN Qty\nfirst,,1\n'), who, 'upload');
    await saveDailyFile('FK_GRN.csv', day, Buffer.from('Consignment Id,GRN Status,GRN Qty\nsecond,,1\n'), who, 'upload');
    let f = (await resolveStored(istToday())).files.find((x) => x.name === 'FK_GRN.csv');
    expect(f).toMatchObject({ from: 'earlier', date: day });
    const file = path.join(root, 'got.csv');
    await fetchInput(f?.key as string, file);
    expect(fs.readFileSync(file, 'utf8')).toContain('second');

    await deleteDailyFile('FK_GRN.csv', day, who);
    f = (await resolveStored(istToday())).files.find((x) => x.name === 'FK_GRN.csv');
    expect(f?.date).toBe(daysAgo(3));
    expect(await s3Source.dates()).toEqual([daysAgo(3)]);
  });

  it('skips the same content only within the same day', async () => {
    const body = Buffer.from('FSN,SKU,Title,Warehouse Id,Live on Website\n1,a,t,w,y\n');
    const a = await saveDailyFile('FK_SOH.csv', daysAgo(2), body, who, 'flipkart');
    const b = await saveDailyFile('FK_SOH.csv', daysAgo(2), body, who, 'flipkart');
    const c = await saveDailyFile('FK_SOH.csv', daysAgo(1), body, who, 'flipkart');
    expect([a.unchanged, b.unchanged, c.unchanged]).toEqual([false, true, false]);
    expect(b.key).toBe(a.key);
    expect(fake.keys('inventory/GRN_SOH/')).toHaveLength(2);
  });

  it('ignores versions older than 30 days', async () => {
    const old = daysAgo(31);
    await put(inputKey('prod', 'Myntra_GRN.csv', old, newStamp(new Date(Date.parse(`${old}T06:00:00Z`)))), Buffer.from('x'), { source: 'upload', day: old });
    expect((await resolveStored(istToday())).missing).toContain('Myntra_GRN.csv');
  });

  it('a test machine reads the live copy, and its own copy wins', async () => {
    await saveDailyFile('Myntra_SOH.csv', day, Buffer.from('live'), who, 'upload');
    env.intransit.test = true;
    forgetListings();
    expect((await resolveStored(day)).files.find((x) => x.name === 'Myntra_SOH.csv')?.key).toMatch(/^inventory\//);
    await saveDailyFile('Myntra_SOH.csv', day, Buffer.from('mine'), who, 'upload');
    expect((await resolveStored(day)).files.find((x) => x.name === 'Myntra_SOH.csv')?.key).toMatch(/^inventory-test\//);
  });

  it('keeps template versions and restores one as a new version', async () => {
    await saveTemplate(Buffer.from('v1'), who);
    await saveTemplate(Buffer.from('v2'), who);
    expect((await saveTemplate(Buffer.from('v2'), who)).unchanged).toBe(true);
    const versions = await templateVersions();
    expect(versions).toHaveLength(1);
    await restoreTemplate(versions[0].version, who);
    const t = (await resolveStored(day)).files.find((x) => x.name === 'Intransit_Stock_Report.xlsx');
    expect(fake.text(t?.key as string)).toBe('v1');
    expect(t?.meta?.source).toBe('restore');
  });
});

describe('queue', () => {
  it('holds saves while S3 is down, shows them, and sends them when it is back', async () => {
    fake.down = true;
    const r = await saveDailyFile('Amazon_SOH.csv', daysAgo(1), Buffer.from('queued body'), who, 'amazon');
    expect(r.stored).toBe('queued');
    expect(await queuedItems()).toHaveLength(1);
    fake.down = false;
    const f = (await resolveStored(istToday())).files.find((x) => x.name === 'Amazon_SOH.csv');
    expect(f).toMatchObject({ queued: true, date: daysAgo(1) });
    // the build reads it from the queue
    const file = path.join(root, 'q.csv');
    await fetchInput(f?.key as string, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('queued body');

    expect(await drainOnce()).toEqual({ sent: 1, left: 0 });
    expect(fake.text(r.key)).toBe('queued body');
    expect((await head(r.key))?.meta.source).toBe('amazon');
    expect(fs.readdirSync(path.join(root, 'spool'))).toHaveLength(0);
  });

  it('refuses new work past its limit', async () => {
    const limit = env.intransit.spoolMaxMb;
    env.intransit.spoolMaxMb = 0;
    fake.down = true;
    await expect(saveDailyFile('Amazon_SOH.csv', daysAgo(1), Buffer.from('x'), who, 'amazon')).rejects.toThrow(/unreachable/);
    env.intransit.spoolMaxMb = limit;
  });
});
