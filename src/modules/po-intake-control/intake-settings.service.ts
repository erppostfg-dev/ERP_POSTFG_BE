import { Not } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  CHANNEL_MASTER_IDS, CHANNELS, ChannelName, CatchupStatus, ERROR_CODES, IST_OFFSET_MS, PO_INTAKE, UPLOAD_SOURCE, UPLOAD_STATUS,
} from '../../constants';
import { ActivityLog, ChannelIntakeSetting, IntakeCatchup, MasterChannel, MasterPurchaseOrder, PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { channelConfigs } from '../ocr/channels.config';

/*
 * PO intake per channel (user, 2026-10-23; constants/intake.ts): ON / OFF + a limit per day, every channel OFF until
 * someone switches it on. shouldHold() is asked where a PO enters the chain (email: pipeline emailStored; API: the
 * channel-api runner). Today's count = POs of the channel that came in today (India time) by email / API and were not
 * held, read from po_uploads: no counter is stored.
 */

export interface Actor {
  id: number;
  email: string;
}

/** Channels that come by email (a PO reader) or API (Amazon), as constants CHANNELS values. */
const intakeChannels = (): { channel: ChannelName; source: 'email' | 'api' }[] => [
  // A channel with no senders (Nykaa) comes by Manual Upload only, which is never held: no switch for it here.
  ...channelConfigs.filter((c) => c.senders.length).map((c) => ({ channel: c.channel, source: 'email' as const })),
  { channel: CHANNELS.AMAZON, source: 'api' as const },
];

/** po_uploads.channel holds master_channels.display_name. */
const displayNames = async (): Promise<Map<string, string>> => {
  const masters = await AppDataSource.getRepository(MasterChannel).find();
  return new Map(intakeChannels().map(({ channel }) => [channel, masters.find((m) => m.id === CHANNEL_MASTER_IDS[channel])?.displayName ?? channel]));
};

/** Midnight today, India time, as a Date. */
const todayStartIst = (): Date => {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
};

/**
 * POs that took a place today: came in today and were not held, or were held earlier and let go today (released_at).
 * So yesterday's held POs released after midnight use up today's limit too.
 */
const countToday = (displayName: string) => {
  const since = todayStartIst();
  return AppDataSource.getRepository(PoUpload)
    .createQueryBuilder('u')
    .where('u.channel = :displayName AND u.source IN (:...sources) AND u.status <> :held', {
      displayName, sources: [UPLOAD_SOURCE.EMAIL, UPLOAD_SOURCE.API], held: UPLOAD_STATUS.HELD,
    })
    .andWhere('((u.releasedAt IS NULL AND u.createdAt >= :since) OR u.releasedAt >= :since)', { since })
    .getCount();
};

/** Held POs: waiting for their turn, and received before the channel's "process from" (left alone until it moves back). */
const heldCounts = async (displayName: string, from: Date | null): Promise<{ held: number; beforeStart: number }> => {
  const qb = () => AppDataSource.getRepository(PoUpload).createQueryBuilder('u').where('u.channel = :displayName AND u.status = :held', { displayName, held: UPLOAD_STATUS.HELD });
  const all = await qb().getCount();
  const beforeStart = from ? await qb().andWhere('COALESCE(u.emailReceivedAt, u.createdAt) < :from', { from }).getCount() : 0;
  return { held: all - beforeStart, beforeStart };
};

/** The setting row of a channel (null before the IntakeControl migration has run: then nothing is held / skipped). */
const settingOf = async (channel: string): Promise<ChannelIntakeSetting | null | 'no-table'> =>
  AppDataSource.getRepository(ChannelIntakeSetting).findOneBy({ channel }).catch((err: { code?: string }) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return 'no-table' as const;
    throw err;
  });

/** A channel's switch + start as stored (null = no row: OFF, no start). */
export const intakeStateOf = async (channel: string): Promise<{ enabled: boolean; processFrom: Date | null } | null> => {
  const row = await settingOf(channel);
  return row && row !== 'no-table' ? { enabled: row.enabled, processFrom: row.processFrom } : null;
};

/**
 * May a PO of this channel come in AT ALL (user, 2026-10-23: "OFF channels and anything before the date never reach
 * our servers / DB")? 'off' = the channel is OFF (or never switched on), 'before' = received before its start;
 * both stay at the source (Gmail / Amazon). 'take' = stored; over today's limit it then waits as held.
 * Before the IntakeControl migration there is no table: 'take' (the old behaviour).
 */
export const intakeGate = async (channel: string, receivedAt: Date | null): Promise<'take' | 'off' | 'before'> => {
  const row = await settingOf(channel);
  if (row === 'no-table') return 'take';
  if (!row?.enabled) return 'off';
  if (row.processFrom && receivedAt && receivedAt < row.processFrom) return 'before';
  return 'take';
};

export type IntakeGate = (channel: string, receivedAt: Date | null) => 'take' | 'off' | 'before';

/** intakeGate for many emails with ONE query (a Gmail pass, 2026-10-29): the switches as they are now. */
export const intakeGates = async (): Promise<IntakeGate> => {
  const rows = await AppDataSource.getRepository(ChannelIntakeSetting).find({ select: { channel: true, enabled: true, processFrom: true } })
    .catch((err: { code?: string }) => {
      if (err.code === 'ER_NO_SUCH_TABLE') return null;
      throw err;
    });
  if (!rows) return () => 'take';
  const by = new Map(rows.map((r) => [r.channel, r]));
  return (channel, receivedAt) => {
    const row = by.get(channel);
    if (!row?.enabled) return 'off';
    if (row.processFrom && receivedAt && receivedAt < row.processFrom) return 'before';
    return 'take';
  };
};

/** The channel's "process from" time: older POs are not taken at all (emails stay in Gmail). null = no start. */
export const processFromOf = async (channel: string): Promise<Date | null> => {
  const row = await settingOf(channel);
  return row && row !== 'no-table' ? row.processFrom : null;
};

/**
 * Before OCR (2026-10-23, user: "check the PO is in our system before processing, to save OCR cost"): a PO number read
 * from the email subject that POST_FG already has for this channel (a PO upload not failed, or a saved PO).
 */
export const alreadyHavePo = async (channel: string, poNumber: string): Promise<string | null> => {
  const name = (await displayNames()).get(channel) ?? channel;
  const row = await AppDataSource.getRepository(PoUpload).findOne({
    where: { channel: name, poNumber, status: Not(UPLOAD_STATUS.FAILED) }, order: { id: 'DESC' },
  });
  if (row) return `upload ${row.id} (${row.status})`;
  const saved = await AppDataSource.getRepository(MasterPurchaseOrder).findOne({ select: ['uid'], where: { channel: name, poNumber } });
  return saved ? `saved PO ${saved.uid}` : null;
};

/** True = keep this channel's next PO on hold (OFF, never switched on, or today's limit reached). */
export const shouldHold = async (channel: string): Promise<boolean> => {
  // Before the IntakeControl migration has run there is no table: nothing is held (the old behaviour).
  const row = await settingOf(channel);
  if (row === 'no-table') return false;
  if (!row?.enabled) return true;
  if (row.dailyLimit === null) return false;
  const name = (await displayNames()).get(channel) ?? channel;
  return (await countToday(name)) >= row.dailyLimit;
};

/** The channel (CHANNELS value) of a po_uploads.channel display name. */
export const channelOfDisplayName = async (displayName: string | null): Promise<string | null> => {
  if (!displayName) return null;
  for (const [channel, name] of await displayNames()) if (name === displayName) return channel;
  return null;
};

export interface IntakeChannel {
  channel: string;
  name: string;
  source: 'email' | 'api';
  enabled: boolean;
  dailyLimit: number | null;
  processFrom: string | null;
  today: number;
  /** Held, waiting for their turn (ON + room today releases them). */
  held: number;
  /** Held, received before processFrom: not taken unless the date moves back. */
  heldBeforeStart: number;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Email channels: the last Gmail catch-up and how it went (null = never asked). */
  catchUp: CatchUpState | null;
}

export interface CatchUpState {
  status: CatchupStatus;
  from: string;
  /** Failed tries so far, and when it is tried again by itself. */
  attempts: number;
  nextTryAt: string | null;
  lastError: string | null;
  /** Last finished pass: the channel's emails looked at, and how many were newly sent. */
  found: number | null;
  sent: number | null;
  finishedAt: string | null;
}

const catchUpStates = async (): Promise<Map<string, CatchUpState>> => {
  const rows = await AppDataSource.getRepository(IntakeCatchup).find().catch((err: { code?: string }) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return [];
    throw err;
  });
  return new Map(rows.map((r) => [r.channel, {
    status: r.status, from: r.fromAt.toISOString(), attempts: r.attempts, nextTryAt: r.nextTryAt?.toISOString() ?? null,
    lastError: r.lastError, found: r.found, sent: r.sent, finishedAt: r.finishedAt?.toISOString() ?? null,
  }]));
};

export const listIntake = async (): Promise<{ universal: { processFrom: string | null; updatedBy: string | null; updatedAt: string | null }; channels: IntakeChannel[] }> => {
  const [names, rows, catchUps] = await Promise.all([
    displayNames(), AppDataSource.getRepository(ChannelIntakeSetting).find({ relations: { user: true } }), catchUpStates(),
  ]);
  const u = rows.find((x) => x.channel === PO_INTAKE.UNIVERSAL_KEY);
  const out: IntakeChannel[] = [];
  for (const { channel, source } of intakeChannels()) {
    const r = rows.find((x) => x.channel === channel);
    const name = names.get(channel) ?? channel;
    out.push({
      channel, name, source,
      enabled: r?.enabled ?? false,
      dailyLimit: r?.dailyLimit ?? null,
      processFrom: r?.processFrom ? r.processFrom.toISOString() : null,
      today: await countToday(name),
      ...(({ held, beforeStart }) => ({ held, heldBeforeStart: beforeStart }))(await heldCounts(name, r?.processFrom ?? null)),
      updatedBy: r?.user?.name ?? r?.user?.email ?? null,
      updatedAt: r ? r.updatedAt.toISOString() : null,
      catchUp: source === 'email' ? catchUps.get(channel) ?? null : null,
    });
  }
  return {
    universal: { processFrom: u?.processFrom ? u.processFrom.toISOString() : null, updatedBy: u?.user?.name ?? u?.user?.email ?? null, updatedAt: u ? u.updatedAt.toISOString() : null },
    channels: out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)),
  };
};

const audit = (by: Actor, what: string) =>
  AppDataSource.getRepository(ActivityLog).insert({
    userId: by.id, method: 'AUDIT', status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS), path: what.slice(0, 255),
  });

/** The universal "process from": set on EVERY email / API channel (overwrites their own), kept as the "*" row. */
export const setUniversal = async (processFrom: Date | null, by: Actor) => {
  const repo = AppDataSource.getRepository(ChannelIntakeSetting);
  const now = new Date();
  for (const key of [PO_INTAKE.UNIVERSAL_KEY, ...intakeChannels().map((c) => c.channel)]) {
    const row = (await repo.findOneBy({ channel: key })) ?? repo.create({ channel: key, enabled: false, dailyLimit: null });
    await repo.save({ ...row, processFrom, updatedBy: by.id, updatedAt: now });
  }
  await audit(by, `po intake: universal process-from ${processFrom ? processFrom.toISOString() : 'none'} set on every channel`);
  return listIntake();
};

export const updateIntake = async (
  channel: string,
  change: { enabled?: boolean; dailyLimit?: number | null; processFrom?: Date | null },
  by: Actor,
): Promise<IntakeChannel> => {
  if (!intakeChannels().some((c) => c.channel === channel)) throw appError(ERROR_CODES.INTAKE_CHANNEL_NOT_FOUND, channel);
  const repo = AppDataSource.getRepository(ChannelIntakeSetting);
  const row = (await repo.findOneBy({ channel })) ?? repo.create({ channel, enabled: false, dailyLimit: null });
  if (change.enabled !== undefined) row.enabled = change.enabled;
  if (change.dailyLimit !== undefined) row.dailyLimit = change.dailyLimit;
  if (change.processFrom !== undefined) row.processFrom = change.processFrom;
  // Switched on with no start: from now (never the whole history).
  if (row.enabled && !row.processFrom) row.processFrom = new Date();
  await repo.save({ ...row, updatedBy: by.id, updatedAt: new Date() });
  await audit(by, `po intake: ${channel} ${row.enabled ? 'ON' : 'OFF'}, limit ${row.dailyLimit ?? 'none'}, from ${row.processFrom ? row.processFrom.toISOString() : 'start'}`);
  return (await listIntake()).channels.find((c) => c.channel === channel)!;
};
