import { AppDataSource } from '../../config/data-source';
import { CHANNEL_API } from '../../constants';
import { recordRunFailure, runConnector } from './runner';
import { CONNECTORS, TRACKERS } from './registry';
import type { ChannelConnector } from './connector';
import { pollMinutesOf } from './poll-schedule';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';

/*
 * Runs every configured channel API connector on its own timer inside the server (CHANNEL_API_ENABLED=true;
 * 2026-10-16). Fully automatic and self-healing:
 *   - the next run starts poll-minutes after the last one ENDED (runs never overlap);
 *   - a run that fails as a whole waits longer each time (2x, 4x ... up to MAX_BACKOFF_MS), then goes back to normal;
 *   - the check point lives in the DB, so a restart or a long stop catches up from where it was.
 */

const timers = new Map<string, NodeJS.Timeout>();
/** Each started connector's run, by channel: runNow() starts it at once instead of waiting for its timer. */
const loops = new Map<string, () => Promise<void>>();
const running = new Set<string>();
const again = new Set<string>();
/** When each connector's last run ended (the schedule counts from it). */
const ended = new Map<string, number>();
let stopped = false;

/**
 * PO intake (2026-10-23): a channel switched on / its start moved earlier -> one run now (the one-time catch-up).
 * A run already going: another run right after it. Not started (CHANNEL_API_ENABLED off / no keys): nothing.
 */
export const runChannelNow = (channel: string): void => {
  for (const c of CONNECTORS.filter((x) => x.channel === channel)) {
    const loop = loops.get(c.key);
    if (!loop) continue;
    if (running.has(c.key)) { again.add(c.key); continue; }
    clearTimeout(timers.get(c.key));
    void loop();
  }
};

/**
 * The page changed a connector's schedule: its waiting run is timed again from its last run's end (due now = at once).
 * A run going on now picks the new schedule up when it ends.
 */
export const rescheduleConnector = async (c: ChannelConnector): Promise<void> => {
  const loop = loops.get(c.key);
  if (!loop || running.has(c.key) || stopped) return;
  const wait = Math.max(0, (ended.get(c.key) ?? Date.now()) + (await pollMinutesOf(c)) * 60_000 - Date.now());
  clearTimeout(timers.get(c.key));
  timers.set(c.key, setTimeout(() => void loop(), wait));
};

/** A connector's run in progress (its timer's or a Process now). */
export const isProcessing = (key: string): boolean => running.has(key);

/**
 * Process now (Channel Pulls, 2026-10-30): the connector's run at once. Started by the server (CHANNEL_API_ENABLED): its
 * timer's run now (or right after the one going); not started (laptop, or polling off): one run here, never two at once.
 * Returns at once; the run goes on in the background (its result: channel_api_sync, shown on the page).
 */
export const processNow = (c: ChannelConnector): 'started' | 'queued' => {
  const loop = loops.get(c.key);
  if (loop) {
    if (running.has(c.key)) { again.add(c.key); return 'queued'; }
    clearTimeout(timers.get(c.key));
    void loop();
    return 'started';
  }
  if (running.has(c.key)) return 'queued';
  running.add(c.key);
  void runJob(`channel-api-${c.key}`, () => runConnector(c, { apply: true, saveCheckpoint: true }))
    .catch(async (err) => {
      await recordRunFailure(c, err).catch(() => undefined);
      logError(LOG_SOURCE.AMAZON, `[channel-api] ${c.key}: process now failed`, err);
    })
    .finally(() => running.delete(c.key));
  return 'started';
};

export const startChannelApis = (): { stop: () => void } => {
  for (const c of CONNECTORS) {
    if (!c.configured()) {
      log.info(LOG_SOURCE.AMAZON, `[channel-api] ${c.label}: no keys in .env, not started`);
      continue;
    }
    const loop = async (): Promise<void> => {
      if (stopped) return;
      running.add(c.key);
      // the page's schedule (Channel Pulls), else the connector's default; read before each wait so a change applies
      let wait = (await pollMinutesOf(c)) * 60_000;
      try {
        if (!AppDataSource.isInitialized) throw new Error('database not connected');
        const tracker = TRACKERS[c.key];
        if (tracker) {
          await runJob(`inbound-${c.key}`, tracker.run).catch(async (err) => {
            await tracker.fail(err).catch(() => undefined);
            logError(LOG_SOURCE.AMAZON, `[inbound] ${c.key}: tracking run failed (the next run asks from the same check point)`, err);
          });
        }
        const { items } = await runJob(`channel-api-${c.key}`, () => runConnector(c, { apply: true, saveCheckpoint: true }));
        // Left at Amazon (PO intake OFF / before the channel's start): listed apart, not counted as taken.
        const left = items.filter((i) => i.result === 'off' || i.result === 'before start');
        const made = items.filter((i) => i.result && !left.includes(i));
        if (tracker) await tracker.after().catch((err) => logError(LOG_SOURCE.AMAZON, '[inbound] linking POs failed (retried next run)', err));
        log.info(LOG_SOURCE.AMAZON, `[channel-api] ${c.key}: ${items.length} changed, ${made.length} taken${made.length ? ` (${made.map((i) => `${i.externalId} ${i.result}${i.saleOrder ? ` ${i.saleOrder}` : ''}`).join(', ')})` : ''}${left.length ? `, ${left.length} left at Amazon (${left.map((i) => `${i.externalId} ${i.result}`).join(', ')})` : ''}`);
      } catch (err) {
        const failures = await recordRunFailure(c, err).catch(() => 1);
        wait = Math.min(wait * 2 ** failures, CHANNEL_API.MAX_BACKOFF_MS);
        logError(LOG_SOURCE.AMAZON, `[channel-api] ${c.key}: run failed (${failures} in a row), next try in ${Math.round(wait / 60_000)} min`, err);
      }
      running.delete(c.key);
      ended.set(c.key, Date.now());
      if (again.delete(c.key)) wait = 0;
      if (!stopped) timers.set(c.key, setTimeout(() => void loop(), wait));
    };
    loops.set(c.key, loop);
    log.info(LOG_SOURCE.AMAZON, `[channel-api] ${c.label}: polling every ${c.pollMinutes()} min`);
    void loop();
  }
  return {
    stop: () => {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
    },
  };
};
