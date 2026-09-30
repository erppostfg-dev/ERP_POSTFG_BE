/*
 * Pull one PO email, by its exact subject, and save it to storage.
 *
 *   npm run email:pull -- --channel zepto --subject "Purchase Order for [PEP TECHNOLOGIES PRIVATE LIMITED and P5691383]"
 */
import { channelFilters } from '../modules/email-intake/channel-filters';
import { pullEmails } from '../modules/email-intake/email-pull.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const channel = (arg('channel') ?? 'zepto').toLowerCase();
  const filter = channelFilters[channel];
  if (!filter) {
    throw new Error(`Unknown channel "${channel}". Available: ${Object.keys(channelFilters).join(', ')}`);
  }

  const subject = arg('subject')?.trim();
  if (!subject) {
    throw new Error('Give the email subject: npm run email:pull -- --channel zepto --subject "<exact subject>"');
  }

  const results = await pullEmails(filter, { subject });
  if (!results.length) console.log(`No email found with subject "${subject}".`);

  for (const r of results) {
    console.log(
      [
        `- ${r.status.toUpperCase()}`,
        r.poNumber ? `PO ${r.poNumber}` : '',
        `"${r.subject}"`,
        r.reason ? `(${r.reason})` : '',
        r.files?.length ? `files: ${r.files.join(', ')}` : '',
        r.folder ? `→ ${r.folder}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
  }
  const saved = results.filter((r) => r.status === 'saved').length;
  console.log(`Done: ${saved} saved, ${results.length - saved} other.`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
