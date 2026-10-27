import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import { INTRANSIT_FOLDERS } from '../../../constants';
import {
  dailyDir, deletedRoot, deleteDaily, masterHistoryDir, masterPath, masterVersions, readMeta, restoreMaster, storeInput, writeWithMeta,
} from '../input-store';

/*
 * Local safety of the in-transit store (Drive storage plan, phase 1, 2026-10-22): nothing the page or a connector
 * replaces or deletes is lost, and the same content again changes nothing.
 */

const DAILY = 'FK_GRN.csv';
const MASTER = 'Split1.csv';
const DAY = '2026-10-20';
const who = { by: 1, byName: 'Test', source: 'upload' as const };
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ls = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

let root = '';
let saved = '';

beforeEach(() => {
  saved = env.intransit.dir;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'intransit-store-'));
  env.intransit.dir = root;
});

afterEach(() => {
  env.intransit.dir = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('daily files', () => {
  it('keeps every replaced copy with its own content and meta', async () => {
    const file = path.join(dailyDir(DAY), DAILY);
    await writeWithMeta(file, bytes('v1'), who);
    await new Promise((r) => setTimeout(r, 5)); // distinct stamps
    await writeWithMeta(file, bytes('v2'), who);
    await new Promise((r) => setTimeout(r, 5));
    await writeWithMeta(file, bytes('v3'), who);

    expect(fs.readFileSync(file, 'utf8')).toBe('v3');
    const replacedDir = path.join(dailyDir(DAY), INTRANSIT_FOLDERS.REPLACED);
    const kept = ls(replacedDir).filter((f) => !f.endsWith('.meta.json'));
    expect(kept).toHaveLength(2);
    expect(kept.map((f) => fs.readFileSync(path.join(replacedDir, f), 'utf8'))).toEqual(['v1', 'v2']);
    const metas = await Promise.all(kept.map((f) => readMeta(path.join(replacedDir, f))));
    expect(metas.map((m) => m?.sha256)).toEqual([sha('v1'), sha('v2')]);
    expect((await readMeta(file))?.sha256).toBe(sha('v3'));
  });

  it('changes nothing when the same content comes again', async () => {
    const file = path.join(dailyDir(DAY), DAILY);
    const first = await storeInput(DAILY, bytes('same'), DAY, who);
    const again = await storeInput(DAILY, bytes('same'), DAY, who);
    expect(first.unchanged).toBe(false);
    expect(again.unchanged).toBe(true);
    expect(again.meta.at).toBe(first.meta.at);
    expect(ls(path.join(dailyDir(DAY), INTRANSIT_FOLDERS.REPLACED))).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('same');
  });

  it('moves a deleted file and its meta under _deleted/', async () => {
    const file = path.join(dailyDir(DAY), DAILY);
    await storeInput(DAILY, bytes('gone?'), DAY, who);
    await deleteDaily(DAILY, DAY);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.meta.json`)).toBe(false);
    const dir = path.join(deletedRoot(), INTRANSIT_FOLDERS.INPUTS, INTRANSIT_FOLDERS.DAILY, DAY);
    const kept = ls(dir);
    expect(kept.filter((f) => f.endsWith(`__${DAILY}`))).toHaveLength(1);
    expect(kept.filter((f) => f.endsWith(`__${DAILY}.meta.json`))).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept.find((f) => f.endsWith(`__${DAILY}`)) as string), 'utf8')).toBe('gone?');
  });
});

describe('masters', () => {
  it('archives the current master once per change, never for the same content', async () => {
    await storeInput(MASTER, bytes('a'), DAY, who);
    await storeInput(MASTER, bytes('a'), DAY, who);
    expect(await masterVersions(MASTER)).toHaveLength(0);
    await storeInput(MASTER, bytes('b'), DAY, who);
    const versions = await masterVersions(MASTER);
    expect(versions).toHaveLength(1);
    const kept = path.join(masterHistoryDir(MASTER), `${versions[0].version}__${MASTER}`);
    expect(fs.readFileSync(kept, 'utf8')).toBe('a');
    expect((await readMeta(kept))?.sha256).toBe(sha('a'));
    expect(fs.readFileSync(masterPath(MASTER), 'utf8')).toBe('b');
  });

  it('restores an old version as a new version, and not at all when it is already current', async () => {
    await storeInput(MASTER, bytes('a'), DAY, who);
    await storeInput(MASTER, bytes('b'), DAY, who);
    const [va] = await masterVersions(MASTER);
    const restored = await restoreMaster(MASTER, va.version, { by: 2, byName: 'Restorer' });
    expect(restored.unchanged).toBe(false);
    expect(restored.meta.source).toBe('restore');
    expect(fs.readFileSync(masterPath(MASTER), 'utf8')).toBe('a');
    const versions = await masterVersions(MASTER);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version)).toContain(va.version); // version ids unchanged
    const again = await restoreMaster(MASTER, va.version, { by: 2, byName: 'Restorer' });
    expect(again.unchanged).toBe(true);
    expect(await masterVersions(MASTER)).toHaveLength(2);
  });

  it('serialises concurrent changes, so no version is lost', async () => {
    await Promise.all([storeInput(MASTER, bytes('first'), DAY, who), storeInput(MASTER, bytes('second'), DAY, who)]);
    const versions = await masterVersions(MASTER);
    expect(versions).toHaveLength(1);
    const kept = fs.readFileSync(path.join(masterHistoryDir(MASTER), `${versions[0].version}__${MASTER}`), 'utf8');
    expect([kept, fs.readFileSync(masterPath(MASTER), 'utf8')].sort()).toEqual(['first', 'second']);
  });
});
