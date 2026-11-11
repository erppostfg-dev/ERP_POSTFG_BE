import { env } from '../../config/env';
import { PO_UNIWARE_SYNC } from '../../constants';

/*
 * Our own Uniware client for the channel PO sync (2026-11-06, user: "use the same code in my application, not in
 * Ajay's code"): the sync no longer imports the D2C / in-transit modules. Same contract as theirs:
 *   - OAuth password grant on <tenant>/oauth/token (the same UNIWARE_* keys of .env); one login shared by parallel
 *     calls (several logins of one user at once fail in Uniware, seen 2026-10-25), renewed a minute before it expires;
 *   - JSON POST with Facility; a 429 is retried 1, 2, 4 ... 60 s apart (RETRIES_ON_429 tries), then thrown;
 *   - Uniware answers its own errors in a 200 (successful: false): thrown as "<path> refused: <errors JSON>".
 * The username / password travel in the login query (Uniware's documented way): that URL is never logged.
 */

export class UniwareHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UniwareHttpError';
  }
}

/** What the sync needs from a client (a fake in tests). */
export interface UniwarePoster {
  post<T extends Record<string, unknown>>(apiPath: string, payload: unknown, facility?: string): Promise<T>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** https://<tenant>.unicommerce.com from the bare tenant name or an address copied from the browser. */
const tenantBase = (tenant: string): string => {
  let host = tenant.trim();
  if (host.includes('://')) host = host.split('://', 2)[1];
  host = host.split('/', 1)[0];
  return host.includes('.') ? `https://${host}` : `https://${host}.unicommerce.com`;
};

const failed = async (res: Response, what: string): Promise<UniwareHttpError> =>
  new UniwareHttpError(res.status, `${res.status} from ${what}: ${(await res.text().catch(() => '')).slice(0, 500)}`);

class Client implements UniwarePoster {
  private readonly base: string;
  private token: string | null = null;
  private expires = 0;
  private loggingIn: Promise<string> | null = null;

  constructor(private readonly cfg: { tenant: string; username: string; password: string }) {
    this.base = tenantBase(cfg.tenant);
  }

  private login(): Promise<string> {
    if (this.token && Date.now() < this.expires - 60_000) return Promise.resolve(this.token);
    this.loggingIn ??= this.freshLogin().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async freshLogin(): Promise<string> {
    const u = new URL(`${this.base}/oauth/token`);
    for (const [k, v] of Object.entries({ grant_type: 'password', client_id: 'my-trusted-client', username: this.cfg.username, password: this.cfg.password })) {
      u.searchParams.set(k, v);
    }
    const res = await fetch(u, { signal: AbortSignal.timeout(PO_UNIWARE_SYNC.HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new UniwareHttpError(res.status, `Uniware login failed, ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    this.expires = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async post<T extends Record<string, unknown>>(apiPath: string, payload: unknown, facility?: string): Promise<T> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < PO_UNIWARE_SYNC.RETRIES_ON_429; attempt++) {
      res = await fetch(`${this.base}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `bearer ${await this.login()}`, ...(facility ? { Facility: facility } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PO_UNIWARE_SYNC.HTTP_TIMEOUT_MS),
      });
      if (res.status !== 429) break;
      await sleep(Math.min(2 ** attempt, 60) * 1000);
    }
    if (!res!.ok) throw await failed(res!, apiPath);
    const body = (await res!.json()) as T & { successful?: boolean; errors?: unknown; message?: string };
    if (body.successful === false) throw new Error(`${apiPath} refused: ${JSON.stringify(body.errors ?? body.message)}`);
    return body;
  }
}

let shared: UniwarePoster | null = null;

/** The process-wide client of the sync. Throws when the UNIWARE_* keys are missing. */
export const poUniwareClient = (): UniwarePoster => {
  if (shared) return shared;
  const { tenant, username, password } = env.intransit.uniware;
  if (!tenant || !username || !password) throw new Error('Uniware is not set up here (UNIWARE_TENANT / UNIWARE_USERNAME / UNIWARE_PASSWORD)');
  shared = new Client({ tenant, username, password });
  return shared;
};

/** Tests swap the client. */
export const setPoUniwareClient = (api: UniwarePoster | null): void => {
  shared = api;
};

/** Uniware said 429 even after the retries: the run stops (the rest next time). */
export const isThrottled = (err: unknown): boolean => err instanceof UniwareHttpError && err.status === 429;

/** The messages of a refusal (successful: false), or null for any other error (HTTP, network, timeout). */
export const refusalMessages = (err: unknown): string[] | null => {
  if (!(err instanceof Error) || err instanceof UniwareHttpError) return null;
  const marker = ' refused: ';
  const i = err.message.indexOf(marker);
  if (i < 0) return null;
  const raw = err.message.slice(i + marker.length);
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!Array.isArray(list)) return [typeof list === 'string' ? list : JSON.stringify(list)];
  return (list as Record<string, unknown>[]).map((e) => [e?.message, e?.description].filter((x) => typeof x === 'string' && x).join(': '));
};
