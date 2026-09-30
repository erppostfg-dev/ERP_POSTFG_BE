import { gmail_v1, google } from 'googleapis';
import { env } from '../../config/env';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

let client: gmail_v1.Gmail | undefined;

/** Gmail API client for the intake mailbox (env.gmail.mailbox). */
export const getGmail = (): gmail_v1.Gmail => {
  if (client) return client;

  const cfg = env.gmail;

  if (cfg.authMode === 'service_account') {
    if (!cfg.serviceAccountKeyFile) {
      throw new Error('GMAIL_SERVICE_ACCOUNT_KEY_FILE is required when GMAIL_AUTH_MODE=service_account');
    }
    // Domain-wide delegation: the service account acts as the mailbox user.
    const auth = new google.auth.JWT({
      keyFile: cfg.serviceAccountKeyFile,
      scopes: SCOPES,
      subject: cfg.mailbox,
    });
    client = google.gmail({ version: 'v1', auth });
    return client;
  }

  if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRefreshToken) {
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN are required when GMAIL_AUTH_MODE=oauth',
    );
  }
  const auth = new google.auth.OAuth2(cfg.oauthClientId, cfg.oauthClientSecret);
  auth.setCredentials({ refresh_token: cfg.oauthRefreshToken });
  client = google.gmail({ version: 'v1', auth });
  return client;
};
