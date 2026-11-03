import { ERROR_CODES, INTRANSIT_RUN_STATUS, MAIL_FILE_NAMES } from '../../constants';
import { appError } from '../../utils/AppError';
import type { MailAttachment } from '../mail/mailer.service';
import { runFileBlob } from './file-preview.service';
import { mailFileName } from './mail-files';
import { getRun } from './runs.service';
import type { WhSummaryRow } from './stages/wh-summary';

/*
 * The in-transit mail (user, 2026-10-29: "we will set up mailing later"): the WH table of a build, as the email will
 * carry it - an HTML table styled inline (mail clients drop <style>), and a plain-text copy. The mailer only has to
 * send whSummaryMail(...); GET /intransit/runs/:id/mail shows the same HTML in the browser meanwhile.
 */

const HEADER_BG = '#c6efce';
const BORDER = '1px solid #000';
const CELL = `border:${BORDER};padding:4px 10px;font-family:Calibri,Arial,sans-serif;font-size:14px;`;

const inr = (n: number): string => Math.round(n).toLocaleString('en-IN');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface WhSummaryMail {
  subject: string;
  html: string;
  text: string;
}

export const whSummaryMail = (rows: WhSummaryRow[], asOf: string, runId: string): WhSummaryMail => {
  const head = ['WHs', 'GMV', 'Units', 'COGS (With Tax)', 'COGS Split'];
  const th = head.map((h) => `<th style="${CELL}background:${HEADER_BG};text-align:left;font-weight:normal;">${h}</th>`).join('');
  const body = rows.map((r) => `<tr>${[
    `<td style="${CELL}text-align:left;">${esc(r.wh)}</td>`,
    `<td style="${CELL}text-align:right;">${inr(r.gmv)}</td>`,
    `<td style="${CELL}text-align:right;">${inr(r.units)}</td>`,
    `<td style="${CELL}text-align:right;">${inr(r.cogs)}</td>`,
    `<td style="${CELL}text-align:right;">${pct(r.cogsSplit)}</td>`,
  ].join('')}</tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;padding:16px;">`
    + `<p style="font-family:Calibri,Arial,sans-serif;font-size:14px;">In-transit stock as of ${esc(asOf)} (stock on hand + in transit; report #${esc(runId)}):</p>`
    + `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
    + `</body></html>`;
  const width = Math.max(...rows.map((r) => r.wh.length), 3);
  const text = [
    `In-transit stock as of ${asOf} (report #${runId})`,
    '',
    `${'WHs'.padEnd(width)}  ${'GMV'.padStart(16)}  ${'Units'.padStart(12)}  ${'COGS (With Tax)'.padStart(16)}  COGS Split`,
    ...rows.map((r) => `${r.wh.padEnd(width)}  ${inr(r.gmv).padStart(16)}  ${inr(r.units).padStart(12)}  ${inr(r.cogs).padStart(16)}  ${pct(r.cogsSplit).padStart(10)}`),
  ].join('\n');
  return { subject: `In-transit stock - ${asOf}`, html, text };
};

/** The mail of report run `id` (409 when it has not succeeded; 404 when it was built before the WH table existed). */
export const runMail = async (id: string): Promise<WhSummaryMail> => {
  const run = await getRun(id);
  if (run.status !== INTRANSIT_RUN_STATUS.SUCCEEDED) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_DONE, id, run.status);
  const rows = ((run.result ?? {}) as { whSummary?: WhSummaryRow[] }).whSummary;
  if (!rows?.length) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, `WH summary of run ${id} (built before 29-Oct: build again)`);
  return whSummaryMail(rows, run.asOf ?? '', id);
};

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The workbooks build `id` wrote for its mail (Stock / B2C format), dated; a build from before 30-Oct has none. */
export const runMailAttachments = async (id: string, asOf: string): Promise<MailAttachment[]> => {
  const out: MailAttachment[] = [];
  for (const name of MAIL_FILE_NAMES) {
    const blob = await runFileBlob(id, name).catch(() => null);
    if (blob) out.push({ filename: mailFileName(name, asOf), contentType: XLSX_TYPE, content: await blob.read() });
  }
  return out;
};

/** The mail of build `id` as it goes out: the WH table, and the two workbooks attached (named in the text). */
export const runMailWithFiles = async (id: string): Promise<WhSummaryMail & { attachments: MailAttachment[] }> => {
  const mail = await runMail(id);
  const asOf = (await getRun(id)).asOf ?? '';
  const attachments = await runMailAttachments(id, asOf);
  if (!attachments.length) return { ...mail, attachments };
  const names = attachments.map((a) => a.filename).join(', ');
  return {
    ...mail,
    html: mail.html.replace('</body>', `<p style="font-family:Calibri,Arial,sans-serif;font-size:14px;">Attached: ${esc(names)}.</p></body>`),
    text: `${mail.text}\n\nAttached: ${names}.`,
    attachments,
  };
};
