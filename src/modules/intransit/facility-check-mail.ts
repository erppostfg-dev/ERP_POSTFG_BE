import type { FacilityCheckState } from './facility-check.service';

/*
 * The mail of a facility check (list "In-transit facility changes", user 2026-10-30): the new and the disabled
 * facilities it found, and where to act on them. Pure, so Users & Roles -> Email -> Send test can show it too.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const P = 'font-family:Calibri,Arial,sans-serif;font-size:14px;';
const CELL = `border:1px solid #000;padding:4px 10px;${P}`;

const table = (head: string[], rows: string[][]): string =>
  `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><thead><tr>${head.map((h) => `<th style="${CELL}background:#c6efce;text-align:left;font-weight:normal;">${h}</th>`).join('')}</tr></thead>`
  + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="${CELL}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

export const facilityCheckMail = (s: Pick<FacilityCheckState, 'checkedAt' | 'newFacilities' | 'disabled'>): { subject: string; html: string; text: string } => {
  const when = s.checkedAt ? new Date(s.checkedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
  const parts: string[] = [`<p style="${P}">Uniware facility check of ${esc(when)}.</p>`];
  const text: string[] = [`Uniware facility check of ${when}.`, ''];
  if (s.newFacilities.length) {
    parts.push(`<p style="${P}"><b>${s.newFacilities.length} facilit${s.newFacilities.length === 1 ? 'y is' : 'ies are'} enabled in Uniware but not in the in-transit report</b> (not exported, stock not counted):</p>`,
      table(['Facility', 'Name in Uniware', 'Suggested bucket'], s.newFacilities.map((f) => [f.code, f.name ?? '', f.guess ?? '-'])));
    text.push(`Enabled in Uniware, not in the report (${s.newFacilities.length}):`, ...s.newFacilities.map((f) => `  ${f.code}${f.name ? ` (${f.name})` : ''}${f.guess ? ` - suggested ${f.guess}` : ''}`), '');
  }
  if (s.disabled.length) {
    parts.push(`<p style="${P}"><b>${s.disabled.length} facilit${s.disabled.length === 1 ? 'y is' : 'ies are'} no longer enabled in Uniware</b> but still exported / counted:</p>`,
      table(['Facility', 'Bucket', 'Exported'], s.disabled.map((f) => [f.code, f.group ?? '-', f.exported ? 'Yes' : 'No'])));
    text.push(`No longer enabled in Uniware (${s.disabled.length}):`, ...s.disabled.map((f) => `  ${f.code}${f.group ? ` (${f.group})` : ''}`), '');
  }
  if (!s.newFacilities.length && !s.disabled.length) {
    parts.push(`<p style="${P}">Every enabled Uniware facility is in the report; nothing to do.</p>`);
    text.push('Every enabled Uniware facility is in the report; nothing to do.');
  } else {
    parts.push(`<p style="${P}">Add or stop them on In-transit Stock (the banner at the top) or Masters &gt; Warehouses.</p>`);
    text.push('Add or stop them on In-transit Stock (the banner at the top) or Masters > Warehouses.');
  }
  const n = s.newFacilities.length + s.disabled.length;
  return {
    subject: n ? `In-transit: ${n} Uniware facility change${n === 1 ? '' : 's'} to review` : 'In-transit: Uniware facilities up to date',
    html: `<!doctype html><html><body style="margin:0;padding:16px;">${parts.join('')}</body></html>`,
    text: text.join('\n'),
  };
};
