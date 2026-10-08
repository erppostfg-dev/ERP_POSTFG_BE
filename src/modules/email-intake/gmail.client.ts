import { gmail_v1, google } from 'googleapis';
import { env } from '../../config/env';
import { ERROR_CODES } from '../../constants';
import { appError } from '../../utils/AppError';

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
      throw appError(ERROR_CODES.GMAIL_SERVICE_ACCOUNT_KEY_MISSING);
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
    throw appError(ERROR_CODES.GMAIL_OAUTH_CONFIG_MISSING);
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
