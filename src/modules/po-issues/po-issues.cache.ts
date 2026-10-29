/*
 * The shared PO issues result (2026-10-29, user: "used by so many people ... do the optimization; nobody downloads stale
 * data"). The screen's answer for a window of days is computed once and shared by everyone for PO_ISSUES.CACHE_SECONDS;
 * people opening the tab at the same moment wait for that ONE computation. forgetPoIssues() drops it at once when what it
 * shows changes (a master add / edit / switch, a re-check, a review decision); new POs show within CACHE_SECONDS.
 * Downloads never use it (`fresh`). Its own module, no imports: the services that change the data call forgetPoIssues()
 * without depending on the PO issues service.
 */

interface Entry<T> { at: number; value: Promise<T> }
const results = new Map<number, Entry<unknown>>();

export const cachedPoIssues = <T>(days: number, maxAgeMs: number, compute: () => Promise<T>): { value: Promise<T>; at: number; cached: boolean } => {
  const now = Date.now();
  const hit = results.get(days) as Entry<T> | undefined;
  if (hit && now - hit.at < maxAgeMs) return { value: hit.value, at: hit.at, cached: true };
  const value = compute();
  results.set(days, { at: now, value });
  // a failed computation is not kept: the next person tries again
  value.catch(() => { if (results.get(days)?.value === value) results.delete(days); });
  return { value, at: now, cached: false };
};

/** The data behind the PO issues changed: the next screen load computes it again. */
export const forgetPoIssues = (): void => results.clear();
