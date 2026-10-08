/*
 * One-time helper: sign in as the intake mailbox and print a Gmail refresh token.
 *
 *   1. Put GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env (OAuth client of type "Desktop app").
 *   2. npm run gmail:token
 *   3. Sign in as GMAIL_MAILBOX in the browser and allow read access.
 *   4. Copy the printed GMAIL_OAUTH_REFRESH_TOKEN into .env.
 */
import { exec } from 'child_process';
import http from 'http';
import { AddressInfo } from 'net';
import { google } from 'googleapis';
import { env } from '../config/env';
import { ERROR_CODES } from '../constants';
import { appError } from '../utils/AppError';
import { GMAIL_SCOPES, PUBSUB_SCOPES } from '../modules/email-intake/gmail.client';

// Gmail read + Pub/Sub pull, so one refresh token serves the whole email listener.
const SCOPES = [...GMAIL_SCOPES, ...PUBSUB_SCOPES];

const openBrowser = (url: string): void => {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined); // if it fails, the URL is printed anyway
};

const main = async (): Promise<void> => {
  const { oauthClientId, oauthClientSecret, mailbox } = env.gmail;
  if (!oauthClientId || !oauthClientSecret) {
    throw appError(ERROR_CODES.GMAIL_OAUTH_CLIENT_MISSING);
  }

  // Desktop-app clients accept any loopback port, so let the OS pick a free one.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const oauth = new google.auth.OAuth2(oauthClientId, oauthClientSecret, redirectUri);
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    scope: SCOPES,
    login_hint: mailbox,
  });

  console.log(`\nSign in as ${mailbox} and allow access. If the browser does not open, visit:\n\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      const error = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');
      if (!error && !authCode) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(error ? `Sign-in failed: ${error}. You can close this tab.` : 'Done. You can close this tab.');
      server.close();
      if (error) reject(new Error(`Google returned: ${error}`));
      else resolve(authCode as string);
    });
  });

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw appError(ERROR_CODES.GMAIL_NO_REFRESH_TOKEN);
  }

  // Check which mailbox the token belongs to.
  oauth.setCredentials(tokens);
  const profile = await google.gmail({ version: 'v1', auth: oauth }).users.getProfile({ userId: 'me' });
  const signedInAs = profile.data.emailAddress ?? 'unknown';

  console.log(`Signed in as: ${signedInAs}`);
  if (signedInAs.toLowerCase() !== mailbox.toLowerCase()) {
    console.warn(`WARNING: expected ${mailbox}. Run again and sign in with the right account.`);
  }
  console.log('\nAdd this to .env:\n');
  console.log('GMAIL_AUTH_MODE=oauth');
  console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
