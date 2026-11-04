import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tabNames, writeInputsBook } from '../inputs-book';

/* The input files workbook of a build (user, 2026-11-02): one dated tab per daily input, every cell text. */

describe('tabNames', () => {
  it('file name without Export- / .csv, then the day; within 31 characters; all different', () => {
    const names = tabNames([
      { name: 'Purchase_Order.csv', day: '2026-11-02' },
      { name: 'Export-B2B Sale Orders.csv', day: '2026-11-01' },
      { name: 'Export-Inventory Snapshot.csv', day: '2026-11-02' },
      { name: 'A very long input file name that goes on and on.csv', day: '2026-11-02' },
      { name: 'A very long input file name that goes on and on too.csv', day: '2026-11-02' },
    ]);
    expect(names.slice(0, 3)).toEqual(['Purchase_Order 02Nov', 'B2B Sale Orders 01Nov', 'Inventory Snapshot 02Nov']);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(names[4]).toMatch(/ \(2\)$/);
  });

  it('drops the characters Excel refuses and edge apostrophes', () => {
    const [n] = tabNames([{ name: "'FK:GRN/[x]*?.csv", day: '2026-01-05' }]);
    expect(n).not.toMatch(/[[\]:*?/\\]/);
    expect(n.startsWith("'")).toBe(false);
    expect(n.endsWith('05Jan')).toBe(true);
  });
});

describe('writeInputsBook', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inputs-book-'));
    await fs.writeFile(path.join(dir, 'Amazon_SOH.csv'), 'FNSKU,Title,Qty\r\nX00012345678901,"Lotion, ""big""\nnew line",5\r\nX2,Bodywash,7\r\nX3,Scrub,9\r\n');
    // cp1252 (not UTF-8): the é must survive
    await fs.writeFile(path.join(dir, 'FK_GRN.csv'), Buffer.from([...Buffer.from('Name\r\nCaf'), 0xe9, ...Buffer.from('\r\n')]));
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it('one tab per file (missing ones left out), text cells, long files continue in a second tab', async () => {
    const out = path.join(dir, 'Inputs.xlsx');
    const lines: string[] = [];
    const r = await writeInputsBook(dir, [
      { name: 'Amazon_SOH.csv', day: '2026-11-02' },
      { name: 'Purchase_Order.csv', day: '2026-11-02' },
      { name: 'FK_GRN.csv', day: '2026-10-31' },
    ], out, (l) => lines.push(l), 3); // 3 rows per tab: header + 2
    expect(r.tabs.map((t) => [t.tab, t.rows])).toEqual([['Amazon_SOH 02Nov', 2], ['Amazon_SOH 02Nov (2)', 1], ['FK_GRN 31Oct', 1]]);
    expect(lines.some((l) => l.includes('Purchase_Order.csv not in'))).toBe(true);

    const files = unzipSync(new Uint8Array(await fs.readFile(out)));
    const wb = strFromU8(files['xl/workbook.xml']);
    expect(wb).toContain('<sheet name="Amazon_SOH 02Nov" sheetId="1" r:id="rId1"/>');
    expect(wb).toContain('<sheet name="Amazon_SOH 02Nov (2)" sheetId="2" r:id="rId2"/>');
    const s1 = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(s1).toContain('<t xml:space="preserve">X00012345678901</t>'); // a long code stays text
    expect(s1).toContain('Lotion, &quot;big&quot;\nnew line');
    const s2 = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(s2).toContain('<t xml:space="preserve">FNSKU</t>'); // the header again
    expect(s2).toContain('X3');
    expect(strFromU8(files['xl/worksheets/sheet3.xml'])).toContain('Café');
  });
});
