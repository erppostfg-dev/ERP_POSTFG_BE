import { INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS, MAIL_LIST } from '../../constants';
import { facilityCheckMail } from '../intransit/facility-check-mail';
import { getFacilityCheck } from '../intransit/facility-check.service';
import { listRuns } from '../intransit/runs.service';
import type { WhSummaryRow } from '../intransit/stages/wh-summary';
import { runMailWithFiles } from '../intransit/wh-summary-mail';
import type { Mail } from './mailer.service';
import { mailListOf } from './mail-lists.service';

/*
 * What a test of each mail holds (Users & Roles -> Email -> Send test, 2026-10-30): the real content where it exists
 * (the in-transit WH table of the latest build), else an example. Kept apart from mail-lists.service so the mail lists
 * never depend on the modules whose mails they send.
 */

type Content = Omit<Mail, 'to' | 'cc' | 'bcc'>;

const note = (subject: string, lines: string[]): Content => ({
  subject,
  text: lines.join('\n'),
  html: `<!doctype html><html><body style="font-family:Calibri,Arial,sans-serif;font-size:14px;">${lines.map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')}</body></html>`,
});

/** The latest succeeded in-transit build that has the WH table, as its mail. */
const intransitDaily = async (): Promise<Content> => {
  const builds = await listRuns(INTRANSIT_RUN_KIND.REPORT, 30);
  for (const b of builds) {
    const rows = ((b.result ?? {}) as { whSummary?: WhSummaryRow[] }).whSummary;
    // the real mail of that build, with its Stock / B2C workbooks attached
    if (b.status === INTRANSIT_RUN_STATUS.SUCCEEDED && rows?.length) return runMailWithFiles(b.id);
  }
  return note('In-transit stock', ['No in-transit build has the warehouse table yet: build a report, then send the test again.']);
};

const fetchFailure = async (): Promise<Content> => note('In-transit fetch failed: Myntra Partner Portal (example)', [
  'This is an example of the fetch-failure mail.',
  'Myntra Partner Portal fetch #000 failed: the Myntra login form did not open (Myntra\'s bot check may be blocking the server).',
  'What to do: refresh the Myntra login on the laptop and copy it to the server, or upload Myntra_SOH.csv / Myntra_GRN.csv by hand on Daily run.',
]);

/** The last facility check as its mail; an example when there has been none. */
const facilityChanges = async (): Promise<Content> => {
  const s = await getFacilityCheck();
  if (s.checkedAt) return facilityCheckMail(s);
  return facilityCheckMail({
    checkedAt: new Date().toISOString(),
    newFacilities: [{ code: 'mCaff_Example3', name: 'Example facility', inMaster: false, guess: 'D2C' }],
    disabled: [{ code: 'HYP_OLDEXAMPLE', name: null, group: 'D2C', exported: true }],
  });
};

const SAMPLES: Record<string, () => Promise<Content>> = {
  [MAIL_LIST.INTRANSIT_DAILY]: intransitDaily,
  [MAIL_LIST.INTRANSIT_FETCH_FAILURE]: fetchFailure,
  [MAIL_LIST.INTRANSIT_FACILITY_CHANGES]: facilityChanges,
};

/** The test content of mail `key` (404 for an unknown mail). */
export const sampleMail = (key: string): Promise<Content> => {
  const def = mailListOf(key);
  return (SAMPLES[key] ?? (async () => note(def.name, [`This is a test of "${def.name}".`, def.description])))();
};
