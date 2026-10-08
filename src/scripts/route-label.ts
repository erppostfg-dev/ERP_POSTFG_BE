/*
 * Backfill / test the label routing without Pub/Sub: sends the emails already in a label to
 * that label's endpoint, the same way the Pub/Sub listener does. Emails already stored are
 * skipped by the endpoint (same Message-ID). The server must be running.
 *
 *   npm run email:route -- --label Po-Intake            (every email in the label)
 *   npm run email:route -- --label Po-Intake --max 5    (newest 5 only)
 */
import { ERROR_CODES } from '../constants';
import { appError } from '../utils/AppError';
import { getGmail } from '../modules/email-intake/gmail.client';
import { resolveRoutes } from '../modules/email-intake/gmail-watch.service';
import { forwardMessage } from '../modules/email-intake/label-router.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const routes = await resolveRoutes();
  const label = arg('label') ?? routes[0]?.label;
  const route = routes.find((r) => r.label.toLowerCase() === label?.toLowerCase());
  if (!route) throw appError(ERROR_CODES.CLI_LABEL_ROUTE_NOT_FOUND, String(label), routes.map((r) => r.label).join(', '));

  const max = arg('max') ? Number(arg('max')) : Infinity;
  const gmail = getGmail();

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [route.labelId],
      maxResults: Math.min(100, max - ids.length),
      pageToken,
    });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);

  console.log(`[${route.label}] ${ids.length} email(s) -> ${route.endpoint}`);
  for (const id of ids) await forwardMessage(gmail, id, [route]);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
