import { gmail_v1, google } from 'googleapis';
import { env } from '../../config/env';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// Lets the same login pull from the Pub/Sub subscription.
export const PUBSUB_SCOPES = ['https://www.googleapis.com/auth/pubsub'];

type AuthClient = InstanceType<typeof google.auth.OAuth2> | InstanceType<typeof google.auth.JWT>;

let authClient: AuthClient | undefined;
let gmail: gmail_v1.Gmail | undefined;

/** Google login for the intake mailbox (env.gmail.mailbox). */
export const getAuthClient = (): AuthClient => {
  if (authClient) return authClient;

  const cfg = env.gmail;

  if (cfg.authMode === 'service_account') {
    if (!cfg.serviceAccountKeyFile) {
      throw new Error('GMAIL_SERVICE_ACCOUNT_KEY_FILE is required when GMAIL_AUTH_MODE=service_account');
    }
    // Domain-wide delegation: the service account acts as the mailbox user.
    authClient = new google.auth.JWT({
      keyFile: cfg.serviceAccountKeyFile,
      scopes: [...GMAIL_SCOPES, ...PUBSUB_SCOPES],
      subject: cfg.mailbox,
    });
    return authClient;
  }

  if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRefreshToken) {
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN are required when GMAIL_AUTH_MODE=oauth',
    );
  }
  const oauth = new google.auth.OAuth2(cfg.oauthClientId, cfg.oauthClientSecret);
  oauth.setCredentials({ refresh_token: cfg.oauthRefreshToken });
  authClient = oauth;
  return authClient;
};

/** Gmail API client for the intake mailbox. */
export const getGmail = (): gmail_v1.Gmail => {
  if (!gmail) gmail = google.gmail({ version: 'v1', auth: getAuthClient() });
  return gmail;
};
