import { IsNull } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { APP_STATE_KEY, CHANNEL_PULLS, ERROR_CODES, FLIPKART, SOURCE_SYSTEM } from '../../../constants';
import { LOG_SOURCE } from '../../../constants/logging';
import { AppState, ChannelPullItem } from '../../../entities';
import { appError } from '../../../utils/AppError';
import { log } from '../../../utils/logger';
import { runSellerHubJob } from '../../intransit/runs.service';
import { ConsignmentData, ConsignmentHeader, parseBulkConsignments } from './consignments.parse';
import { ConsignmentsRobotResult } from './consignments.robot';
import { flipkartConnector } from './flipkart.connector';

/*
 * One run of the Flipkart consignments robot (2026-10-30), started by Run now or the schedule: the robot reads Seller Hub
 * in the In-transit worker (the shared login, one browser job at a time); here, in the server, what it read is kept:
 *   - each NEW consignment with its CSV -> a channel_pull_items row (+ its Bulk Consignment File row: warehouse, date,
 *     status; none yet = the connector waits for the next run);
 *   - consignments fetched earlier without a status get it from this run's Bulk Consignment File;
 *   - a consignment whose CSV failed is not stored, so the next run fetches it again.
 * The run itself (when, how long, how many, the error, the last log lines) is kept in app_state for the Channel Pulls page.
 * One run at a time in this server; the worker slot also keeps it apart from the In-transit robots.
 */

export interface RobotRun {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  trigger: string;
  /** Consignments the Scheduled list showed / new ones stored / ones that failed (retried next run). */
  listed: number;
  stored: number;
  failed: { id: string; error: string }[];
  /** Earlier consignments that got their warehouse / status from this run's Bulk Consignment File. */
  completed: number;
  error: string | null;
  /** The robot's last log lines. */
  log: string[];
}

const LOG_LINES = 200;
const repo = () => AppDataSource.getRepository(ChannelPullItem);
const stateRepo = () => AppDataSource.getRepository(AppState);

let running: Promise<RobotRun> | null = null;

export const lastRobotRun = async (): Promise<RobotRun | null> =>
  ((await stateRepo().findOneBy({ key: APP_STATE_KEY.FLIPKART_ROBOT }))?.value as RobotRun | undefined) ?? null;

const saveRun = (run: RobotRun) =>
  stateRepo().save({ key: APP_STATE_KEY.FLIPKART_ROBOT, value: run as unknown as Record<string, unknown>, updatedAt: new Date() });

const labelOf = (id: string, h: ConsignmentHeader | null): string =>
  `${id}${h ? ` · ${h.warehouse} · ${h.status}` : ' · not in the Bulk Consignment File yet'}`.slice(0, 300);

// ---- the last Bulk Consignment File (Manual Upload, 2026-10-30) ------------------------------------------------------

interface SavedBulk {
  savedAt: string;
  headers: Record<string, ConsignmentHeader>;
}

/** Keeps the bulk file's rows of the last FLIPKART.BULK_KEEP_DAYS (one small app_state value, replaced each run). */
const saveBulk = async (bulk: Map<string, ConsignmentHeader>, now: Date): Promise<void> => {
  const from = new Date(now.getTime() - FLIPKART.BULK_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const headers: Record<string, ConsignmentHeader> = {};
  for (const [id, h] of bulk) if (!h.createdOn || h.createdOn >= from) headers[id] = h;
  const value: SavedBulk = { savedAt: now.toISOString(), headers };
  await stateRepo().save({ key: APP_STATE_KEY.FLIPKART_BULK, value: { ...value }, updatedAt: now });
};

/** A consignment's row in the robot's last Bulk Consignment File; null when it was not there (or no run yet). */
export const lastBulkHeader = async (id: string): Promise<ConsignmentHeader | null> => {
  const saved = (await stateRepo().findOneBy({ key: APP_STATE_KEY.FLIPKART_BULK }))?.value as SavedBulk | undefined;
  return saved?.headers[id] ?? null;
};

/** What the robot returned -> new rows + earlier rows completed; returns the counts. */
export const storeRobotResult = async (res: ConsignmentsRobotResult, now = new Date()): Promise<{ stored: number; completed: number; failed: { id: string; error: string }[] }> => {
  const bulk = res.bulkCsv ? parseBulkConsignments(res.bulkCsv) : new Map<string, ConsignmentHeader>();
  if (bulk.size) await saveBulk(bulk, now);
  const failed = res.fetched.filter((f) => f.csv === null).map((f) => ({ id: f.id, error: f.error ?? 'no CSV' }));
  const fresh = res.fetched.filter((f): f is typeof f & { csv: string } => f.csv !== null);
  let stored = 0;
  for (const f of fresh) {
    const header = bulk.get(f.id) ?? null;
    const data: ConsignmentData = { row: f.row, header, csv: f.csv };
    // one at a time (a handful per run); one stored meanwhile (the unique key) is skipped, never stored twice
    const saved = await repo().save(repo().create({
      sourceSystem: SOURCE_SYSTEM.FLIPKART_SELLER_HUB, externalId: f.id, status: header?.status || null, warehouse: header?.warehouse || null,
      createdOn: header?.createdOn || null, label: labelOf(f.id, header), data: { ...data }, fetchedAt: now, takenAt: null,
    })).then(() => true, (err: { code?: string }) => {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      return false;
    });
    if (saved) stored++;
  }
  // earlier ones still without a status (the bulk file did not list them then): completed now when it does
  let completed = 0;
  if (bulk.size) {
    const waiting = await repo().findBy({ sourceSystem: SOURCE_SYSTEM.FLIPKART_SELLER_HUB, status: IsNull() });
    for (const w of waiting.filter((x) => bulk.has(x.externalId))) {
      const header = bulk.get(w.externalId)!;
      await repo().save({
        ...w, status: header.status, warehouse: header.warehouse, createdOn: header.createdOn || null, label: labelOf(w.externalId, header),
        data: { ...w.data, header },
      });
      completed++;
    }
  }
  return { stored, completed, failed };
};

const run = async (trigger: string): Promise<RobotRun> => {
  const out: RobotRun = { startedAt: new Date().toISOString(), finishedAt: null, ok: null, trigger, listed: 0, stored: 0, failed: [], completed: 0, error: null, log: [] };
  const line = (l: string) => { out.log.push(l); if (out.log.length > LOG_LINES) out.log.shift(); };
  await saveRun(out);
  try {
    const known = (await repo().find({ select: { externalId: true }, where: { sourceSystem: SOURCE_SYSTEM.FLIPKART_SELLER_HUB } })).map((r) => r.externalId);
    const res = await runSellerHubJob<ConsignmentsRobotResult>(FLIPKART.ROBOT_JOB, (cacheDir) => ({
      kind: FLIPKART.ROBOT_JOB, seller: env.intransit.flipkart.sellerHub, cacheDir, known,
    }), FLIPKART.ROBOT_TIMEOUT_MS, line);
    const saved = await storeRobotResult(res);
    Object.assign(out, { ok: true, listed: res.total, stored: saved.stored, completed: saved.completed, failed: saved.failed });
    if (res.bulkError) line(`Bulk Consignment File: ${res.bulkError} (new consignments wait for the next run)`);
    log.info(LOG_SOURCE.APP, `[flipkart-robot] ${trigger}: ${res.total} listed, ${saved.stored} new, ${saved.failed.length} failed, ${saved.completed} completed`);
  } catch (err) {
    Object.assign(out, { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    log.error(LOG_SOURCE.APP, `[flipkart-robot] ${trigger}: failed (the next run tries again): ${out.error}`);
  }
  out.finishedAt = new Date().toISOString();
  await saveRun(out);
  return out;
};

/** Start a robot run (Run now / the schedule); 409 when one is running or the login is missing. */
export const startRobotRun = (trigger: string): Promise<RobotRun> => {
  if (!flipkartConnector.configured()) throw appError(ERROR_CODES.CHANNEL_PULL_NOT_CONFIGURED, 'The Flipkart Seller Hub robot');
  if (running) throw appError(ERROR_CODES.CHANNEL_PULL_RUNNING, 'The Flipkart Seller Hub robot');
  running = run(trigger).finally(() => { running = null; });
  return running;
};

export const robotRunning = (): boolean => running !== null;

// ---- schedule (Channel Pulls) ------------------------------------------------------------------------------------

export interface RobotSchedule {
  /** Every this many hours (1-24); null = only by Run now. */
  everyHours: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const robotSchedule = async (): Promise<RobotSchedule> =>
  ((await stateRepo().findOneBy({ key: APP_STATE_KEY.FLIPKART_ROBOT_SCHEDULE }))?.value as RobotSchedule | undefined)
    ?? { everyHours: null, updatedBy: null, updatedAt: null };

export const setRobotSchedule = async (everyHours: number | null, by: string): Promise<RobotSchedule> => {
  const value: RobotSchedule = { everyHours, updatedBy: by, updatedAt: new Date().toISOString() };
  await stateRepo().save({ key: APP_STATE_KEY.FLIPKART_ROBOT_SCHEDULE, value: { ...value }, updatedAt: new Date() });
  log.info(LOG_SOURCE.APP, `[flipkart-robot] schedule: ${everyHours ? `every ${everyHours} h` : 'off (Run now only)'} (${by})`);
  return value;
};

/** When the next scheduled run is due (null = no schedule): everyHours after the last run started, or now. */
export const nextRobotRunAt = (schedule: RobotSchedule, last: RobotRun | null): Date | null => {
  if (!schedule.everyHours) return null;
  if (!last) return new Date();
  return new Date(Date.parse(last.startedAt) + schedule.everyHours * 3_600_000);
};

/**
 * The server's look at the schedule (every CHANNEL_PULLS.SCHEDULE_TICK_MS; 2 small reads): a due run starts unless one is
 * running or the login is missing. A run that failed waits for its next turn like any other (no tight retry loop).
 */
export const startRobotSchedule = (): { stop: () => void } => {
  const tick = async () => {
    if (running || !flipkartConnector.configured()) return;
    const due = nextRobotRunAt(await robotSchedule(), await lastRobotRun());
    if (due && due.getTime() <= Date.now()) void startRobotRun('schedule').catch(() => undefined);
  };
  const timer = setInterval(() => void tick().catch((err) => log.error(LOG_SOURCE.APP, `[flipkart-robot] schedule check failed: ${err instanceof Error ? err.message : String(err)}`)), CHANNEL_PULLS.SCHEDULE_TICK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
