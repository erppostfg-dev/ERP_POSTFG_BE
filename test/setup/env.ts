import http from 'http';
import https from 'https';
import './load-env-now';
import { installFakeS3 } from '../helpers/fake-s3';

/*
 * Runs before every test file (vitest setupFiles, 2026-10-28):
 *   - the test settings (load-env.ts) and the in-memory S3 (helpers/fake-s3.ts);
 *   - the NETWORK GUARD: any HTTP(S) call or fetch to a host other than this machine throws, so a test can never
 *     reach Gmail, S3, SQS, Amazon, Uniware, Google login or a PO link, even if a fake was forgotten. Tests replace
 *     those services with fakes (test/helpers/fakes.ts).
 */
// S3 = an in-memory bucket for every test (test/helpers/fake-s3.ts)
installFakeS3();

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const hostOf = (target: unknown): string => {
  if (typeof target === 'string') return new URL(target).hostname;
  if (target instanceof URL) return target.hostname;
  const o = (target ?? {}) as { hostname?: string; host?: string };
  return String(o.hostname ?? o.host ?? 'localhost').replace(/:\d+$/, '');
};
const blocked = (host: string) => new Error(`NETWORK BLOCKED in tests: ${host} (use a fake from test/helpers/fakes.ts)`);

for (const mod of [http, https] as const) {
  const request = mod.request.bind(mod);
  const get = mod.get.bind(mod);
  (mod as { request: unknown }).request = (target: unknown, ...rest: unknown[]) => {
    const host = hostOf(target);
    if (!LOCAL.has(host)) throw blocked(host);
    return (request as (...a: unknown[]) => http.ClientRequest)(target, ...rest);
  };
  (mod as { get: unknown }).get = (target: unknown, ...rest: unknown[]) => {
    const host = hostOf(target);
    if (!LOCAL.has(host)) throw blocked(host);
    return (get as (...a: unknown[]) => http.ClientRequest)(target, ...rest);
  };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (!LOCAL.has(host)) throw blocked(host);
  return realFetch(input, init);
});
