/*
 * Clean-up when a job's worker is stopped (Stop on the page, user 2026-11-02): runs.service sends the worker SIGTERM,
 * and what a job started outside itself - a robot's browser, Xvfb - is closed here before the worker exits, so nothing
 * is left running on the server. A job registers its clean-up with onWorkerStop and drops it when done.
 */

const hooks = new Set<() => unknown>();
/** The longest the clean-up may take before the worker exits anyway. */
const CLEANUP_MS = 5000;

/** Run `fn` if the worker is stopped; returns the function that unregisters it. */
export const onWorkerStop = (fn: () => unknown): (() => void) => {
  hooks.add(fn);
  return () => void hooks.delete(fn);
};

/** Every registered clean-up (each at most CLEANUP_MS together; errors ignored). */
export const runStopHooks = async (): Promise<void> => {
  const all = [...hooks].map((fn) => Promise.resolve().then(fn).catch(() => undefined));
  hooks.clear();
  await Promise.race([Promise.all(all), new Promise((resolve) => setTimeout(resolve, CLEANUP_MS))]);
};
