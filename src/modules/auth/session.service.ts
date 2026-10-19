import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { jwtVerify, SignJWT } from 'jose';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { AUTH, DEVICE_TYPE, ERROR_CODES, SESSION_EVENT, USER_STATUS } from '../../constants';
import { Session, SessionHistory, User, UserRole } from '../../entities';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logCall } from '../../utils/log-call';

/*
 * Google sign-in and sessions, the same flow as prefg (NextAuth + Google there, plain Express here):
 *   GET /auth/google            -> redirect to Google (state in a short-lived cookie)
 *   GET /auth/google/callback   -> code -> Google ID token checked -> users row checked -> sessions row
 *                                  + session_history "login" -> signed session cookie -> redirect
 * Two improvements over prefg: every request checks the sessions row and the user's status (logout and switching a
 * user off apply at once), and roles are read from the database on every request.
 */

/** Fails early with the missing .env keys. */
const config = () => {
  const { googleClientId, googleClientSecret, secret } = env.auth;
  const missing = [!googleClientId && 'GOOGLE_CLIENT_ID', !googleClientSecret && 'GOOGLE_CLIENT_SECRET', !secret && 'AUTH_SECRET'].filter(Boolean);
  if (missing.length) throw appError(ERROR_CODES.AUTH_NOT_CONFIGURED, missing.join(', '));
  return { clientId: googleClientId as string, clientSecret: googleClientSecret as string, key: new TextEncoder().encode(secret as string) };
};

const oauthClient = (): OAuth2Client => {
  const c = config();
  return new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: env.auth.callbackUrl });
};

export const newState = (): string => crypto.randomBytes(24).toString('base64url');

/** Google's sign-in URL for this app; `state` comes back unchanged and must match the cookie. */
export const googleSignInUrl = (state: string): string =>
  oauthClient().generateAuthUrl({ scope: [...AUTH.GOOGLE_SCOPES], state, prompt: 'select_account', hd: env.auth.allowedEmailDomain });

export interface GoogleProfile {
  email: string;
  name: string;
  googleId: string;
}

/** The code Google sent back -> its ID token, verified (signature, our client id, expiry) -> the person's profile. */
export const profileFromCode = async (code: string): Promise<GoogleProfile> => {
  const client = oauthClient();
  try {
    const { tokens } = await logCall(LOG_SOURCE.GOOGLE_LOGIN, 'getToken', () => client.getToken(code));
    const ticket = await logCall(LOG_SOURCE.GOOGLE_LOGIN, 'verifyIdToken', () => client.verifyIdToken({ idToken: tokens.id_token ?? '', audience: config().clientId }));
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified || !p.sub) throw new Error('no verified email');
    return { email: p.email.toLowerCase(), name: p.name ?? p.email, googleId: p.sub };
  } catch {
    throw appError(ERROR_CODES.GOOGLE_TOKEN_INVALID);
  }
};

/** Our rules after Google: company domain, a users row, not inactive (NULL counts as active, as in prefg). */
export const allowedUser = async (profile: GoogleProfile): Promise<User> => {
  const domain = env.auth.allowedEmailDomain;
  if (!profile.email.endsWith(`@${domain}`)) throw appError(ERROR_CODES.NOT_ALLOWED_DOMAIN, domain);
  const user = await AppDataSource.getRepository(User).findOneBy({ email: profile.email });
  if (!user) throw appError(ERROR_CODES.USER_NOT_FOUND, profile.email);
  if (user.status === USER_STATUS.INACTIVE) throw appError(ERROR_CODES.USER_INACTIVE, profile.email);
  return user;
};

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** Creates the session: sessions + session_history rows, then the signed token for the cookie. */
export const startSession = async (user: User, profile: GoogleProfile, client: ClientInfo): Promise<{ token: string; expiresAt: Date }> => {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.auth.sessionDays * 24 * 60 * 60 * 1000);
  await AppDataSource.transaction(async (m) => {
    if (!user.googleId) await m.getRepository(User).update({ id: user.id }, { googleId: profile.googleId });
    await m.getRepository(Session).insert({
      sessionId,
      userId: user.id,
      token: AUTH.SESSION_ISSUER,
      ipAddress: client.ip,
      userAgent: client.userAgent,
      deviceType: DEVICE_TYPE.WEB,
      expiresAt,
      isActive: true,
    });
    await m.getRepository(SessionHistory).insert({ sessionId, userId: user.id, event: SESSION_EVENT.LOGIN, ipAddress: client.ip, userAgent: client.userAgent });
  });
  const token = await new SignJWT({ sid: sessionId, uid: user.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(AUTH.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(config().key);
  return { token, expiresAt };
};

export interface AuthContext {
  user: User;
  roles: string[];
  sessionId: string;
}

/**
 * The person behind a session cookie, or UNAUTHENTICATED: the token must be ours and unexpired, its sessions row
 * active and unexpired, and the user still allowed. Roles are read fresh.
 */
export const authFromToken = async (token: string | undefined): Promise<AuthContext> => {
  if (!token) throw appError(ERROR_CODES.UNAUTHENTICATED);
  let sid: string;
  try {
    const { payload } = await jwtVerify(token, config().key, { issuer: AUTH.JWT_ISSUER });
    sid = String(payload.sid);
  } catch {
    throw appError(ERROR_CODES.UNAUTHENTICATED);
  }
  const session = await AppDataSource.getRepository(Session).findOneBy({ sessionId: sid });
  if (!session || session.isActive === false || session.expiresAt.getTime() < Date.now()) throw appError(ERROR_CODES.UNAUTHENTICATED);
  const user = await AppDataSource.getRepository(User).findOneBy({ id: session.userId });
  if (!user || user.status === USER_STATUS.INACTIVE) throw appError(ERROR_CODES.UNAUTHENTICATED);
  const roles = (await AppDataSource.getRepository(UserRole).findBy({ userId: user.id })).map((r) => r.role);
  return { user, roles, sessionId: sid };
};

/** Logout: the session row is switched off and a "logout" history row written. */
export const endSession = async (auth: AuthContext, client: ClientInfo): Promise<void> => {
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(Session).update({ sessionId: auth.sessionId }, { isActive: false });
    await m.getRepository(SessionHistory).insert({ sessionId: auth.sessionId, userId: auth.user.id, event: SESSION_EVENT.LOGOUT, ipAddress: client.ip, userAgent: client.userAgent });
  });
};
