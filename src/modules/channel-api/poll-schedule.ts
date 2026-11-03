import { AppDataSource } from '../../config/data-source';
import { CHANNEL_PULLS } from '../../constants';
import { AppState } from '../../entities';
import { ChannelConnector } from './connector';

/*
 * How often an API connector polls (Channel Pulls, 2026-10-30, user: "the same for Amazon: every hour or something"):
 * set on the page, kept in app_state ("channel-pull:<key>:poll"); null = the connector's own default (its env value, e.g.
 * AMAZON_POLL_MINUTES, else its constant). Read by the scheduler before each wait, so a change applies at once.
 */

export interface PollSchedule {
  /** Every this many hours (1-24); null = the default. */
  everyHours: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

const repo = () => AppDataSource.getRepository(AppState);

export const pollScheduleOf = async (key: string): Promise<PollSchedule> =>
  ((await repo().findOneBy({ key: CHANNEL_PULLS.POLL_KEY(key) }))?.value as PollSchedule | undefined)
    ?? { everyHours: null, updatedBy: null, updatedAt: null };

export const savePollSchedule = async (key: string, everyHours: number | null, by: string): Promise<PollSchedule> => {
  const value: PollSchedule = { everyHours, updatedBy: by, updatedAt: new Date().toISOString() };
  await repo().save({ key: CHANNEL_PULLS.POLL_KEY(key), value: { ...value }, updatedAt: new Date() });
  return value;
};

/** Minutes between this connector's runs now: the page's choice, else its default. Never fails (the default then). */
export const pollMinutesOf = async (c: ChannelConnector): Promise<number> => {
  const s = await pollScheduleOf(c.key).catch(() => null);
  return s?.everyHours ? s.everyHours * 60 : c.pollMinutes();
};
