/*
 * End-to-end test on ONE email, from the command line (no server): Gmail label Po-Intake -> store + sort -> S3 ->
 * po_uploads -> OCR -> processed.json -> validation + po_issues -> PO tables + sale order + Uniware CSV.
 * Uses the same functions as the server. Touches exactly one email; Gmail is only read.
 *
 *   npm run po:one -- --pick                   only SHOW which email would be taken (newest PO email not stored yet)
 *   npm run po:one                             run the whole chain on that email
 *   npm run po:one -- --gmail-id <id>          run it on this Gmail message
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import fs from 'fs/promises';
import { ERROR_CODES, FILES, PROVIDERS } from '../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoIssue, PoUpload } from '../entities';
import { sortStoredEmail } from '../modules/email-intake/email-sorter.service';
import { storedFolderOf, storeInboundEmail } from '../modules/email-intake/email-storage.service';
import { getGmail } from '../modules/email-intake/gmail.client';
import { downloadAttachments, originalSender, readParts, toHeaderMap } from '../modules/email-intake/gmail-message';
import { resolveRoutes } from '../modules/email-intake/gmail-watch.service';
import { syncEmailToS3 } from '../modules/email-intake/s3-mirror.service';
import { detectChannel } from '../modules/ocr/channel-detector';
import { extractPo } from '../modules/ocr/extract-po.service';
import { emailStored } from '../modules/po-pipeline/pipeline.service';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const step = (n: number, msg: string): void => console.log(`\n=== step ${n}: ${msg}`);
const ALL_FILES = /./;
const SCAN = 30;

const main = async (): Promise<void> => {
  const routes = await resolveRoutes();
  const route = routes[0];
  if (!route) throw appError(ERROR_CODES.CLI_USAGE, 'No label route configured');
  const gmail = getGmail();

  // 1. Which email: the one given, or the newest PO email (known channel sender) not stored yet.
  step(1, `pick one email from Gmail label ${route.label} (read only)`);
  let gmailId = arg('gmail-id');
  if (!gmailId) {
    const list = await gmail.users.messages.list({ userId: 'me', labelIds: [route.labelId], maxResults: SCAN });
    for (const m of list.data.messages ?? []) {
      const meta = await gmail.users.messages.get({ userId: 'me', id: m.id as string, format: 'metadata' }); // all headers: the real sender may be in X-Original-Sender / Reply-To (Google Group)
      const h = toHeaderMap(meta.data.payload?.headers ?? []);
      const messageId = h['message-id'] ?? `gmail-${m.id}`;
      const isPo = 'config' in detectChannel({ from: originalSender(h), subject: h['subject'] });
      const stored = await storedFolderOf(route.label, messageId);
      console.log(`  ${m.id}  ${isPo ? 'PO ' : 'not PO'}  ${stored ? 'stored already' : 'NEW'}  "${h['subject'] ?? ''}"`);
      if (isPo && !stored) {
        gmailId = m.id as string;
        break;
      }
    }
  }
  if (!gmailId) {
    console.log(`No new PO email in the newest ${SCAN} of ${route.label}. Give one with --gmail-id <id>.`);
    return;
  }
  console.log(`  -> taking Gmail message ${gmailId}`);
  if (process.argv.includes('--pick')) return;

  // 2. Download and store it, as the intake endpoint does; sort it; copy to S3.
  step(2, 'download, store locally, sort, upload to S3');
  const full = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
  const headers = toHeaderMap(full.data.payload?.headers ?? []);
  const { attachments, body } = readParts(full.data.payload);
  const files = await downloadAttachments(gmail, gmailId, attachments, ALL_FILES);
  const from = originalSender(headers);
  const stored = await storeInboundEmail({
    group: route.label,
    messageId: headers['message-id'] ?? `gmail-${gmailId}`,
    provider: PROVIDERS.GMAIL_PUBSUB,
    gmailId,
    labels: [route.label],
    from: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from) ? from : undefined,
    subject: headers['subject'] ?? '',
    receivedAt: full.data.internalDate ? new Date(Number(full.data.internalDate)).toISOString() : undefined,
    bodyText: body.text,
    bodyHtml: body.html,
    files: files.map((f) => ({ filename: f.filename, content: f.content })),
  });
  console.log(`  ${stored.duplicate ? 'already stored' : 'stored'}: ${stored.folder} (${files.length} attachment(s))`);
  const sort = stored.duplicate ? undefined : await sortStoredEmail(stored.folder);
  const folder = sort?.folder ?? stored.folder;
  if (sort && !sort.isPo) {
    console.log(`  not a PO (${sort.reason}); stopping here.`);
    return;
  }
  console.log(`  channel: ${sort?.isPo ? sort.channel : '-'}`);
  const s3 = await syncEmailToS3(folder);
  console.log(`  S3: ${s3.uploaded} file(s) -> ${s3.s3Folder}/`);

  // 3. Database: the email's po_uploads row; then OCR, after which the chain runs (process, validate, record, save).
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  try {
    step(3, 'po_uploads row for the email');
    await emailStored(folder);
    step(4, 'OCR, then processed.json -> validation -> po_issues / PO tables -> sale order -> Uniware CSV');
    const ocr = await extractPo(folder);
    console.log(`  OCR ${ocr.status}${ocr.reason ? `: ${ocr.reason}` : ''} (${ocr.durationMs ?? 0} ms)`);

    // 5. What was written, for cross-checking.
    step(5, 'result');
    const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as { messageId?: string; s3Folder?: string };
    const rows = await AppDataSource.getRepository(PoUpload).findBy({ emailMessageId: meta.messageId ?? '' });
    console.log(`  local folder: ${folder}`);
    console.log(`  S3 folder:    ${meta.s3Folder ?? '-'}`);
    for (const r of rows) {
      console.log(`  po_uploads ${r.id}: PO ${r.poNumber ?? '-'} | ${r.channel} | status ${r.status} | ocr ${r.ocrStatus} | attempts ${r.ocrAttempts}`);
      const issues = await AppDataSource.getRepository(PoIssue).findBy({ uploadId: r.id });
      for (const i of issues) console.log(`     issue ${i.id} [${i.issueType}] ${i.fieldName} ${i.lineNo ?? ''}: ${i.details}`);
      if (r.poUid) {
        const m = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid: r.poUid });
        const d = await AppDataSource.getRepository(DetailsPurchaseOrder).findBy({ shipmentOrderId: r.poUid });
        console.log(`     master_purchase_orders ${m?.uid}: ${m?.poNumber} ${m?.channel} ${m?.location} units ${m?.totalUnits} brand ${m?.brandName}`);
        console.log(`     details_purchase_orders: ${d.length} lines, qty ${d.reduce((s, x) => s + (x.qty ?? 0), 0)}, PO value ${d.reduce((s, x) => s + Number(x.poValue ?? 0), 0).toFixed(2)}`);
      }
      if (r.uniwareCsvUrl) console.log(`     Uniware CSV: ${r.uniwareCsvUrl}`);
      if (r.errorDetails) console.log(`     error_details: ${JSON.stringify(r.errorDetails)}`);
    }
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
