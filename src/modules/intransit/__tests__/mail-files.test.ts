import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAIL_FILES } from '../../../constants';
import { mailFileName } from '../mail-files';
import { reportBucket } from '../stages/final-sku';
import { xlsxBytes } from '../xlsx-lite';

describe('mailFileName', () => {
  it('names the attachments as the planning team does', () => {
    expect(mailFileName(MAIL_FILES.STOCK, '2026-10-01')).toBe("Stock-01Oct'26.xlsx");
    expect(mailFileName(MAIL_FILES.B2C, '2026-10-16')).toBe('B2C-Format-Data-Planning-16Oct.xlsx');
  });
});

describe('reportBucket', () => {
  it('returns go to their city warehouse; DarkStore folds into D2C; KOL has its own', () => {
    expect(reportBucket('Return', 'mumbai')).toBe('MUMMWH+ReturnMUM');
    expect(reportBucket('Return', 'gurgaon')).toBe('GGNMWH+ReturnGGN');
    expect(reportBucket('KOLMWH', 'kol_warehouse')).toBe('KOLMWH+ReturnKOL');
    expect(reportBucket('DarkStore', 'gurgaon')).toBe('D2C+DarkStore');
    expect(reportBucket('B2C', 'pnq3')).toBe('B2C');
    expect(reportBucket('', 'x')).toBe('(blank)');
  });
});

describe('xlsxBytes', () => {
  it('a workbook Excel can open: one part per sheet, header row, numbers as numbers, text escaped', () => {
    const files = unzipSync(xlsxBytes([
      { name: 'Stock', title: 'Stock as of 2026-10-30', columns: [{ header: 'SKU Code' }, { header: 'Total', kind: 'int' }], rows: [['A&B <1>', 1234], ['C', null]] },
      { name: 'Sheet35(2)', columns: [{ header: 'x' }], rows: [] },
    ]));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    const wb = strFromU8(files['xl/workbook.xml']);
    expect(wb).toContain('<sheet name="Stock" sheetId="1" r:id="rId1"/>');
    expect(wb).toContain('<sheet name="Sheet35(2)" sheetId="2" r:id="rId2"/>');
    const s1 = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(s1).toContain('<row r="3"><c r="A3" s="1" t="inlineStr"><is><t xml:space="preserve">SKU Code</t></is></c>');
    expect(s1).toContain('A&amp;B &lt;1&gt;');
    expect(s1).toContain('<c r="B4" s="2"><v>1234</v></c>');
    expect(s1).toContain('<row r="5"><c r="A5" s="0" t="inlineStr"><is><t xml:space="preserve">C</t></is></c></row>');
  });
});
