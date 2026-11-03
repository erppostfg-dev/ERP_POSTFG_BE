import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { CHANNEL_PULLS, ERROR_CODES, MYNTRA_STR, SOURCE_SYSTEM, TABLES } from '../../constants';
import { ChannelApiSync } from '../../entities';
import { appError } from '../../utils/AppError';
import { intakeStateOf } from '../po-intake-control/intake-settings.service';
import { ChannelConnector } from './connector';
import { lastRobotRun, nextRobotRunAt, robotRunning, robotSchedule, RobotRun, RobotSchedule, startRobotRun } from './flipkart/consignments.service';
import { lastStrRun, startStrRun, strRunning } from './myntra/str.service';
import { CONNECTORS, connectorOf } from './registry';
import { isProcessing } from './scheduler';
import { pollMinutesOf, pollScheduleOf } from './poll-schedule';

/*
 * Channel Pulls page (2026-10-30): every channel pulled by API or robot, what it is doing and what it brought in. Reads
 * only: channel_api_sync (one query), the PO intake switches (one per connector), channel_pull_items counts (one grouped
 * query), the robot's run + schedule (app_state). Actions are in the routes (robot run, process now, schedule).
 */

/**
 * Connectors with a robot fetching for them; the others are pulled by their API. Flipkart's robot runs on its schedule
 * (or Run now); Myntra's STR robot starts when an STR email comes (or Run now: the waiting STRs again), no schedule.
 */
interface Robot {
  lastRun: () => Promise<RobotRun | null>;
  running: () => boolean;
  /** Run now (throws when it cannot start). */
  start: (trigger: string) => void;
  /** null = no schedule (started by its email). */
  schedule: (() => Promise<RobotSchedule>) | null;
  startedBy: 'schedule' | 'email';
  /** Whether Process now / the timer make POs from what it fetched. */
  processes: boolean;
}
const ROBOTS: Record<string, Robot> = {
  [SOURCE_SYSTEM.FLIPKART_SELLER_HUB]: {
    lastRun: lastRobotRun, running: robotRunning, start: (t) => void startRobotRun(t).catch(() => undefined),
    schedule: robotSchedule, startedBy: 'schedule', processes: true,
  },
  [SOURCE_SYSTEM.MYNTRA_STR]: {
    lastRun: lastStrRun, running: strRunning, start: (t) => void startStrRun(t)?.catch(() => undefined),
    schedule: null, startedBy: 'email', processes: MYNTRA_STR.PROCESSING,
  },
};
export const hasRobot = (key: string): boolean => key in ROBOTS;
export const robotOf = (key: string): Robot | undefined => ROBOTS[key];
export const processesPos = (key: string): boolean => ROBOTS[key]?.processes ?? true;

export interface ChannelPullView {
  key: string;
  channel: string;
  label: string;
  /** api = pulled by the channel's API; robot = fetched by our browser robot. */
  kind: 'api' | 'robot';
  /** Its login / keys are set on this server. */
  configured: boolean;
  /** The server polls connectors on their own timer (CHANNEL_API_ENABLED); else only Process now. */
  polling: boolean;
  /** PO intake switch: OFF = nothing taken (it stays at the channel). */
  intake: { enabled: boolean; processFrom: string | null };
  /** A process run is going now. */
  processing: boolean;
  /** The last process run (the connector's check point row). */
  sync: { lastRunAt: string | null; lastSuccessAt: string | null; failures: number; lastError: string | null; lastResult: Record<string, unknown> | null } | null;
  /** Robot channels: the robot's state, last run (without its log) and schedule (null = started by its email). */
  robot: { running: boolean; lastRun: Omit<RobotRun, 'log'> | null; schedule: RobotSchedule | null; nextRunAt: string | null; startedBy: 'schedule' | 'email' } | null;
  /** Process now / the timer make POs from what was fetched (Myntra STRs: not yet, step 2). */
  processes: boolean;
  /** API channels: how often the server pulls (the page's choice, else defaultHours) and when next (null = polling off). */
  poll: { everyHours: number | null; defaultHours: number; updatedBy: string | null; updatedAt: string | null; nextRunAt: string | null } | null;
  /** Robot channels: what it fetched: all, not taken yet, waiting for a status, made into POs. */
  counts: { fetched: number; notTaken: number; waiting: number; taken: number; stored: number; failed: number } | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The run without its log lines (the list stays small; the log has its own endpoint). */
const withoutLog = (r: RobotRun): Omit<RobotRun, 'log'> => {
  const copy: Partial<RobotRun> = { ...r };
  delete copy.log;
  return copy as Omit<RobotRun, 'log'>;
};

const countsBySource = async (): Promise<Map<string, ChannelPullView['counts']>> => {
  const rows = await AppDataSource.query<{ s: string; fetched: string; not_taken: string | null; waiting: string | null; taken: string | null; n_stored: string | null; n_failed: string | null }[]>(
    `SELECT source_system s, COUNT(*) fetched, SUM(taken_at IS NULL) not_taken, SUM(taken_at IS NULL AND status IS NULL) waiting, SUM(taken_at IS NOT NULL) taken,
            SUM(status = ?) n_stored, SUM(status = ?) n_failed
       FROM ${TABLES.CHANNEL_PULL_ITEMS} GROUP BY source_system`,
    [MYNTRA_STR.STATUS.STORED, MYNTRA_STR.STATUS.FAILED],
  );
  return new Map(rows.map((r) => [r.s, {
    fetched: Number(r.fetched), notTaken: Number(r.not_taken ?? 0), waiting: Number(r.waiting ?? 0), taken: Number(r.taken ?? 0),
    stored: Number(r.n_stored ?? 0), failed: Number(r.n_failed ?? 0),
  }]));
};

const viewOf = async (c: ChannelConnector, syncs: ChannelApiSync[], counts: Map<string, ChannelPullView['counts']>): Promise<ChannelPullView> => {
  const s = syncs.find((x) => x.connector === c.key);
  const intake = await intakeStateOf(c.channel);
  let robot: ChannelPullView['robot'] = null;
  const rb = robotOf(c.key);
  if (rb) {
    const [last, schedule] = await Promise.all([rb.lastRun(), rb.schedule ? rb.schedule() : Promise.resolve(null)]);
    robot = { running: rb.running(), lastRun: last ? withoutLog(last) : null, schedule, nextRunAt: schedule ? iso(nextRobotRunAt(schedule, last)) : null, startedBy: rb.startedBy };
  }
  let poll: ChannelPullView['poll'] = null;
  if (!hasRobot(c.key)) {
    const sched = await pollScheduleOf(c.key);
    const minutes = await pollMinutesOf(c);
    const last = s?.lastRunAt ?? null;
    poll = {
      ...sched, defaultHours: Math.round((c.pollMinutes() / 60) * 100) / 100,
      nextRunAt: env.channelApi.enabled && c.configured() ? iso(last ? new Date(last.getTime() + minutes * 60_000) : new Date()) : null,
    };
  }
  return {
    key: c.key,
    channel: c.channel,
    label: c.label,
    kind: hasRobot(c.key) ? 'robot' : 'api',
    configured: c.configured(),
    polling: env.channelApi.enabled,
    intake: { enabled: intake?.enabled ?? false, processFrom: iso(intake?.processFrom) },
    processing: isProcessing(c.key),
    sync: s ? { lastRunAt: iso(s.lastRunAt), lastSuccessAt: iso(s.lastSuccessAt), failures: s.failures ?? 0, lastError: s.lastError ?? null, lastResult: s.lastResult ?? null } : null,
    robot,
    processes: processesPos(c.key),
    poll,
    counts: hasRobot(c.key) ? (counts.get(c.key) ?? { fetched: 0, notTaken: 0, waiting: 0, taken: 0, stored: 0, failed: 0 }) : null,
  };
};

export const listChannelPulls = async (): Promise<ChannelPullView[]> => {
  const [syncs, counts] = await Promise.all([AppDataSource.getRepository(ChannelApiSync).find(), countsBySource()]);
  return Promise.all(CONNECTORS.map((c) => viewOf(c, syncs, counts)));
};

export const channelPull = async (key: string): Promise<ChannelPullView> => {
  const c = connectorOrThrow(key);
  const [syncs, counts] = await Promise.all([AppDataSource.getRepository(ChannelApiSync).find({ where: { connector: c.key } }), countsBySource()]);
  return viewOf(c, syncs, counts);
};

export const connectorOrThrow = (key: string): ChannelConnector => {
  const c = connectorOf(key);
  if (!c) throw appError(ERROR_CODES.CHANNEL_PULL_NOT_FOUND, key);
  return c;
};

export interface PullItemView {
  externalId: string;
  /** The row's short text (Myntra: STR · NON TC P0 · BP). */
  label: string;
  status: string | null;
  /** Why the last try failed (Myntra STRs), or null. */
  error: string | null;
  warehouse: string | null;
  createdOn: string | null;
  fetchedAt: string;
  takenAt: string | null;
  /** The PO it became (newest upload of that id), if any. */
  upload: { id: string; status: string; poNumber: string | null } | null;
}

/** The robot's recent fetches (newest first) with the PO each became; one query. */
export const listPullItems = async (key: string): Promise<PullItemView[]> => {
  const c = connectorOrThrow(key);
  if (!hasRobot(c.key)) return [];
  const rows = await AppDataSource.query<{ external_id: string; label: string; status: string | null; error: string | null; warehouse: string | null; created_on: string | null; fetched_at: Date; taken_at: Date | null; upload_id: string | null; upload_status: string | null; po_number: string | null }[]>(
    `SELECT p.external_id, p.label, p.status, JSON_UNQUOTE(JSON_EXTRACT(p.data, '$.lastError')) error, p.warehouse, DATE_FORMAT(p.created_on, '%Y-%m-%d') created_on, p.fetched_at, p.taken_at, u.id upload_id, u.status upload_status, u.po_number
       FROM ${TABLES.CHANNEL_PULL_ITEMS} p
       LEFT JOIN ${TABLES.PO_UPLOADS} u ON u.id = (SELECT MAX(x.id) FROM ${TABLES.PO_UPLOADS} x WHERE x.source_system = p.source_system AND x.external_id = p.external_id)
      WHERE p.source_system = ? ORDER BY p.id DESC LIMIT ${CHANNEL_PULLS.ITEMS_MAX}`,
    [c.key],
  );
  return rows.map((r) => ({
    externalId: r.external_id, label: r.label, status: r.status, error: r.error && r.error !== 'null' ? r.error : null, warehouse: r.warehouse, createdOn: r.created_on, fetchedAt: r.fetched_at.toISOString(), takenAt: iso(r.taken_at),
    upload: r.upload_id ? { id: String(r.upload_id), status: r.upload_status ?? '', poNumber: r.po_number } : null,
  }));
};

/** The robot's last run with its log lines (the page's "log" view). */
export const robotRunOf = async (key: string): Promise<RobotRun | null> => {
  const c = connectorOrThrow(key);
  const rb = robotOf(c.key);
  if (!rb) throw appError(ERROR_CODES.CHANNEL_PULL_NO_ROBOT, key);
  return rb.lastRun();
};

