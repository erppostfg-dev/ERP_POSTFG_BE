import { monitorEventLoopDelay } from 'perf_hooks';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { LOG_WARN_EVERY_MS } from '../constants/logging';
import { requestStats } from '../middlewares/request-log';
import { classifyError } from './classify-error';
import { runningNow } from './log-context';
import { logEvent } from './logger';
import { whereFailed } from './where';

/*
 * Health of the server process itself (2026-10-19), checked every MONITOR_SECONDS:
 *   PROCESS_EVENT_LOOP_LAG  the event loop was blocked > EVENT_LOOP_WARN_MS (long synchronous code: every request waited)
 *   PROCESS_MEMORY_HIGH     RSS > MEMORY_WARN_MB (big file / list in memory, or a leak if it keeps growing)
 *   DB_POOL_WAITING         requests waited for a free DB connection (too many queries at once / long transactions)
 *   PROCESS_HEARTBEAT       every MONITOR_HEARTBEAT_MINUTES: memory, CPU %, event loop, requests (count, errors, slow,
 *                           average / max ms), DB pool. In CloudWatch, a missing heartbeat = the server is down.
 * Each warning is written at most once a minute (LOG_WARN_EVERY_MS).
 * Crashes: an unhandled promise failure or uncaught error is logged with its reason, then the process exits with 1 so
 * pm2 restarts it clean (the same as Node's default, but now with a line in CloudWatch saying why).
 */

const MB = 1024 * 1024;
const lastWarn = new Map<string, number>();
const throttled = (key: string): boolean => {
  const now = Date.now();
  if (now - (lastWarn.get(key) ?? 0) < LOG_WARN_EVERY_MS) return true;
  lastWarn.set(key, now);
  return false;
};

/** mysql2 pool numbers (internal fields; undefined when the driver does not expose them). */
const poolStats = (): { size: number; free: number; waiting: number; limit?: number } | undefined => {
  try {
    const pool = (AppDataSource.isInitialized ? (AppDataSource.driver as unknown as { pool?: Record<string, unknown> }).pool : undefined) as
      | { _allConnections?: { length: number }; _freeConnections?: { length: number }; _connectionQueue?: { length: number }; config?: { connectionLimit?: number } }
      | undefined;
    if (!pool?._allConnections) return undefined;
    return {
      size: pool._allConnections.length,
      free: pool._freeConnections?.length ?? 0,
      waiting: pool._connectionQueue?.length ?? 0,
      limit: pool.config?.connectionLimit,
    };
  } catch {
    return undefined;
  }
};

export const startProcessMonitor = (): { stop: () => void } => {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let cpu = process.cpuUsage();
  let cpuAt = Date.now();
  let lastBeat = Date.now();
  let maxWaiting = 0;
  const everyMs = Math.max(1, env.log.monitorSeconds) * 1000;
  // A 100 ms ticker measures every stall in full (2026-10-27): right after a block the overdue check could run before
  // the histogram had recorded it, and the reset below then lost it (a 1.5 s block went unreported in a test). The
  // ticker is due earlier than the check, so after a block it runs first and the check sees the whole gap.
  const TICK_MS = 100;
  let lastTick = Date.now();
  let gapMax = 0;
  const ticker = setInterval(() => {
    const t = Date.now();
    gapMax = Math.max(gapMax, t - lastTick - TICK_MS);
    lastTick = t;
  }, TICK_MS);
  ticker.unref();

  const check = () => {
    try {
      const lagMax = Math.max(Math.round(loop.max / 1e6), gapMax);
      const lagP99 = Math.round(loop.percentile(99) / 1e6);
      const rssMb = Math.round(process.memoryUsage().rss / MB);
      const pool = poolStats();
      if (pool) maxWaiting = Math.max(maxWaiting, pool.waiting);

      if (env.log.eventLoopWarnMs > 0 && lagMax > env.log.eventLoopWarnMs && !throttled('loop')) {
        // running: what was going on (jobs with their step, requests), so the line says WHAT blocked (2026-10-27)
        const running = runningNow();
        logEvent('PROCESS_EVENT_LOOP_LAG', `server blocked up to ${lagMax} ms${running.length ? ` while running: ${running.join(' | ')}` : ' (no job or request open: start-up or a timer)'}`, {
          maxMs: lagMax, p99Ms: lagP99, limitMs: env.log.eventLoopWarnMs, activeRequests: requestStats.active, running,
        });
      }
      if (env.log.memoryWarnMb > 0 && rssMb > env.log.memoryWarnMb && !throttled('memory')) {
        const m = process.memoryUsage();
        logEvent('PROCESS_MEMORY_HIGH', `memory ${rssMb} MB`, { running: runningNow(), rssMb, heapUsedMb: Math.round(m.heapUsed / MB), heapTotalMb: Math.round(m.heapTotal / MB), limitMb: env.log.memoryWarnMb });
      }
      if (pool && pool.waiting > 0 && !throttled('pool')) {
        logEvent('DB_POOL_WAITING', `${pool.waiting} request(s) waiting for a DB connection`, { ...pool, activeRequests: requestStats.active, running: runningNow() });
      }

      if (env.log.heartbeatMinutes > 0 && Date.now() - lastBeat >= env.log.heartbeatMinutes * 60_000) {
        const now = Date.now();
        const used = process.cpuUsage(cpu);
        const cpuPct = Math.round(((used.user + used.system) / 1000 / (now - cpuAt)) * 100);
        const m = process.memoryUsage();
        const s = requestStats;
        logEvent('PROCESS_HEARTBEAT', 'alive', {
          uptimeMin: Math.round(process.uptime() / 60),
          rssMb, heapUsedMb: Math.round(m.heapUsed / MB), cpuPct,
          loopP99Ms: lagP99, loopMaxMs: lagMax,
          requests: s.count, errors5xx: s.errors5xx, errors4xx: s.errors4xx, slow: s.slow,
          avgMs: s.count ? Math.round(s.totalMs / s.count) : 0, maxMs: s.maxMs, activeRequests: s.active, running: runningNow(),
          ...(pool ? { dbPool: { ...pool, maxWaiting } } : {}),
        });
        Object.assign(s, { count: 0, errors5xx: 0, errors4xx: 0, slow: 0, totalMs: 0, maxMs: 0 });
        cpu = process.cpuUsage();
        cpuAt = now;
        lastBeat = now;
        maxWaiting = 0;
      }
      loop.reset();
      gapMax = 0;
    } catch {
      // a health check must never take the server down
    }
  };
  const timer = setInterval(check, everyMs);
  timer.unref();
  return { stop: () => { clearInterval(timer); clearInterval(ticker); loop.disable(); } };
};

/** Logs crashes with their reason, then exits 1 (pm2 restarts the process). Call once at start. */
export const logCrashes = (): void => {
  process.on('unhandledRejection', (reason) => {
    const f = classifyError('process', reason);
    logEvent('PROCESS_UNHANDLED_REJECTION', 'unhandled promise failure: exiting for a clean restart', {
      errorCode: f.errorCode, error: f.error, failedAt: whereFailed(reason), running: runningNow(), stack: reason instanceof Error ? reason.stack : undefined,
    });
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    const f = classifyError('process', err);
    logEvent('PROCESS_UNCAUGHT_EXCEPTION', 'uncaught error: exiting for a clean restart', { errorCode: f.errorCode, error: f.error, failedAt: whereFailed(err), running: runningNow(), stack: err.stack });
    process.exit(1);
  });
};
