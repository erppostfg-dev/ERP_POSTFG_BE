import { describe, expect, it } from 'vitest';
import { checkDue, compareFacilities, guessBucket } from '../facility-check.service';
import { facilityCheckMail } from '../facility-check-mail';

const row = (code: string, o: Partial<{ group: string | null; exported: boolean; active: boolean; aliases: string[] }> = {}) => ({
  id: 1, code, name: null, aliases: o.aliases ?? null, intransit_group: o.group ?? null, uniware_export: o.exported ? 1 : 0, is_active: o.active === false ? 0 : 1,
});
const uni = (code: string) => ({ code, name: `${code} name` });

describe('guessBucket', () => {
  it('reads the bucket off Uniware codes', () => {
    expect(guessBucket('DS_NCR_PD_NEWHUB')).toBe('DarkStore');
    expect(guessBucket('Return_KOL')).toBe('Return');
    expect(guessBucket('KOL_WAREHOUSE')).toBe('KOLMWH');
    expect(guessBucket('GGN_WAREHOUSE2')).toBe('GGNMWH');
    expect(guessBucket('HYP_B2B_MUM3')).toBe('MUMMWH');
    expect(guessBucket('mCaff_Kolkata3')).toBe('D2C');
    expect(guessBucket('HYP_BYHYD')).toBe('D2C');
    expect(guessBucket('SOMETHING_ELSE')).toBeNull();
  });
});

describe('compareFacilities', () => {
  it('new = enabled in Uniware but neither exported nor counted here; ignored ones left out', () => {
    const { newFacilities } = compareFacilities(
      [uni('mCaff_Mumbai2'), uni('mCaff_Kolkata3'), uni('HYP_NEW'), uni('B2B_JUNK'), uni('mum_warehouse2')],
      [row('mCaff_Mumbai2', { group: 'D2C', exported: true }), row('mCaff_Kolkata3'), row('MUM_WAREHOUSE2', { exported: true })],
      ['b2b_junk'],
    );
    expect(newFacilities.map((f) => [f.code, f.inMaster, f.guess])).toEqual([['HYP_NEW', false, null], ['mCaff_Kolkata3', true, 'D2C']]);
  });

  it('disabled = exported or counted here but not enabled in Uniware (aliases count; inactive rows do not)', () => {
    const { disabled } = compareFacilities(
      [uni('HYP_SRGGN'), uni('MUM_Warehouse2')],
      [
        row('HYP_SRGGN', { group: 'D2C', exported: true }),
        row('MUM_WAREHOUSE2', { exported: true, aliases: ['MUM_Warehouse2'] }),
        row('HYP_GONE', { group: 'D2C' }),
        row('OLD_ONE', { exported: true, active: false }),
      ],
      [],
    );
    expect(disabled).toEqual([{ code: 'HYP_GONE', name: null, group: 'D2C', exported: false }]);
  });
});

describe('checkDue', () => {
  // 2026-11-02 is a Monday
  const at = (ist: string): number => Date.parse(`${ist}+05:30`);
  const iso = (ist: string): string => new Date(at(ist)).toISOString();
  it('never checked -> due', () => expect(checkDue({ checkedAt: null, attemptedAt: null, error: null })).toBe(true));
  it('Monday from 09:00 IST, once that day', () => {
    const last = { checkedAt: iso('2026-10-30T10:00:00'), attemptedAt: iso('2026-10-30T10:00:00'), error: null };
    expect(checkDue(last, at('2026-11-02T08:59:00'))).toBe(false);
    expect(checkDue(last, at('2026-11-02T09:00:00'))).toBe(true);
    const done = { ...last, checkedAt: iso('2026-11-02T09:05:00') };
    expect(checkDue(done, at('2026-11-02T15:00:00'))).toBe(false);
    expect(checkDue(done, at('2026-11-05T15:00:00'))).toBe(false);
  });
  it('a week after the last check even when Monday was missed; 6 h after a failure', () => {
    expect(checkDue({ checkedAt: iso('2026-10-26T09:00:00'), attemptedAt: iso('2026-10-26T09:00:00'), error: null }, at('2026-11-03T10:00:00'))).toBe(true);
    const failed = { checkedAt: iso('2026-10-26T09:00:00'), attemptedAt: iso('2026-11-02T09:00:00'), error: 'Uniware down' };
    expect(checkDue(failed, at('2026-11-02T14:00:00'))).toBe(false);
    expect(checkDue(failed, at('2026-11-02T15:00:00'))).toBe(true);
  });
});

describe('facilityCheckMail', () => {
  it('lists both kinds; says so when there is nothing to do', () => {
    const m = facilityCheckMail({
      checkedAt: '2026-11-02T03:30:00.000Z',
      newFacilities: [{ code: 'HYP_NEW', name: 'New <one>', inMaster: false, guess: 'D2C' }],
      disabled: [{ code: 'HYP_GONE', name: null, group: 'D2C', exported: true }],
    });
    expect(m.subject).toBe('In-transit: 2 Uniware facility changes to review');
    expect(m.html).toContain('New &lt;one&gt;');
    expect(m.text).toContain('HYP_GONE (D2C)');
    expect(facilityCheckMail({ checkedAt: null, newFacilities: [], disabled: [] }).text).toContain('nothing to do');
  });
});
