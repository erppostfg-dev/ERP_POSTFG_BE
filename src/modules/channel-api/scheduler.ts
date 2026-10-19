import { AppDataSource } from '../../config/data-source';
import { CHANNEL_API } from '../../constants';
import { recordRunFailure, runConnector } from './runner';
import { CONNECTORS } from './registry';
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
let stopped = false;

export const startChannelApis = (): { stop: () => void } => {
  for (const c of CONNECTORS) {
    if (!c.configured()) {
      log.info(LOG_SOURCE.AMAZON, `[channel-api] ${c.label}: no keys in .env, not started`);
      continue;
    }
    const loop = async (): Promise<void> => {
      if (stopped) return;
      let wait = c.pollMinutes() * 60_000;
      try {
        if (!AppDataSource.isInitialized) throw new Error('database not connected');
        const { items } = await runJob(`channel-api-${c.key}`, () => runConnector(c, { apply: true, saveCheckpoint: true }));
        const made = items.filter((i) => i.result);
        log.info(LOG_SOURCE.AMAZON, `[channel-api] ${c.key}: ${items.length} changed, ${made.length} taken${made.length ? ` (${made.map((i) => `${i.externalId} ${i.result}${i.saleOrder ? ` ${i.saleOrder}` : ''}`).join(', ')})` : ''}`);
      } catch (err) {
        const failures = await recordRunFailure(c, err).catch(() => 1);
        wait = Math.min(wait * 2 ** failures, CHANNEL_API.MAX_BACKOFF_MS);
        logError(LOG_SOURCE.AMAZON, `[channel-api] ${c.key}: run failed (${failures} in a row), next try in ${Math.round(wait / 60_000)} min`, err);
      }
      if (!stopped) timers.set(c.key, setTimeout(() => void loop(), wait));
    };
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
