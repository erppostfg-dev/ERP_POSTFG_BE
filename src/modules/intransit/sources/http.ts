/*
 * The HTTP calls the connectors make (port of their httpx clients): JSON in and out, a retry with back-off on 429,
 * and errors that keep the API's own explanation (a bare 403 says nothing).
 */

export type Log = (msg: string) => void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Call {
  method?: string;
  headers?: Record<string, string>;
  /** Query parameters (undefined values are left out). */
  query?: Record<string, string | number | undefined>;
  /** A JSON body. */
  json?: unknown;
  /** A form body (application/x-www-form-urlencoded). */
  form?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRIES_ON_429 = 7;
const MAX_BACKOFF_S = 60;

export const withQuery = (url: string, query?: Call['query']): string => {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
};

/** One request; never throws on an HTTP status (only on a network error or timeout). */
export const send = (url: string, call: Call = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...call.headers };
  let body: string | undefined;
  if (call.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(call.json);
  } else if (call.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(call.form).toString();
  }
  return fetch(withQuery(url, call.query), {
    method: call.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
};

/** HttpError with the status and the start of the body. */
export const failed = async (res: Response, what: string): Promise<HttpError> =>
  new HttpError(res.status, `${res.status} from ${what}: ${(await res.text().catch(() => '')).slice(0, 500)}`);

/**
 * A request retried on 429 (1, 2, 4 ... 60 s apart, 7 tries); any other error status throws with the API's text.
 * `call` is a function so the headers (the access token) are fresh on every try.
 */
/** Requests answered 429 (throttled) since the process started, and the seconds spent waiting them out. */
export const throttled = { count: 0, waitedS: 0 };

export const sendRetry = async (url: string, call: () => Promise<Call> | Call, what: string): Promise<Response> => {
  let res: Response | undefined;
  for (let attempt = 0; attempt < RETRIES_ON_429; attempt++) {
    res = await send(url, await call());
    if (res.status !== 429) {
      if (!res.ok) throw await failed(res, what);
      return res;
    }
    const wait = Math.min(2 ** attempt, MAX_BACKOFF_S);
    throttled.count++;
    throttled.waitedS += wait;
    await sleep(wait * 1000);
  }
  throw await failed(res as Response, what);
};

/** The response body as bytes. */
export const bytesOf = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());
