import { describe, expect, it } from 'vitest';
import type { WhSummaryRow } from '../stages/wh-summary';
import { whSummaryMail, whTotal } from '../wh-summary-mail';

const rows: WhSummaryRow[] = [
  { wh: 'MWH - Delhivery GGN', gmv: 1000.4, units: 10, cogs: 300, cogsSplit: 0.75 },
  { wh: 'D2C WH - SR & DL', gmv: 500, units: 5, cogs: 100, cogsSplit: 0.25 },
];

describe('WH summary mail: total line (user 2026-11-03)', () => {
  it('sums every column', () => {
    expect(whTotal(rows)).toEqual({ wh: 'Total', gmv: 1500.4, units: 15, cogs: 400, cogsSplit: 1 });
  });

  it('ends the HTML table and the text with the total', () => {
    const mail = whSummaryMail(rows, '2026-11-03', '42');
    const lastRow = mail.html.slice(mail.html.lastIndexOf('<tr>'));
    expect(lastRow).toContain('>Total</td>');
    expect(lastRow).toContain('>1,500</td>');
    expect(lastRow).toContain('>100.0%</td>');
    const lastLine = mail.text.split('\n').at(-1)!;
    expect(lastLine.startsWith('Total')).toBe(true);
    expect(lastLine).toMatch(/1,500\s+15\s+400\s+100\.0%$/);
  });
});
